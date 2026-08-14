import type { VisionSample } from '../tracking/types.ts'

export interface WaveTuning {
  /** Analysis window. Long enough for a few swings, short enough to feel prompt. */
  windowSeconds: number
  /** Direction changes required within the window. */
  minReversals: number
  /** Peak-to-peak lateral travel required, normalised units. */
  minAmplitude: number
  /** Movement below this is noise, not a swing. */
  minSegment: number
  /** Mean open-palm score across the window. */
  minOpenness: number
  /** Hand must sit no lower than this below the face centre (y is +down). */
  maxYBelowFace: number
  /** Ceiling used when no face is detected. */
  maxY: number
  /** Ignore further waves this long after one fires. */
  refractorySeconds: number
}

interface Frame {
  t: number
  x: number
  openness: number
}

/**
 * Detects a hello wave: an open palm, held up, swinging side to side.
 *
 * All three conditions matter, and each rules out a specific false positive.
 * Open palm rejects a fist or a phone held up to film. Raised rejects the arm
 * swing of someone walking past. Oscillation rejects a hand held still, which
 * is what a person pointing or gesturing mid-sentence looks like.
 *
 * Openness is averaged over the window rather than required every frame — a
 * fast wave motion-blurs, and the classifier gives up on a fair share of frames
 * while it does. Demanding an open palm on all of them would reject exactly the
 * enthusiastic waves that most deserve a reply.
 *
 * Runs on detector samples, not render frames, so the window holds ~20 entries.
 */
export class WaveDetector {
  #tuning: WaveTuning
  #frames: Frame[] = []
  #firedAt = -Infinity

  constructor(tuning: WaveTuning) {
    this.#tuning = tuning
  }

  /** @returns true on the single sample at which a wave completes. */
  update(now: number, sample: VisionSample | null): boolean {
    const t = this.#tuning

    if (now - this.#firedAt < t.refractorySeconds) {
      this.#frames.length = 0
      return false
    }

    const hand = sample?.hand ?? null
    if (hand === null) {
      // Don't wipe the window on a single lost frame — a wave crossing in front
      // of the face loses tracking constantly. Ageing the window out is enough:
      // a hand that stays gone takes its samples with it.
      this.#prune(now)
      return false
    }

    const ceiling = sample?.face ? sample.face.y + t.maxYBelowFace : t.maxY
    if (hand.y > ceiling) {
      // A hand down at waist level is someone walking, not greeting.
      this.#frames.length = 0
      return false
    }

    this.#frames.push({ t: now, x: hand.x, openness: hand.openness })
    this.#prune(now)

    if (this.#frames.length < 4) return false
    if (this.#meanOpenness() < t.minOpenness) return false
    if (this.#amplitude() < t.minAmplitude) return false
    if (this.#reversals() < t.minReversals) return false

    this.#firedAt = now
    this.#frames.length = 0
    return true
  }

  reset(): void {
    this.#frames.length = 0
  }

  #prune(now: number): void {
    const cutoff = now - this.#tuning.windowSeconds
    // Oldest-first, so a shift loop drops exactly the expired head of the
    // window. At detector rate this is a handful of entries, never a scan.
    while (this.#frames.length > 0 && this.#frames[0]!.t < cutoff) this.#frames.shift()
  }

  #meanOpenness(): number {
    let sum = 0
    for (const frame of this.#frames) sum += frame.openness
    return sum / this.#frames.length
  }

  #amplitude(): number {
    let lo = Infinity
    let hi = -Infinity
    for (const frame of this.#frames) {
      if (frame.x < lo) lo = frame.x
      if (frame.x > hi) hi = frame.x
    }
    return hi - lo
  }

  /**
   * Zigzag count: track the running extreme in the current direction, and only
   * count a turn once the hand has moved `minSegment` back against it. Detector
   * jitter never travels that far, so noise can't inflate the count the way a
   * naive sign-of-delta test would.
   */
  #reversals(): number {
    const minSegment = this.#tuning.minSegment
    let direction = 0
    let anchor = this.#frames[0]!.x
    let count = 0

    for (let i = 1; i < this.#frames.length; i += 1) {
      const x = this.#frames[i]!.x
      const delta = x - anchor
      if (direction === 0) {
        if (Math.abs(delta) >= minSegment) {
          direction = Math.sign(delta)
          anchor = x
        }
        continue
      }
      if (Math.sign(delta) === direction) {
        anchor = x
      } else if (Math.abs(delta) >= minSegment) {
        count += 1
        direction = -direction
        anchor = x
      }
    }

    return count
  }
}
