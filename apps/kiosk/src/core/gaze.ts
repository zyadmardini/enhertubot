import type { FaceObservation } from '../tracking/types.ts'
import { Spring, clamp, moveTowards, smoothstep } from './spring.ts'

export interface GazeTuning {
  dampingSeconds: number
  maxSpeed: number
  maxYaw: number
  maxPitch: number
  switchHysteresisSeconds: number
  absenceGraceSeconds: number
  acquireSeconds: number
  releaseSeconds: number
  minConfidence: number
  scan: { amplitudeX: number; amplitudeY: number; speed: number }
  saccade: { intervalRange: [number, number]; magnitude: number }
}

/**
 * How far a detection has to land from the tracked face to read as a different
 * person rather than the same one moving. Frame-relative, so it doesn't belong
 * in the tuning block — it's a property of the coordinate space.
 */
const SWITCH_DISTANCE = 0.4

export interface GazeOutput {
  /** Head bone rotation, radians. */
  yaw: number
  pitch: number
  /** Pupil offset, -1..1, passed to the face renderer. */
  gazeX: number
  gazeY: number
  /** True while locked onto a real visitor rather than idle-scanning. */
  tracking: boolean
  /** 0 = pure idle scan, 1 = fully locked on. Continuous — the HUD reads it raw. */
  attention: number
}

/**
 * Converts raw detections into head motion that reads as attention.
 *
 * The hard part is not following a face; it is the handoff at both ends of a
 * detection, which is where head tracking normally gives itself away.
 *
 * Three things do the work:
 *
 *   1. The idle scan runs *continuously*, whether or not anyone is in frame, so
 *      there is always a valid "nobody here" target to hand back to.
 *   2. An `attention` weight crossfades between that scan and the tracked face —
 *      fast to acquire, slow to release. Losing a visitor is a fade, not a
 *      switch, so there is no discontinuity to smooth away in the first place.
 *   3. The result drives a critically damped spring, so even a genuine target
 *      jump (a new visitor stepping in front) comes out as an S-curve.
 *
 * Damping, clamping and the scan live here rather than in the tracking adapter,
 * so swapping MediaPipe for another detector — or none — changes nothing about
 * how Enubot moves.
 */
export class GazeController {
  #tuning: GazeTuning
  #rng: () => number

  #faceX = 0
  #faceY = 0
  #springX = new Spring(0)
  #springY = new Spring(0)

  #attention = 0
  #timeSinceSeen = Infinity
  #scanPhase = 0
  #releaseSeeded = false

  /** A candidate face that hasn't yet earned the switch. */
  #pendingX = 0
  #pendingY = 0
  #pendingFor = 0

  #saccadeX = 0
  #saccadeY = 0
  #saccadeCountdown = 0

  constructor(tuning: GazeTuning, rng: () => number = Math.random) {
    this.#tuning = tuning
    this.#rng = rng
    this.#saccadeCountdown = this.#nextSaccadeDelay()
  }

