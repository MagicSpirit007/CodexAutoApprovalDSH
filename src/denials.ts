import type { Config } from './config.js'

/** Port of Codex's standard per-turn rejection circuit breaker. */
export class DenialWindow {
  private consecutive = 0
  private recent: boolean[] = []
  private interrupted = false
  constructor(private readonly config: Config) {}

  record(denied: boolean): boolean {
    this.consecutive = denied ? this.consecutive + 1 : 0
    this.recent.push(denied)
    if (this.recent.length > this.config.denialWindowSize) this.recent.shift()
    if (!this.interrupted && (this.consecutive >= this.config.maxConsecutiveDenials
      || this.recent.filter(Boolean).length >= this.config.maxRecentDenials)) {
      this.interrupted = true
      return true
    }
    return false
  }
}
