import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createAssistantMessage, createToolResultMessage,
  type ContentBlock, type GenerateOptions, type RequestMessage, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseAssessment, ReviewError, type Assessment } from './assessment.js'
import { abortable } from './concurrency.js'
import type { Config } from './config.js'
import { investigate, investigationSchemas } from './investigation.js'
import { REVIEW_POLICY } from './policy.js'
import type { ReviewSnapshot } from './snapshot.js'

interface Response { blocks: ContentBlock[]; kind: string }

async function readResponse(stream: AsyncIterable<StreamChunk>, signal: AbortSignal, maxBytes: number): Promise<Response> {
  const assembler = new BlockAssembler()
  const iterator = stream[Symbol.asyncIterator]()
  let finish: string | undefined
  let outputBytes = 0
  try {
    for (;;) {
      const next = await abortable(iterator.next(), signal)
      if (next.done) break
      outputBytes += Buffer.byteLength(JSON.stringify(next.value))
      if (outputBytes > maxBytes) throw new ReviewError('Reviewer response exceeds output budget', 'OUTPUT_BUDGET')
      if (finish) throw new ReviewError('Reviewer emitted data after finish', 'PARSE', true)
      assembler.push(next.value)
      if (next.value.type !== 'finish') continue
      const reason = next.value.reason
      if (reason.kind === 'error' || reason.kind === 'aborted') {
        const retryable = reason.failure.status === undefined ?
          ['TIMEOUT', 'CONNECTION_ERROR', 'RATE_LIMITED', 'SERVER_ERROR'].includes(reason.failure.code) :
          [408, 429].includes(reason.failure.status) || reason.failure.status >= 500
        throw new ReviewError(reason.failure.message, reason.failure.code, retryable)
      }
      finish = reason.kind
    }
  } finally {
    // Do not wait forever for an adapter that ignores cancellation. Its pending
    // next() is observed by abortable, and no late outcome can become a grant.
    void iterator.return?.().catch(() => {})
  }
  if (!finish) throw new ReviewError('Reviewer emitted no terminal finish', 'PARSE', true)
  return { blocks: assembler.blocks(), kind: finish }
}

async function attempt(ctx: Context, snapshot: ReviewSnapshot, input: string, signal: AbortSignal,
  config: Config): Promise<Assessment> {
  const provider = config.reviewerProvider ?? snapshot.provider
  const model = config.reviewerModel ?? snapshot.model
  const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: input }] }]
  for (let round = 0; round < config.maxReviewRounds; round++) {
    signal.throwIfAborted()
    const options: GenerateOptions = { provider, model, system: REVIEW_POLICY, messages,
      tools: investigationSchemas, temperature: 0, signal }
    if (Buffer.byteLength(JSON.stringify({ system: options.system, messages, tools: options.tools })) > config.maxInputBytes) {
      throw new ReviewError('Review investigation exceeds input budget', 'INPUT_BUDGET')
    }
    const response = await readResponse(ctx.llm.stream(options), signal, config.maxInputBytes)
    const calls = response.blocks.filter(block => block.type === 'tool-call')
    if (response.kind === 'stop' && calls.length === 0) {
      const texts = response.blocks.filter(block => block.type === 'text')
      if (texts.length !== 1 || response.blocks.some(block => !['text', 'reasoning'].includes(block.type))) {
        throw new ReviewError('Reviewer must return exactly one JSON text block', 'PARSE', true)
      }
      return parseAssessment(texts[0].text)
    }
    if (response.kind !== 'tool-calls' || calls.length === 0 || calls.length > 8) {
      throw new ReviewError('Invalid reviewer tool-call response', 'PARSE', true)
    }
    messages.push(createAssistantMessage({ source: { provider, model }, content: response.blocks }))
    for (const call of calls) {
      let result: string, isError = false
      try { result = await abortable(investigate(ctx.fs, call.name, call.arguments, snapshot.cwd, signal, config), signal) }
      catch (error) {
        signal.throwIfAborted()
        isError = true
        result = JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
      }
      messages.push(createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: result }], isError }))
    }
  }
  throw new ReviewError('Reviewer exhausted its investigation rounds', 'REVIEW_LIMIT')
}

export async function review(ctx: Context, snapshot: ReviewSnapshot, input: string, signal: AbortSignal,
  config: Config): Promise<Assessment> {
  for (let count = 1; ; count++) {
    try { return await attempt(ctx, snapshot, input, signal, config) }
    catch (error) {
      signal.throwIfAborted()
      if (count >= config.maxAttempts || !(error instanceof ReviewError) || !error.retryable) throw error
      await new Promise<void>((resolve, reject) => {
        const aborted = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, 200 * 2 ** (count - 1))
        signal.addEventListener('abort', aborted, { once: true })
      })
    }
  }
}