  /**
   * @param face Newest observation, or null when nobody is in frame. Detection
   *   runs slower than rendering, so this is a staircase — the spring's settle
   *   time is an order of magnitude longer than the detect interval, so the
   *   steps are invisible and interpolating them would only add lag.
   */
  update(dt: number, face: FaceObservation | null): GazeOutput {
    const t = this.#tuning

    // Always advancing, so the fallback target is continuous at the moment
    // attention starts handing back to it.
    this.#scanPhase += dt * t.scan.speed

    const seen = face !== null && face.confidence >= t.minConfidence
    if (seen) {
      this.#adoptTarget(face, dt)
      this.#timeSinceSeen = 0
      this.#releaseSeeded = false
    } else {
      this.#timeSinceSeen += dt
    }

    // Absence grace is a *hold*, not a freeze: attention stays at 1 and the head
    // keeps looking where the visitor was. Only once the grace expires does the
    // crossfade back to the scan begin.
    const holding = this.#timeSinceSeen <= t.absenceGraceSeconds
    const attentionTarget = seen || holding ? 1 : 0

    if (attentionTarget === 0 && !this.#releaseSeeded) {
      // Start the scan from where the head already is, so it drifts away from
      // the visitor rather than swinging across the room to meet a sine wave
      // that happened to be somewhere else.
      this.#scanPhase = Math.asin(clamp(this.#faceX / t.scan.amplitudeX, -1, 1))
      this.#releaseSeeded = true
    }

    const ramp = attentionTarget > this.#attention ? t.acquireSeconds : t.releaseSeconds
    this.#attention = moveTowards(this.#attention, attentionTarget, dt / Math.max(1e-4, ramp))
    const weight = smoothstep(this.#attention)

    const scanX = Math.sin(this.#scanPhase) * t.scan.amplitudeX
    const scanY = Math.sin(this.#scanPhase * 0.6) * t.scan.amplitudeY
    const targetX = scanX + (this.#faceX - scanX) * weight
    const targetY = scanY + (this.#faceY - scanY) * weight

    const x = this.#springX.step(targetX, dt, t.dampingSeconds, t.maxSpeed)
    const y = this.#springY.step(targetY, dt, t.dampingSeconds, t.maxSpeed)

    this.#updateSaccades(dt, weight)

    return {
      yaw: clamp(x, -1, 1) * t.maxYaw,
      pitch: clamp(y, -1, 1) * t.maxPitch,
      // Saccades land on the pupils only. Eyes dart; heads glide. Putting the
      // same flick on the head bone would read as a twitch.
      gazeX: clamp(x + this.#saccadeX, -1, 1),
      gazeY: clamp(y + this.#saccadeY, -1, 1),
      tracking: weight > 0.5,
      attention: weight,
    }
  }

  /**
   * Hysteresis: a face far from the one being tracked has to hold still for the
   * switch window before the head goes to it.
   *
   * This is a persistence requirement, not a rate limit on switching — the
   * distinction matters. Two visitors of similar size make "largest box" flip
   * between them frame to frame; a rate limit answers that by switching every
   * 500ms, which turns a flicker into the head sweeping back and forth between
   * two people. Requiring the new position to *persist* means alternating
   * detections never accumulate the window at all, and Enubot keeps looking at
   * whoever it picked.
   */
  #adoptTarget(face: FaceObservation, dt: number): void {
    const jumped =
      Math.abs(face.x - this.#faceX) > SWITCH_DISTANCE ||
      Math.abs(face.y - this.#faceY) > SWITCH_DISTANCE

    // Nothing to switch away from: the first face after an empty booth is taken
    // at once, or Enubot would ignore the first half-second of every visitor.
    if (!jumped || this.#attention < 0.5) {
      this.#faceX = face.x
      this.#faceY = face.y
      this.#pendingFor = 0
      return
    }

    const consistent =
      Math.abs(face.x - this.#pendingX) <= SWITCH_DISTANCE &&
      Math.abs(face.y - this.#pendingY) <= SWITCH_DISTANCE
    this.#pendingFor = consistent ? this.#pendingFor + dt : 0
    this.#pendingX = face.x
    this.#pendingY = face.y

    if (this.#pendingFor >= this.#tuning.switchHysteresisSeconds) {
      this.#faceX = face.x
      this.#faceY = face.y
      this.#pendingFor = 0
    }
  }

  /**
   * Micro-saccades. Real eyes never hold perfectly still, and a pupil that does
   * is the single clearest tell that a character is being driven rather than
   * looking. Deliberately instantaneous — smoothing these would defeat them.
   */
  #updateSaccades(dt: number, weight: number): void {
    if (weight <= 0.5) {
      this.#saccadeX = 0
      this.#saccadeY = 0
      return
    }
    this.#saccadeCountdown -= dt
    if (this.#saccadeCountdown > 0) return
    this.#saccadeCountdown = this.#nextSaccadeDelay()
    const magnitude = this.#tuning.saccade.magnitude
    this.#saccadeX = (this.#rng() * 2 - 1) * magnitude
    this.#saccadeY = (this.#rng() * 2 - 1) * magnitude * 0.6
  }

  #nextSaccadeDelay(): number {
    const [lo, hi] = this.#tuning.saccade.intervalRange
    return lo + this.#rng() * (hi - lo)
  }
}
