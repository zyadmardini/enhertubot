/**
 * Seeded pseudo-randomness, so animation variation is varied across turns but
 * reproducible when you need it to be.
 *
 * Everything that picks a clip variant, jitters a gesture or drops an optional
 * beat draws from one of these rather than `Math.random()`. That buys two things.
 * A test can pin an utterance and assert on the exact clip chosen, which is the
 * only way variation is testable at all. And "it shrugged in the wrong place on
 * answer three" becomes reproducible from a seed instead of a ghost that never
 * shows up again while you're watching.
 */

export type Rng = () => number

/**
 * mulberry32 — a single multiply-xor round on a 32-bit counter.
 *
 * Far better distributed than picking between four clips actually requires, and
 * small enough that it costs nothing to seed one per utterance.
 */
export function seededRng(seed: number): Rng {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * FNV-1a. Turns an answer id into a stable seed.
 *
 * Stable across runs is the point: the same answer seeded the same way animates
 * the same way, so a reviewer comparing two builds is looking at code changes
 * rather than at the dice. Turn-to-turn variety comes from mixing in the turn
 * counter at the call site, not from reseeding this differently.
 */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Uniform choice. Null for an empty list, rather than an undefined by index. */
export function pick<T>(rng: Rng, items: readonly T[]): T | null {
  if (items.length === 0) return null
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length))
  return items[index] ?? null
}

/** Symmetric jitter in ±spread. */
export function jitter(rng: Rng, spread: number): number {
  return (rng() * 2 - 1) * spread
}
