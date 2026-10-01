import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { PreToolDecision, ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import { rejectionText, ReviewError, type Assessment } from './assessment.js'
import { abortable, ReviewSlots } from './concurrency.js'
import { Config, validateConfig } from './config.js'
import { ContextMemory } from './context.js'
import { DenialWindow } from './denials.js'
import { review } from './reviewer.js'
import { snapshotAutoReview } from './snapshot.js'
import { CODEX_PRESET, registerCodexPreset } from './presets.js'

export { Config }
export { CODEX_PRESET } from './presets.js'
export const name = 'dsh-codex-auto-approval'
export const inject = ['permissionPresets', 'approval', 'sessions', 'tools', 'llm', 'fs', 'agents']

export interface ReviewDecisionEvent {
  sessionId: string
  callId: string
  toolName: string
  outcome: 'allow' | 'deny' | 'human' | 'cancel'
  assessment?: Readonly<Assessment>
  failureCode?: string
  elapsedMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Observation only; never contains tool arguments or the private review transcript. */
    'codex-auto-approval/decision'(event: Readonly<ReviewDecisionEvent>): void
  }
}

interface State { epoch: number; memory: ContextMemory; denials: DenialWindow }
interface Grant { agent: Agent; epoch: number; signal: AbortSignal }

/** Auto's owner may withdraw its catalog before dependent cleanup begins. */
function loggedCodexSelected(session: Session): boolean {
  let preset: string | undefined, sandbox: string | undefined, approval: string | undefined
  for (const event of session.snapshotEvents()) {
    if (event.type === 'permission/preset') preset = event.data.preset
    if (event.type === 'sandbox/mode') sandbox = event.data.mode
    if (event.type === 'approval/policy') approval = event.data.policy
  }
  return preset === CODEX_PRESET && sandbox === 'danger-full-access' && ['ask', 'never'].includes(approval ?? '')
}

