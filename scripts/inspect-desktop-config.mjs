import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { writeFile } from 'node:fs/promises'

const runtime = 'D:/DeepSeekHarness/resources/app.asar/dsh'
const installAnchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const requireRuntime = createRequire(installAnchor)
const { loadProfileDirectory, composeEntries } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-app-boot')).href)
const profile = loadProfileDirectory('dsh', 'C:/Users/18993/.dsh/profiles/desktop', installAnchor)
assert.deepEqual(profile.skippedBundles, [])
const warnings = []
const rows = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches], message => warnings.push(message))
assert.deepEqual(warnings, [])
const selected = rows.filter(row => ['permission', 'auto-review', 'codex-auto-approval'].includes(row.id))
assert.ok(selected.some(row => row.id === 'auto-review' && row.name === '@deepseek-ai/dsh-experimental-auto-review' && row.disabled !== true))
assert.ok(selected.some(row => row.id === 'codex-auto-approval' && row.name === 'dsh-codex-auto-approval' && row.disabled !== true))
assert.ok(selected.some(row => row.id === 'permission' && row.name === '@deepseek-ai/dsh-permission-presets'))
const result = { profile: profile.dir, bundles: profile.layers.map(layer => layer.packageName),
  skippedBundles: profile.skippedBundles, warnings,
  plugins: selected.map(({ id, name, disabled }) => ({ id, name, disabled: disabled === true })),
  inspection: 'read-only; native Desktop profile composer; no session or server boot' }
const root = dirname(dirname(fileURLToPath(import.meta.url)))
await writeFile(join(root, 'docs', 'evidence', 'desktop-final-config-result.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
