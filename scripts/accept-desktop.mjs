// Verify the tarball and menu labels using the actual installed Desktop runtime.
// All sessions, writes and model calls belong to an isolated temporary DSH_HOME.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runInNewContext } from 'node:vm'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const runtime = process.argv[2] || 'D:/DeepSeekHarness/resources/app.asar/dsh'
const cli = join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
const requireRuntime = createRequire(join(runtime, 'package.json'))
const official = name => import(pathToFileURL(requireRuntime.resolve(name)).href)
const temporary = await mkdtemp(join(tmpdir(), 'dsh-codex-independent-'))
const home = join(temporary, 'home')
const profile = 'codex-independent-acceptance'
const tarball = join(root, 'artifacts', 'dsh-codex-auto-approval-0.1.1.tgz')
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY: 'false', ELECTRON_RUN_AS_NODE: '1' }
Object.assign(process.env, { DSH_HOME: home, DSH_TELEMETRY: 'false' })
const evidence = join(root, 'docs', 'evidence')
await mkdir(evidence, { recursive: true })
let shutdown
async function cliRun(args, label) {
  const child = spawn(process.execPath, ['--expose-internals', cli, ...args], { env,
    stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timeout = setTimeout(() => child.kill(), 120_000)
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve)
  })
  clearTimeout(timeout)
  await writeFile(join(evidence, `${label}.log`), stdout + stderr)
  assert.equal(code, 0, `${label}: ${stderr}`)
  return stdout
}
try {
  await cliRun(['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts'], 'desktop-isolated-install')
  const profileDir = join(home, 'profiles', profile)
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dsh.profile.bundles.push('@deepseek-ai/dsh-experimental-auto-review')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const dump = await cliRun(['--profile', profile, '--dump-config'], 'desktop-isolated-config')
  const yaml = requireRuntime('js-yaml')
  const rows = yaml.load(dump, { schema: yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }),
  ]) })
  const required = new Set(['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt',
    'dsh-llm', 'dsh-tools', 'dsh-fs-sandbox', 'dsh-subprocess-local', 'dsh-sandbox-local',
    'dsh-sandbox-policy', 'dsh-pwsh-sandbox', 'dsh-user-approval', 'dsh-agent-loop', 'dsh-permission-presets',
    'dsh-experimental-auto-review', 'dsh-codex-auto-approval', 'dsh-codex-auto-approval/presets'])
  const overlay = rows.map(row => ({ id: row.id,
    disabled: !required.has(row.name?.replace('@deepseek-ai/', '')),
    ...(row.name === '@deepseek-ai/dsh-tools' ? { config: { mode: 'native' } } : {}),
  }))
  const overlayPath = join(temporary, 'test-overlay.yml')
  await writeFile(overlayPath, yaml.dump(overlay))
  const { createLaunchEnvironmentSnapshot } = await official('@deepseek-ai/dsh-launch-environment')
  const { runProfile } = await official('@deepseek-ai/dsh/profile-boot')
  const boot = await runProfile({ profile, args: [], patchFiles: [overlayPath],
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]) })
  shutdown = boot.shutdown
  const ctx = boot.ctx
  const { LlmAdapter, createUserMessage, ToolCallId } = await official('@deepseek-ai/dsh-llm')
  const { defineTool } = await official('@deepseek-ai/dsh-tools')
  const { SessionId } = await official('@deepseek-ai/dsh-session')
  let main = 0, reviews = 0, officialReviews = 0, phase = 'codex'
  const effects = [], decisions = []
  ctx.on('codex-auto-approval/decision', event => { decisions.push(event.outcome) })
  class Model extends LlmAdapter {
    async *stream(options) {
      let block, finish = 'stop'
      if (typeof options.system === 'string' && options.system.includes('You are judging one planned')) {
        block = { type: 'text', text: ++reviews === 1 ? '{"outcome":"deny","rationale":"Isolated rejection"}' : '{"outcome":"allow"}' }
      } else if (typeof options.system === 'string' && options.system.startsWith('REVIEW_POLICY')) {
        officialReviews++; block = { type: 'text', text: '{"risk":"low","decision":"allow"}' }
      } else if (main++ < (phase === 'codex' ? 2 : 1)) {
        block = { type: 'tool-call', id: ToolCallId(`${phase}-${main}`), name: 'artifact_effect',
          arguments: JSON.stringify({ value: phase === 'codex' ? (main === 1 ? 'blocked' : 'codex-approved') : 'official-approved' }) }
        finish = 'tool-calls'
      } else block = { type: 'text', text: 'Done' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text }
      else yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: finish } }
    }
  }
  ctx.llm.registerAdapter(['artifact-test'], new Model())
  ctx.tools.register(defineTool({ name: 'artifact_effect', description: 'Write an isolated acceptance file',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ value }, exec) {
      exec.signal.throwIfAborted(); effects.push(value)
      await writeFile(join(temporary, 'effect.txt'), value); return value
    },
  }))
  const handle = await ctx.agents.create({ sessionId: SessionId('codex-acceptance'),
    meta: { cwd: temporary }, agentOptions: { provider: 'artifact-test', model: 'deterministic' } })
  assert.equal(ctx.permissionPresets.current(handle.agent.session), 'codex-auto-approval')
  const followup = async agent => {
    agent.followup(createUserMessage({ source: { kind: 'user', rpcId: `${phase}-request` },
      content: [{ type: 'text', text: 'Write only the approved isolated acceptance result.' }] }))
    await agent.whenIdle()
  }
  await followup(handle.agent)
  assert.deepEqual(effects, ['codex-approved'])
  assert.deepEqual(decisions, ['deny', 'allow'])
  assert.equal(officialReviews, 0)
  phase = 'official'; main = 0
  const nativeHandle = await ctx.agents.create({ sessionId: SessionId('official-acceptance'),
    meta: { cwd: temporary }, agentOptions: { provider: 'artifact-test', model: 'deterministic' } })
  ctx.permissionPresets.set(nativeHandle.agent.session, 'auto')
  await followup(nativeHandle.agent)
  assert.equal(officialReviews, 1)
  assert.equal(reviews, 2)
  assert.deepEqual(effects, ['codex-approved', 'official-approved'])
  const catalog = ctx.permissionPresets.catalog()
  const client = await readFile(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-client-ui-permission-presets', 'lib', 'client.js'), 'utf8')
  const labelSource = client.match(/function permissionLabel\(value, name, t\) \{[\s\S]*?\n\t\t\}/)?.[0]
  const badgeSource = client.match(/function optionBadge\(value, t\) \{[\s\S]*?\n\t\t\}/)?.[0]
  assert.ok(labelSource); assert.ok(badgeSource)
  const label = runInNewContext(`(${labelSource})`, { displayPermissionPreset: (_value, name) => name })
  const badge = runInNewContext(`(${badgeSource})`)
  const t = key => ({ 'auto.label': 'Auto review', 'auto.badge': 'EXP' })[key]
  const menu = catalog.options.map(option => ({ value: option.value, label: label(option.value, option.name, t), badge: badge(option.value, t) }))
  assert.ok(menu.some(x => x.value === 'auto' && x.label === 'Auto review' && x.badge === 'EXP'))
  assert.ok(menu.some(x => x.value === 'codex-auto-approval' && x.label === 'CodexAutoApproval' && x.badge === undefined))
  const entry = [...ctx.loader.entries()].find(x => x.options.name === 'dsh-codex-auto-approval')
  await entry.fiber.dispose()
  assert.ok(ctx.permissionPresets.names.includes('auto'))
  assert.ok(!ctx.permissionPresets.names.includes('codex-auto-approval'))
  assert.equal(ctx.permissionPresets.current(nativeHandle.agent.session), 'auto')
  assert.equal(ctx.permissionPresets.current(handle.agent.session), 'workspace-write')
  await handle.dispose(); await nativeHandle.dispose()
  await shutdown.shutdown(0); shutdown = undefined
  await cliRun(['plugin', '--profile', profile, 'remove', 'dsh-codex-auto-approval'], 'desktop-isolated-remove')
  const removed = await cliRun(['--profile', profile, '--dump-config'], 'desktop-isolated-after-remove')
  assert.ok(!removed.includes('name: dsh-codex-auto-approval'))
  assert.ok(removed.includes('@deepseek-ai/dsh-experimental-auto-review'))
  const result = { dsh: '0.2.0-rc.2', node: process.version, platform: process.platform,
    runtime, menu, effects, decisions, codexReviews: reviews, officialReviews,
    independentUnload: true, officialRemainsAfterRemove: true,
    model: 'deterministic adapter; no external model calls', graphicalScreenshot: false }
  await writeFile(join(evidence, 'desktop-independent-result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result, null, 2))
  console.log('DESKTOP INDEPENDENT PRESETS VERIFICATION PASSED')
} finally {
  if (shutdown) await shutdown.shutdown(1)
  await rm(temporary, { recursive: true, force: true })
}