/** Installs a private Guardian reviewer, and makes fresh root sessions Auto. */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  const presets = ctx.permissionPresets
  const sessions = ctx.sessions
  const lifecycle = new AbortController()
  const active = new Set<Promise<void>>()
  const states = new WeakMap<Agent, State>()
  const fallback = new WeakMap<Session, string>()
  const fallbackSpecs = new WeakMap<Session, PresetSpec>()
  const initialDefault = { name: presets.defaultPreset, spec: { ...presets.resolve(presets.defaultPreset) } }
  const grants = new Map<ToolExecutionToken, Grant>()
  const slots = new ReviewSlots(config.maxConcurrentReviews)
  let accepting = true
  const stateOf = (agent: Agent): State => {
    let state = states.get(agent)
    if (!state) {
      state = { epoch: 0, memory: new ContextMemory(config), denials: new DenialWindow(config) }
      states.set(agent, state)
    }
    return state
  }
  const rememberPreset = (session: Session): void => {
    const current = presets.current(session)
    if (current !== CODEX_PRESET && presets.names.includes(current)) {
      fallback.set(session, current)
      fallbackSpecs.set(session, { ...presets.resolve(current) })
    }
  }
  for (const session of sessions.list()) rememberPreset(session)

  const observe = (exec: ToolExecution, outcome: ReviewDecisionEvent['outcome'], start: number,
    assessment?: Assessment, failureCode?: string): void => {
    if (!accepting) return
    const event = Object.freeze({ sessionId: String(exec.agent!.session.id), callId: String(exec.callId),
      toolName: exec.name, outcome, assessment: assessment ? Object.freeze({ ...assessment }) : undefined,
      failureCode, elapsedMs: Date.now() - start })
    // Audit observers cannot change the approval outcome or leak a grant.
    try {
      for (const listener of ctx.events.dispatch('emit', ['codex-auto-approval/decision', event])) {
        try { void Promise.resolve(listener(event)).catch(() => {}) } catch {}
      }
    } catch {}
  }

  ctx.effect(function* () {
    // DSH 0.2.0-rc.2 captures only official Auto/Full access identities. Capture
    // our identity synchronously at delegation, then pin it inside child setup.
    yield ctx.effect(() => {
      const registry = ctx.agents
      const original = registry.create
      const create: typeof original = function (this: typeof registry, options) {
        if (!options.parentAgent || presets.current(options.parentAgent.session) !== CODEX_PRESET) {
          return original.call(this, options)
        }
        return original.call(this, { ...options, setup: async (childCtx, agent) => {
          const commit = await options.setup?.(childCtx, agent)
          agent.session.append('permission/preset', { preset: CODEX_PRESET })
          return commit
        } })
      }
      registry.create = create
      return () => { if (registry.create === create) registry.create = original }
    }, 'Codex delegation identity')
    yield ctx.on('session/created', session => { rememberPreset(session) })
    yield ctx.on('agent/created', ({ agent, source }) => {
      rememberPreset(agent.session)
      if (accepting && config.autoEnableNewSessions && source === 'startup'
        && !agent.session.header.isSeeded && agent.session.header.origin !== 'subagent'
        && agent.session.header.parentSession === undefined) {
        presets.set(agent.session, CODEX_PRESET)
      }
      return undefined
    })
    yield ctx.on('session/event', (session, event) => {
      if (['permission/preset', 'sandbox/mode', 'approval/policy'].includes(event.type)) rememberPreset(session)
      const agent = ctx.agents.get(session.id)
      if (!agent) return
      if (['permission/preset', 'sandbox/mode', 'approval/policy', 'user/message'].includes(event.type)) {
        stateOf(agent).epoch++
      }
      if (event.type === 'turn/start') stateOf(agent).denials = new DenialWindow(config)
    })
    yield ctx.on('agent/inbox/inserted', ({ agent }) => { stateOf(agent).epoch++ })
    yield ctx.on('agent/disposed', ({ agent }) => { states.delete(agent) })

    yield ctx.tools.guard(exec => {
      if (!exec.agent) return
      const grant = grants.get(exec.token)
      const auto = presets.current(exec.agent.session) === CODEX_PRESET
      if (!grant && !auto) return
      if (!accepting || !auto || !grant || grant.signal.aborted || grant.epoch !== stateOf(exec.agent).epoch) {
        return 'Codex Auto approval is absent, cancelled, or stale; submit this action again with the current instructions.'
      }
    })
    yield ctx.on('tools/result', exec => { grants.delete(exec.token); return undefined })

    yield ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      const agent = exec.agent
      if (!agent || presets.current(agent.session) !== CODEX_PRESET) return next()
      if (!accepting || lifecycle.signal.aborted) return { kind: 'cancel' }
      const complete = Promise.withResolvers<void>()
      active.add(complete.promise)
      const start = Date.now()
      const state = stateOf(agent)
      const epoch = state.epoch
      const callerSignal = AbortSignal.any([exec.signal, lifecycle.signal])
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(new ReviewError('Review timed out', 'TIMEOUT')), config.reviewTimeoutMs)
      const reviewSignal = AbortSignal.any([callerSignal, deadline.signal])
      let release: (() => void) | undefined
      const current = (): boolean => accepting && !callerSignal.aborted
        && presets.current(agent.session) === CODEX_PRESET && state.epoch === epoch
      const admit = async (): Promise<PreToolDecision> => {
        if (!current()) return { kind: 'cancel' }
        let downstream: PreToolDecision
        try { downstream = await abortable(next(), callerSignal) }
        catch (error) { if (callerSignal.aborted) return { kind: 'cancel' }; throw error }
        if (!current()) return { kind: 'cancel' }
        if (downstream.kind === 'allow' || downstream.kind === 'ask') grants.set(exec.token, { agent, epoch, signal: callerSignal })
        return downstream
      }
      try {
        let assessment: Assessment
        try {
          release = await slots.acquire(reviewSignal)
          let snapshot
          try { snapshot = snapshotAutoReview(agent, exec) }
          catch { throw new ReviewError('Pending action cannot be bound to its immutable session record', 'SNAPSHOT_INVALID') }
          const input = state.memory.render(snapshot, agent)
          assessment = await review(ctx, snapshot, input, reviewSignal, config)
        } catch (error) {
          deadline.abort(error)
          if (!current()) { observe(exec, 'cancel', start); return { kind: 'cancel' } }
          // Technical failure alone goes to the audited human approval service.
          // A policy denial never enters this path.
          const code = error instanceof ReviewError ? error.code : 'REVIEW_FAILURE'
          if (code === 'SNAPSHOT_INVALID') {
            observe(exec, 'deny', start, undefined, code)
            return { kind: 'deny', reason: 'Codex Auto cannot bind this action to its session record. Its body was not executed; submit a fresh, correctly logged call.' }
          }
          observe(exec, 'human', start, undefined, code)
          clearTimeout(timer)
          release?.(); release = undefined
          const reason = `Codex Auto could not review this action (${code}). Decide this exact call manually.`
          const outcome = await ctx.approval.request({ agent, toolName: exec.name, callId: exec.callId,
            reason, displayReason: { en: reason, zh: `自动审批未完成（${code}），请人工判断此操作。` }, signal: callerSignal })
          if (!current() || outcome === 'cancelled') return { kind: 'cancel' }
          if (outcome === 'allowed-once') return admit()
          return { kind: 'deny', reason: `${reason} Human approval: ${outcome}; the tool body was not executed.` }
        }
        clearTimeout(timer)
        release?.(); release = undefined
        if (!current()) { observe(exec, 'cancel', start); return { kind: 'cancel' } }
        observe(exec, assessment.outcome, start, assessment)
        const stop = state.denials.record(assessment.outcome === 'deny')
        if (assessment.outcome === 'allow') return admit()
        const reason = rejectionText(exec.name, assessment)
        if (exec.parent !== undefined) {
          // run_code may catch the inner error. This fact enters the next main
          // model step independently of the program's returned value.
          agent.inject(createUserMessage({ source: { kind: 'tool', callId: exec.rootCallId },
            content: [{ type: 'text', text: reason }] }))
        }
        if (stop) agent.cancel({ kind: 'hook', reason: 'Codex Auto stopped this turn after repeated policy denials.' }, { keepInbox: true })
        return { kind: 'deny', reason, info: { name: 'CodexAutoReviewDenied', code: 'CODEX_AUTO_DENIED', reason: assessment.rationale } }
      } finally {
        clearTimeout(timer)
        release?.()
        active.delete(complete.promise)
        complete.resolve()
      }
    }, { prepend: true })

    yield registerCodexPreset(ctx, () => {
      if (!accepting) throw new Error('Codex Auto is closing')
    })
    // This generator releases in reverse order, serially. Keep Auto and its
    // final guard installed while aborting/draining, then restore before removal.
    yield async () => {
      accepting = false
      lifecycle.abort(new Error('Codex Auto disposed'))
      await Promise.allSettled([...active])
      grants.clear()
      for (const session of sessions.list()) {
        if (!loggedCodexSelected(session)) continue
        let target = fallback.get(session) ?? initialDefault.name
        let spec = fallbackSpecs.get(session) ?? initialDefault.spec
        try {
          if (!presets.names.includes(target)) target = presets.defaultPreset
          spec = { ...presets.resolve(target) }
          presets.set(session, target)
        } catch {
          // A removed provider cannot resolve current() through vanished
          // dependencies. The captured bundle still uses canonical knob setters.
          session.append('permission/preset', { preset: target })
          setSandboxMode(session, spec.sandbox)
          setApprovalPolicy(session, spec.approval)
        }
      }
    }
  }, 'Codex Auto lifetime')
}
