// Installs the actual tarball with the official CLI, then boots the installed
// profile through the official runtime resolver. Only the model is replaced.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { mkdir, mkdtemp, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const cliRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh/package.json'))
const cli = cliRequire.resolve('@deepseek-ai/dsh/lib/bin.js')
const yaml = cliRequire('js-yaml')
const temporary = await mkdtemp(join(tmpdir(), 'dsh-codex-package-'))
const home = join(temporary, 'home')
const evidence = join(root, 'docs', 'evidence')
await mkdir(evidence, { recursive: true })
const env = { ...process.env, DSH_HOME: home, DSH_TELEMETRY: 'false' }
const store = process.env.DSH_TEST_STORE ?? join(tmpdir(), 'dsh-auto-approval-pnpm-store')
const bundledPnpm = '/mnt/d/DeepSeekHarness/resources/runtime/pnpm/bin/pnpm.cjs'
const pnpm = process.env.DSH_TEST_PNPM ?? (existsSync(bundledPnpm) ? bundledPnpm : undefined)
if (process.platform !== 'win32' && pnpm) {
  // The supplied pnpm distribution is portable; do not use Windows PATH shims
  // when running Linux Node from WSL. The caller can supply another executable.
  const bin = join(temporary, 'bin')
  await mkdir(bin)
  const quote = text => "'" + text.replaceAll("'", "'\\''") + "'"
  await writeFile(join(bin, 'pnpm'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(pnpm)} "$@"\n`)
  await chmod(join(bin, 'pnpm'), 0o755)
  env.PATH = bin + ':' + env.PATH
}
Object.assign(process.env, { DSH_HOME: home, DSH_TELEMETRY: 'false' })
const commands = []
async function cliRun(args, label) {
  commands.push([process.execPath, cli, ...args])
  const child = spawn(process.execPath, [cli, ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data })
  child.stderr.on('data', data => { stderr += data })
  const timer = setTimeout(() => child.kill('SIGTERM'), 120_000)
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  clearTimeout(timer)
  await writeFile(join(evidence, `${label}.log`), stdout + stderr)
  assert.equal(code, 0, `${label}: ${stderr}`)
  return stdout
}
const profile = 'codex-auto-artifact-test'
const tarball = resolve(process.argv[2] ?? join(root, 'artifacts/dsh-codex-auto-approval-0.1.0.tgz'))
let shutdown
try {
  await cliRun(['plugin', '--profile', profile, 'add', tarball, '--ignore-scripts',
    '--store-dir', store], 'package-install')
  const dump = await cliRun(['--profile', profile, '--dump-config'], 'profile-config')
  assert.match(dump, /name: dsh-codex-auto-approval/)
  const rows = yaml.load(dump, { schema: yaml.DEFAULT_SCHEMA.extend([
    new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }),
  ]) })
  const required = new Set(['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-system-prompt',
    'dsh-llm', 'dsh-tools', 'dsh-fs-sandbox', 'dsh-subprocess-local', 'dsh-sandbox-local',
    'dsh-sandbox-policy', 'dsh-bash-sandbox', 'dsh-user-approval', 'dsh-permission-presets', 'dsh-agent-loop'])
  const overlay = rows.map(row => ({ id: row.id,
    disabled: row.name !== 'dsh-codex-auto-approval' && !required.has(row.name?.replace('@deepseek-ai/', '')),
    ...(row.name === '@deepseek-ai/dsh-tools' ? { config: { mode: 'native' } } : {}),
  }))
  const overlayPath = join(temporary, 'test-overlay.yml')
  await writeFile(overlayPath, yaml.dump(overlay))
  const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-launch-environment')).href)
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
  const boot = await runProfile({ profile, args: [], patchFiles: [overlayPath],
    environment: createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]) })
  const ctx = boot.ctx
  shutdown = boot.shutdown
  const { LlmAdapter, createUserMessage, ToolCallId } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-llm')).href)
  const { defineTool } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-tools')).href)
  const { SessionId } = await import(pathToFileURL(cliRequire.resolve('@deepseek-ai/dsh-session')).href)
  let main = 0, reviews = 0
  const effects = []
  const decisions = []
  ctx.on('codex-auto-approval/decision', event => { decisions.push(event) })
  class Model extends LlmAdapter {
    async *stream(options) {
      let block, finish = 'stop'
      if (typeof options.system === 'string' && options.system.includes('You are judging one planned')) {
        block = { type: 'text', text: ++reviews === 1 ?
          '{"outcome":"deny","rationale":"Artifact policy rejected the first operation"}' : '{"outcome":"allow"}' }
      } else if (main++ < 2) {
        block = { type: 'tool-call', id: ToolCallId(`artifact-${main}`), name: 'artifact_effect',
          arguments: JSON.stringify({ value: main === 1 ? 'blocked' : 'approved' }) }
        finish = 'tool-calls'
      } else block = { type: 'text', text: 'Completed the approved operation' }
      yield { type: 'block-start', index: 0, blockType: block.type }
      if (block.type === 'text') yield { type: 'text-delta', index: 0, text: block.text }
      else yield { type: 'tool-call-delta', index: 0, id: block.id, name: block.name, argumentsDelta: block.arguments }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'finish', reason: { kind: finish } }
    }
  }
  ctx.llm.registerAdapter(['artifact-test'], new Model())
  ctx.tools.register(defineTool({ name: 'artifact_effect', description: 'Write one isolated acceptance file',
    parameters: { value: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute({ value }, exec) {
      exec.signal.throwIfAborted(); effects.push(value)
      await writeFile(join(temporary, 'effect.txt'), value)
      return value
    },
  }))
  const handle = await ctx.agents.create({ sessionId: SessionId('artifact-session'),
    meta: { cwd: temporary }, agentOptions: { provider: 'artifact-test', model: 'deterministic' } })
  const agent = handle.agent
  assert.equal(ctx.permissionPresets.current(agent.session), 'auto')
  agent.followup(createUserMessage({ source: { kind: 'user', rpcId: 'artifact-user-request' },
    content: [{ type: 'text', text: 'Write only the approved local acceptance result.' }] }))
  await agent.whenIdle()
  assert.deepEqual(effects, ['approved'])
  assert.equal(await readFile(join(temporary, 'effect.txt'), 'utf8'), 'approved')
  assert.deepEqual(decisions.map(x => x.outcome), ['deny', 'allow'])
  const installedManifest = JSON.parse(await readFile(join(home, 'profiles', profile, 'node_modules',
    'dsh-codex-auto-approval', 'package.json'), 'utf8'))
  assert.equal(installedManifest.version, '0.1.0')
  const presetService = ctx.permissionPresets
  const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'dsh-codex-auto-approval')
  assert.ok(entry)
  await entry.fiber.dispose()
  assert.equal(presetService.current(agent.session), 'workspace-write')
  assert.ok(!presetService.names.includes('auto'))
  await handle.dispose()
  await shutdown.shutdown(0)
  shutdown = undefined
  await cliRun(['plugin', '--profile', profile, 'remove', 'dsh-codex-auto-approval',
    '--store-dir', store], 'package-remove')
  const removedDump = await cliRun(['--profile', profile, '--dump-config'], 'profile-after-remove')
  assert.ok(!removedDump.includes('name: dsh-codex-auto-approval'))
  await writeFile(join(evidence, 'package-result.json'), JSON.stringify({ dsh: '0.2.0-rc.2',
    node: process.version, platform: process.platform, profile, tarball, commands,
    effects, decisions, uninstallRemovedBundle: true, model: 'deterministic test adapter',
    core: 'actual CLI / profile resolver / Loader / DSH services' }, null, 2))
  console.log('Tarball install, config dump, functional denial/allow, unload and removal passed.')
} finally {
  if (shutdown) await shutdown.shutdown(1)
  await rm(temporary, { recursive: true, force: true })
}
