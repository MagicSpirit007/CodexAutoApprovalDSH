import type { Context } from '@deepseek-ai/cordis'
import { PermissionPresetService, type KnobState, type PresetSpec } from '@deepseek-ai/dsh-permission-presets'

export const CODEX_PRESET = 'codex-auto-approval'
const SPEC: Readonly<PresetSpec> = Object.freeze({
  sandbox: 'danger-full-access', approval: 'ask', name: 'CodexAutoApproval',
  description: 'Codex Guardian reviews each operation; policy denials return to the agent, and review failures request human approval.',
})

/** rc.2 has no custom integration API. Extend only catalog/resolve/derive for
 * one identity, preserving the actual native service and restoring descriptors
 * on unload. derive is a runtime method marked private in native declarations. */
export function registerCodexPreset(ctx: Context, admit: () => void): () => Promise<void> {
  const presets = ctx.permissionPresets
  const names = Object.getOwnPropertyDescriptor(PermissionPresetService.prototype, 'names')?.get
  const derive = Reflect.get(presets, 'derive') as (state: KnobState) => string
  const resolve = presets.resolve
  if (!names || typeof derive !== 'function' || presets.names.includes(CODEX_PRESET)) {
    throw new Error('CodexAutoApproval requires the supported DSH 0.2.0-rc.2 permission service')
  }
  const notify = (): void => {
    for (const listener of ctx.events.dispatch('emit', ['permission-presets/catalog-changed'])) {
      try { void Promise.resolve(listener()).catch(() => {}) } catch {}
    }
  }
  return ctx.effect(() => {
    const previous = new Map(['names', 'resolve', 'derive'].map(key =>
      [key, Object.getOwnPropertyDescriptor(presets, key)] as const))
    let live = true
    Object.defineProperties(presets, {
      names: { configurable: true, get() { return [...names.call(this), CODEX_PRESET] } },
      resolve: { configurable: true, writable: true, value(name: string): PresetSpec {
        if (name !== CODEX_PRESET) return resolve.call(this, name)
        if (!live) throw new Error('CodexAutoApproval is not active')
        admit()
        return SPEC
      } },
      derive: { configurable: true, writable: true, value(state: KnobState): string {
        if (live && state.preset === CODEX_PRESET && state.sandbox === SPEC.sandbox
          && (state.approval === 'ask' || state.approval === 'never')) return CODEX_PRESET
        return derive.call(this, state)
      } },
    })
    notify()
    return () => {
      live = false
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(presets, key, descriptor)
        else Reflect.deleteProperty(presets, key)
      }
      notify()
    }
  }, 'CodexAutoApproval preset')
}
