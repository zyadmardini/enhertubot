/**
 * Rolling latency record. Tune against p95, not the lucky p50 — the slow turns
 * are the ones a visitor reads as broken.
 */
export class LatencyTracker {
  #samples: number[] = []
  #limit: number

  constructor(limit = 100) {
    this.#limit = limit
  }

  add(ms: number): void {
    this.#samples.push(ms)
    if (this.#samples.length > this.#limit) this.#samples.shift()
  }

  get count(): number {
    return this.#samples.length
  }

  get last(): number | null {
    return this.#samples.at(-1) ?? null
  }

  /** Nearest-rank percentile. p(50) on an empty set is null, not zero. */
  p(percentile: number): number | null {
    if (this.#samples.length === 0) return null
    const sorted = [...this.#samples].sort((a, b) => a - b)
    const rank = Math.ceil((percentile / 100) * sorted.length)
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null
  }

  reset(): void {
    this.#samples = []
  }
}
