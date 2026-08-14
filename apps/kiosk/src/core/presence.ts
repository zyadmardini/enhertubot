import type { FaceObservation } from '../tracking/types.ts'

export type PresenceEvent = 'arrived' | 'departed'

export interface PresenceTuning {
  /** Continuous detection needed before it counts as an arrival. */
  arrivalSeconds: number
  /** Absence needed before it counts as a departure. */
  departureSeconds: number
  /** A dropped detection shorter than this doesn't interrupt anything. */
  dropoutToleranceSeconds: number
  /** Fraction of frame area the face box must cover. */
  minFaceSize: number
  /** Reacquiring this far from the last position counts as a different person. */
  newVisitorJump: number
}

/**
 * Turns a noisy per-frame "is there a face" into two events worth acting on.
 *
 * The whole job is refusing to trust any single detection. BlazeFace drops
 * frames whenever someone turns their head, blinks past the confidence floor or
 * moves fast enough to blur — so raw `present` flickers several times a minute,
 * and a robot that greeted every rising edge would spend the day waving at one
 * person. Arrival needs sustained detection; departure needs sustained absence;
 * short dropouts in between are absorbed.
 *
 * The size gate does the other half of the work: at a trade show there is
 * always someone in frame. `minFaceSize` is what distinguishes a visitor at the
 * booth from the crowd walking past behind them.
 */
export class PresenceTracker {
  #tuning: PresenceTuning
  #present = false
  #visitorId = 0
  #lastSeenAt = -Infinity
  #candidateSince: number | null = null
  #lastX = 0
  #lastY = 0
  #hasLastPosition = false

  constructor(tuning: PresenceTuning) {
    this.#tuning = tuning
  }

  get present(): boolean {
    return this.#present
  }

  /**
   * Increments for each visitor. Lets the greeter tell "the same person is still
   * standing here" from "somebody new walked up" without any face recognition —
   * which a public kiosk should not be doing in the first place.
   */
  get visitorId(): number {
    return this.#visitorId
  }

  /** @param now Seconds, from the sample's own capture time. */
  update(now: number, face: FaceObservation | null): PresenceEvent | null {
    const t = this.#tuning
    const close = face !== null && face.size >= t.minFaceSize

    if (!close) {
      if (this.#present && now - this.#lastSeenAt > t.departureSeconds) {
        this.#present = false
        this.#candidateSince = null
        this.#hasLastPosition = false
        return 'departed'
      }
      // An arrival that never completed: someone glanced over and kept walking.
      if (!this.#present && now - this.#lastSeenAt > t.dropoutToleranceSeconds) {
        this.#candidateSince = null
      }
      return null
    }

    const reacquired = now - this.#lastSeenAt > t.dropoutToleranceSeconds
    const jumped =
      this.#hasLastPosition &&
      (Math.abs(face.x - this.#lastX) > t.newVisitorJump ||
        Math.abs(face.y - this.#lastY) > t.newVisitorJump)

    this.#lastSeenAt = now
    this.#lastX = face.x
    this.#lastY = face.y
    this.#hasLastPosition = true

    // Reappearing somewhere else after a gap is the queue case: one visitor
    // stepped away and the next stepped in. Report the swap so the new person
    // gets their own greeting instead of inheriting the last one's.
    if (this.#present && reacquired && jumped) {
      this.#present = false
      this.#candidateSince = now
      return 'departed'
    }

    if (!this.#present) {
      if (this.#candidateSince === null || reacquired) this.#candidateSince = now
      if (now - this.#candidateSince >= t.arrivalSeconds) {
        this.#present = true
        this.#candidateSince = null
        this.#visitorId += 1
        return 'arrived'
      }
    }

    return null
  }
}
