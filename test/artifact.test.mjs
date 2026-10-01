import test from 'node:test'
import assert from 'node:assert/strict'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as plugin from '../lib/index.js'
import { Context, allow, deny, harness, isReview, text, tool } from './helpers.mjs'

test('built namespace exports metadata and actual Loader waits for missing dependencies', async t => {
  assert.equal('default' in plugin, false)
  assert.equal(plugin.name, 'dsh-codex-auto-approval')
  assert.ok(plugin.inject.includes('fs'))
  assert.equal(plugin.Config({}).autoEnableNewSessions, true)
  const ctx = new Context()
  t.after(() => ctx.fiber.dispose())
  await ctx.plugin(Loader, { baseUrl: import.meta.url })
  const loader = ctx.loader
  loader.builtins.auto = plugin
  const id = await loader.create({ name: 'cordis:auto', config: {} })
  await loader.await()
  assert.equal(loader.resolve(id).fiber.state, 0)
})

test('built ESM through real Loader executes only approved action and unregisters Auto', async t => {
  let main = 0, reviews = 0
  const h = await harness(t, options => isReview(options) ?
    ++reviews === 1 ? deny('Rejected artifact test action') : allow() :
    main++ < 2 ? tool('record_effect', { value: main === 1 ? 'blocked' : 'approved' }) : text('Done'),
  { specifier: process.env.DSH_ARTIFACT_ENTRY ?? new URL('../lib/index.js', import.meta.url).href })
  await h.run()
  assert.deepEqual(h.effects, ['approved'])
  assert.equal(await h.effectFile(), 'approved')
  await h.entry.fiber.dispose()
  assert.ok(!h.ctx.permissionPresets.names.includes('codex-auto-approval'))
  assert.equal(h.ctx.permissionPresets.current(h.agent.session), 'workspace-write')
})

test('Loader reports invalid configuration instead of activating defaults silently', async t => {
  await assert.rejects(harness(t, () => text('Done'), { plugin,
    config: { reviewerProvider: 'test' } }), /configured together/)
  await assert.rejects(harness(t, () => text('Done'), { plugin,
    config: { maxConcurrentReviews: 0 } }), /maxConcurrentReviews|range|minimum|less than|constraint/i)
})
