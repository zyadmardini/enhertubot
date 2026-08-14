import { describe, expect, it } from 'vitest'
import { GazeController } from '../gaze.ts'
import type { GazeTuning } from '../gaze.ts'
import type { FaceObservation } from '../../tracking/types.ts'

const tuning = (overrides: Partial<GazeTuning> = {}): GazeTuning => ({
  dampingSeconds: 0.35,
  maxSpeed: 3.5,
  maxYaw: 1,
  maxPitch: 1,
  switchHysteresisSeconds: 0.5,
  absenceGraceSeconds: 1,
  acquireSeconds: 0.25,
  releaseSeconds: 1.2,
  minConfidence: 0.4,
  scan: { amplitudeX: 0.45, amplitudeY: 0.12, speed: 0.25 },
  // Saccades off by default: they're deliberate discontinuity, and every test
  // here is about the absence of discontinuity. One test turns them back on.
  saccade: { intervalRange: [1, 1], magnitude: 0 },
  ...overrides,
})

const face = (x: number, y = 0): FaceObservation => ({ x, y, size: 0.05, confidence: 1 })

const DT = 1 / 60

/** Run the controller for `seconds`, returning every frame's output. */
function run(
  controller: GazeController,
  seconds: number,
  sample: FaceObservation | null | ((t: number) => FaceObservation | null),
) {
  const frames = []
  const total = Math.round(seconds / DT)
  for (let i = 0; i < total; i += 1) {
    const at = i * DT
    frames.push(controller.update(DT, typeof sample === 'function' ? sample(at) : sample))
  }
  return frames
}

/** Largest single-frame change in gaze. The number that decides whether it snaps. */
function maxStep(frames: Array<{ gazeX: number }>): number {
  let worst = 0
  for (let i = 1; i < frames.length; i += 1) {
    worst = Math.max(worst, Math.abs(frames[i]!.gazeX - frames[i - 1]!.gazeX))
  }
  return worst
}

describe('GazeController', () => {
  it('settles on a tracked face', () => {
    const controller = new GazeController(tuning())
    const frames = run(controller, 2, face(0.6))
    expect(frames.at(-1)!.gazeX).toBeCloseTo(0.6, 2)
    expect(frames.at(-1)!.tracking).toBe(true)
  })

  it('lags behind the target rather than locking onto it', () => {
    // Attention, not a servo. Arriving instantly reads as a machine following a
    // face; arriving a few hundred ms late reads as a character noticing one.
    const controller = new GazeController(tuning())
    const frames = run(controller, 0.15, face(1))
    expect(frames.at(-1)!.gazeX).toBeLessThan(0.5)
  })

  it('honours the speed cap when the target teleports across the frame', () => {
    // The regression guard for the whole feature. A target that jumps the full
    // range must still come out as motion, not as a cut — the cap is what
    // bounds it, so assert against the cap rather than a number picked by hand.
    const t = tuning()
    const controller = new GazeController(t)
    run(controller, 2, face(-1))
    const frames = run(controller, 3, face(1))
    expect(frames.at(-1)!.gazeX).toBeCloseTo(1, 1)
    expect(maxStep(frames)).toBeLessThanOrEqual(t.maxSpeed * DT)
  })

  it('holds the last position through a brief dropout', () => {
    // BlazeFace drops frames constantly. Easing away and back for every one of
    // them would make the head shiver.
    const controller = new GazeController(tuning())
    run(controller, 2, face(0.5))
    const frames = run(controller, 0.3, null)
    expect(frames.at(-1)!.gazeX).toBeCloseTo(0.5, 2)
    expect(frames.at(-1)!.attention).toBe(1)
  })

  it('eases back to the idle scan smoothly when the visitor leaves', () => {
    const controller = new GazeController(tuning())
    run(controller, 3, face(0.9))
    const frames = run(controller, 4, null)

    // Attention releases fully, and the handoff produces no step — this is the
    // moment the old first-order controller snapped.
    expect(frames.at(-1)!.attention).toBe(0)
    expect(frames.at(-1)!.tracking).toBe(false)
    expect(maxStep(frames)).toBeLessThan(0.02)
  })

  it('starts the idle scan from where the head already is', () => {
    // Seeding the scan phase is what stops the head swinging across the room to
    // meet a sine wave that happened to be somewhere else.
    const controller = new GazeController(tuning())
    run(controller, 3, face(0.4))
    const frames = run(controller, 1.4, null)
    // Grace (1s) then a little release: still near where the visitor was.
    expect(Math.abs(frames.at(-1)!.gazeX - 0.4)).toBeLessThan(0.15)
  })

  it('keeps moving with nobody in frame', () => {
    // A character that holds perfectly still reads as crashed.
    const controller = new GazeController(tuning())
    const frames = run(controller, 8, null)
    const xs = frames.slice(-240).map((f) => f.gazeX)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.05)
  })

  it('ignores a second face until the hysteresis window passes', () => {
    const controller = new GazeController(tuning())
    run(controller, 2, face(-0.8))
    // Someone else steps in immediately: too soon, the head stays put.
    const frames = run(controller, 0.3, face(0.8))
    expect(frames.at(-1)!.gazeX).toBeLessThan(-0.5)
  })

  it('does switch targets once the window has passed', () => {
    const controller = new GazeController(tuning())
    run(controller, 2, face(-0.8))
    const frames = run(controller, 2, face(0.8))
    expect(frames.at(-1)!.gazeX).toBeCloseTo(0.8, 1)
  })

  it('ignores detections below the confidence floor', () => {
    const controller = new GazeController(tuning())
    const frames = run(controller, 2, { x: 0.9, y: 0, size: 0.05, confidence: 0.1 })
    expect(frames.at(-1)!.tracking).toBe(false)
  })

  it('flicks the pupils without flicking the head', () => {
    // Eyes dart, heads glide. The same offset on the head bone would read as a
    // twitch, so saccades must reach gazeX and never yaw.
    const controller = new GazeController(
      tuning({ saccade: { intervalRange: [0.2, 0.2], magnitude: 0.05 } }),
      () => 1,
    )
    const frames = run(controller, 2, face(0.5))
    const last = frames.at(-1)!
    expect(last.gazeX).toBeGreaterThan(last.yaw)
    expect(last.yaw).toBeCloseTo(0.5, 2)
  })
})
