import Loader from '@deepseek-ai/cordis-plugin-loader'
import { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const cliRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const baseRequire = createRequire(cliRequire.resolve('@deepseek-ai/dsh-base/package.json'))
// Match Loader's physical Cordis copy, as the production profile resolver does.
const loaderRequire = createRequire(import.meta.resolve('@deepseek-ai/cordis-plugin-loader'))
export const { Context } = await import(pathToFileURL(loaderRequire.resolve('@deepseek-ai/cordis')).href)
export async function official(name) {
  let path
  try { path = cliRequire.resolve(name) } catch { path = baseRequire.resolve(name) }
  return import(pathToFileURL(path).href)
}

export async function* response(blocks, finish = 'stop') {
  for (const [index, block] of blocks.entries()) {
    yield { type: 'block-start', index, blockType: block.type }
    if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
    if (block.type === 'tool-call') yield { type: 'tool-call-delta', index, id: block.id,
      name: block.name, argumentsDelta: block.arguments }
    yield { type: 'block-end', index, block }
  }
  yield { type: 'finish', reason: { kind: finish } }
}
export const text = text => response([{ type: 'text', text }])
export const tool = (name, args, id = randomUUID()) => response([
  { type: 'tool-call', name, arguments: JSON.stringify(args), id: ToolCallId(id) },
], 'tool-calls')
export const human = text => createUserMessage({ source: { kind: 'user', rpcId: randomUUID() },
  content: [{ type: 'text', text }] })
export const allow = () => text('{"outcome":"allow"}')
export const deny = reason => text(JSON.stringify({ outcome: 'deny', risk_level: 'high',
  user_authorization: 'low', rationale: reason }))
export const isReview = options => typeof options.system === 'string'
  && options.system.includes('You are judging one planned coding-agent action.')

export async function harness(t, route, { config = {}, ptc = false, plugin, specifier,
  baseUrl = import.meta.url } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-codex-test-'))
  const ctx = new Context()
  if (process.env.DSH_TEST_DEBUG) ctx.logger.exporter({ export: message => console.error(message.type, message.args) })
  // Dependencies, session log, scheduling, gate, approvals, FS and PTC are real.
  // Only the remote model is replaced by a deterministic adapter.
  const owned = []
  t.after(async () => { await ctx.fiber.dispose(); await rm(cwd, { recursive: true, force: true }) })
  const core = [
    ['@deepseek-ai/dsh-session-projection', {}], ['@deepseek-ai/dsh-session', {}],
    ['@deepseek-ai/dsh-agent', {}], ['@deepseek-ai/dsh-system-prompt', {}],
    ['@deepseek-ai/dsh-llm', {}], ['@deepseek-ai/dsh-tools', { mode: ptc ? 'ptc' : 'native' }],
    ['@deepseek-ai/dsh-fs-local', { cwd }], ['@deepseek-ai/dsh-subprocess-local', {}],
    ['@deepseek-ai/dsh-sandbox-local', {}], ['@deepseek-ai/dsh-sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd }],
    ['@deepseek-ai/dsh-bash-sandbox', {}], ['@deepseek-ai/dsh-user-approval', { policy: 'ask' }],
    ['@deepseek-ai/dsh-permission-presets', {}],
  ]
  if (ptc) core.push(['@deepseek-ai/dsh-ptc-runtime-node', {}])
  for (const [name, config] of core) {
    if (process.env.DSH_TEST_DEBUG) console.error('Mount', name)
    const module = await official(name)
    owned.push(ctx.plugin(module.default ?? module, config))
  }
  for (const fiber of owned) {
    if (process.env.DSH_TEST_DEBUG) console.error('Wait', fiber.runtime.name, fiber.state)
    await fiber.await()
  }
  if (process.env.DSH_TEST_DEBUG) console.error('Core ready')
  class Model extends LlmAdapter { stream(options) { return route(options, ctx, cwd) } }
  ctx.llm.registerAdapter(['test'], new Model())
  const loop = await official('@deepseek-ai/dsh-agent-loop')
  const loopFiber = ctx.plugin(loop.default, {})
  await loopFiber.await()
  await ctx.plugin(Loader, { baseUrl })
  const loader = ctx.loader
  if (!specifier) loader.builtins.auto = plugin ?? await import('../src/index.ts')
  const entryId = await loader.create({ name: specifier ?? 'cordis:auto', config })
  await loader.await()
  const entry = loader.resolve(entryId)
  await entry.fiber.await()
  if (process.env.DSH_TEST_DEBUG) console.error('Auto ready')
  const effects = []
  ctx.tools.register(defineTool({ name: 'record_effect', description: 'Record a local test effect.',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ value }, exec) {
      exec.signal.throwIfAborted()
      effects.push(value)
      await writeFile(join(cwd, 'effect.txt'), value)
      return value
    },
  }))
  const makeAgent = async (options = {}) => {
    const handle = await ctx.agents.create({ sessionId: SessionId(randomUUID()),
      meta: { cwd, ...options.meta }, agentOptions: { provider: 'test', model: 'test-model' }, ...options })
    return handle.agent
  }
  const agent = await makeAgent()
  return { ctx, cwd, agent, effects, loader, entry, makeAgent, owned,
    async run(input = 'Perform the requested local test effect.', target = agent) {
      target.followup(human(input)); await target.whenIdle()
    },
    async effectFile() { try { return await readFile(join(cwd, 'effect.txt'), 'utf8') } catch { return undefined } },
  }
}
