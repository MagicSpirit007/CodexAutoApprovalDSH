import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ReviewSnapshot } from './snapshot.js'
import { createHash } from 'node:crypto'
import { ReviewError } from './assessment.js'
import type { Config } from './config.js'
import { REVIEW_POLICY } from './policy.js'
import { investigationSchemas } from './investigation.js'

const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** Bounded exact authorization survives surface compaction; summaries never gain authority. */
export class ContextMemory {
  private instructions = new Map<string, unknown>()
  private instructionBytes = 0

  constructor(private readonly config: Config) {}

  render(snapshot: ReviewSnapshot, agent: Agent): string {
    for (const entry of [...snapshot.projectInstructions, ...snapshot.history]) {
      if (entry.role === 'fact' || entry.role === 'checkpoint') continue
      const serialized = JSON.stringify(entry)
      const key = createHash('sha256').update(serialized).digest('hex')
      if (this.instructions.has(key)) continue
      if (this.instructionBytes + bytes(serialized) > this.config.maxInputBytes) {
        throw new ReviewError('Complete retained authorization exceeds the review input budget', 'INPUT_BUDGET')
      }
      this.instructions.set(key, entry)
      this.instructionBytes += bytes(serialized)
    }

    const historicalFacts = snapshot.history.filter(entry => entry.role === 'fact' || entry.role === 'checkpoint')
    const facts: unknown[] = historicalFacts.slice(-128)
    for (const seq of agent.session.surface.nodes.slice(-32)) {
      const event = agent.session.eventAt(seq)
      if (event?.type === 'assistant/message') {
        const content = event.data.message.content.filter(block => block.type === 'text')
        if (content.length) facts.push({ kind: 'assistant-context', role: 'fact', content })
      } else if (event?.type === 'tool/result') {
        facts.push({ kind: 'tool-result', role: 'fact', data: event.data })
      }
    }

    const required = {
      environment: { cwd: snapshot.cwd },
      retained_instructions: [...this.instructions.values()],
      pending_action: snapshot.action,
      fact_windows: { historicalEntries: 128, surfaceNodes: 32 },
      omission_notice: 'Older facts outside the windows and any omitted facts are unknown, not evidence that an action is safe.',
    }
    const selected: unknown[] = []
    // Input is JSON text inside a message: account for the second layer of
    // escaping, and include private schemas rather than estimating overhead.
    const fixed = JSON.stringify({ ...required, historical_facts: [], omitted_fact_count: Number.MAX_SAFE_INTEGER })
    const fixedBytes = bytes(JSON.stringify({ system: REVIEW_POLICY,
      messages: [{ role: 'user', content: [{ type: 'text', text: fixed }] }], tools: investigationSchemas }))
    if (fixedBytes > this.config.maxInputBytes) {
      throw new ReviewError('Complete action and minimum authorization exceed the review input budget', 'INPUT_BUDGET')
    }
    let remaining = this.config.maxInputBytes - fixedBytes
    let omitted = Math.max(0, historicalFacts.length - 128)
    for (const fact of facts.toReversed()) {
      const cost = bytes(JSON.stringify(JSON.stringify(fact))) - 2 + 1
      if (cost <= remaining) { selected.unshift(fact); remaining -= cost }
      else omitted++
    }
    return JSON.stringify({ ...required, historical_facts: selected, omitted_fact_count: omitted })
  }

  get retainedBytes(): number { return this.instructionBytes }
}
