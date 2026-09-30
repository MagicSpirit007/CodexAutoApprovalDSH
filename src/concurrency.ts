/** Cancellation-aware bound on active provider reviews; queued work owns no permit. */
export class ReviewSlots {
  private active = 0
  private queue: (() => void)[] = []
  constructor(private readonly limit: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted()
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener('abort', aborted); resolve() }
        const aborted = () => {
          this.queue = this.queue.filter(item => item !== ready)
          signal.removeEventListener('abort', aborted)
          reject(signal.reason)
        }
        signal.addEventListener('abort', aborted, { once: true })
        this.queue.push(ready)
      })
    } else {
      this.active++
    }
    // A queued permit is transferred by release; an abort racing that transfer
    // must return it rather than consuming capacity forever.
    if (signal.aborted) { this.release(); signal.throwIfAborted() }
    let released = false
    return () => { if (!released) { released = true; this.release() } }
  }

  private release(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.active--
  }
}

/** Race uncooperative provider iteration without permitting a late outcome. */
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(value => {
      signal.removeEventListener('abort', aborted)
      signal.aborted ? reject(signal.reason) : resolve(value)
    }, error => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}
