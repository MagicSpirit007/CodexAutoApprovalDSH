import test from 'node:test'
import assert from 'node:assert/strict'
import { Config, validateConfig } from '../src/config.js'
import { parseAssessment, ReviewError } from '../src/assessment.js'
import { DenialWindow } from '../src/denials.js'
import { ReviewSlots } from '../src/concurrency.js'
import { allow, harness, isReview, text, tool } from './helpers.mjs'
import { writeFile, readFile } from 'node:fs/promises'
import { investigate } from '../src/investigation.js'
import { join } from 'node:path'

test('Codex assessment accepts minimal allow and prose envelope; rejects ambiguous protocol', () => {
  assert.equal(parseAssessment('```json\n{"outcome":"allow"}\n```').risk_level, 'low')
  assert.equal(parseAssessment('{"outcome":"deny"}').risk_level, 'high')
  assert.equal(parseAssessment('{"risk_level":"critical","outcome":"allow"}').outcome, 'deny')
  for (const invalid of ['{"outcome":"allow","outcome":"deny"}', '{"outcome":true}',
    '{"outcome":"allow","decision":"allow"}', 'null', '{"outcome":"allow","user_authorization":"yes"}']) {
    assert.throws(() => parseAssessment(invalid), ReviewError)
  }
})

test('private investigation refuses writes, unknown host capabilities, oversized reads and binary data', async t => {
  const h = await harness(t, () => text('Done'))
  const config = Config({ maxReadBytes: 8 })
  const signal = new AbortController().signal
  await writeFile(join(h.cwd, 'binary'), Buffer.from([0, 1, 2]))
  await assert.rejects(investigate(h.ctx.fs, 'record_effect', '{"path":"binary"}', h.cwd, signal, config), /Unknown/)
  await assert.rejects(investigate(h.ctx.fs, 'review_read_file', '{"path":"binary","length":9}', h.cwd, signal, config), /excessive/)
  await assert.rejects(investigate(h.ctx.fs, 'review_read_file', '{"path":"binary"}', h.cwd, signal, config), /Binary/)
  assert.deepEqual(h.effects, [])
  assert.deepEqual(await readFile(join(h.cwd, 'binary')), Buffer.from([0, 1, 2]))
})

test('config rejects invalid budgets/routes; default circuit breaker counts 10 / 50', () => {
  const defaults = Config({})
  assert.equal(defaults.autoEnableNewSessions, true)
  assert.equal(defaults.reviewTimeoutMs, 90_000)
  for (const invalid of [{ maxConcurrentReviews: 0 }, { maxAttempts: 1.5 },
    { reviewTimeoutMs: 2_147_483_648 }, { autoEnableNewSessions: 'true' }]) assert.throws(() => Config(invalid))
  assert.throws(() => validateConfig(Config({ reviewerProvider: 'test' })))
  assert.throws(() => validateConfig(Config({ reviewerProvider: ' ', reviewerModel: 'x' })))
  assert.throws(() => validateConfig(Config({ maxRecentDenials: 51 })))
  const breaker = new DenialWindow(defaults)
  for (let index = 0; index < 9; index++) { assert.equal(breaker.record(true), false); breaker.record(false) }
  assert.equal(breaker.record(true), true)
})

test('cancelled queue entries do not consume review slots or starve remaining reviews', async () => {
  const slots = new ReviewSlots(1)
  const running = await slots.acquire(new AbortController().signal)
  const cancel = new AbortController()
  const queued = slots.acquire(cancel.signal)
  const last = slots.acquire(new AbortController().signal)
  cancel.abort(new Error('withdrawn'))
  await assert.rejects(queued, /withdrawn/)
  running()
  const release = await last
  release()
  const final = await slots.acquire(new AbortController().signal)
  final()
})

test('private filesystem investigation reads actual bytes and never dispatches a host tool', async t => {
  let main = 0, reviews = 0
  const h = await harness(t, options => {
    if (!isReview(options)) return main++ === 0 ? tool('record_effect', { value: 'investigated' }) : text('Done')
    if (reviews++ === 0) return tool('review_read_file', { path: 'target.txt', length: 12 })
    assert.equal(options.tools.length, 3)
    const last = options.messages.at(-1)
    assert.match(JSON.stringify(last), /evidence123/)
    return allow()
  })
  await writeFile(join(h.cwd, 'target.txt'), 'evidence123456789')
  await h.run()
  assert.deepEqual(h.effects, ['investigated'])
  assert.equal(await readFile(join(h.cwd, 'target.txt'), 'utf8'), 'evidence123456789')
  const calls = h.agent.session.snapshotEvents().filter(e => e.type === 'tool/call')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].data.name, 'record_effect')
})

test('review parse failures retry within budget; exhausted output cannot execute unattended', async t => {
  let main = 0, reviews = 0
  const h = await harness(t, options => isReview(options) ?
    ++reviews < 3 ? text('bad JSON') : allow() :
    main++ === 0 ? tool('record_effect', { value: 'retried' }) : text('Done'))
  await h.run()
  assert.equal(reviews, 3)
  assert.deepEqual(h.effects, ['retried'])
})

test('input budget keeps entire pending action and fails closed for oversized authorization', async t => {
  let main = 0, reviews = 0
  const h = await harness(t, options => isReview(options) ? (reviews++, allow()) :
    main++ === 0 ? tool('record_effect', { value: 'unattended' }) : text('Done'),
  { config: { maxInputBytes: 20_000 } })
  await h.run('Explicit instruction ' + 'x'.repeat(30_000))
  assert.equal(reviews, 0)
  assert.deepEqual(h.effects, [])
  assert.ok(h.agent.session.snapshotEvents().some(e => JSON.stringify(e).includes('INPUT_BUDGET')))
})
