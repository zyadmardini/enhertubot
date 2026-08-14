import { describe, expect, it } from 'vitest'
import { PresenceTracker } from '../presence.ts'
import type { PresenceTuning } from '../presence.ts'
import type { FaceObservation } from '../../tracking/types.ts'

const tuning: PresenceTuning = {
  arrivalSeconds: 0.4,
  departureSeconds: 1.5,
  dropoutToleranceSeconds: 0.5,
  minFaceSize: 0.012,
  newVisitorJump: 0.5,
}

const face = (x = 0, size = 0.05): FaceObservation => ({ x, y: 0, size, confidence: 1 })

/** Detector rate, which is the rate this class is actually driven at. */
const TICK = 1 / 15

/** Feed samples from `from` for `seconds`, collecting whatever fires. */
function feed(
  tracker: PresenceTracker,
  from: number,
  seconds: number,
  sample: FaceObservation | null,
) {
  const events: Array<{ at: number; event: string }> = []
  const ticks = Math.round(seconds / TICK)
  for (let i = 0; i < ticks; i += 1) {
    const at = from + i * TICK
    const event = tracker.update(at, sample)
    if (event) events.push({ at, event })
  }
  return { events, until: from + ticks * TICK }
}

describe('PresenceTracker', () => {
  it('reports an arrival only after sustained detection', () => {
    const tracker = new PresenceTracker(tuning)
    expect(feed(tracker, 0, 0.3, face()).events).toEqual([])
    expect(tracker.present).toBe(false)
    expect(feed(tracker, 0.3, 0.3, face()).events.map((e) => e.event)).toEqual(['arrived'])
    expect(tracker.present).toBe(true)
  })

  it('ignores a face too small to be at the booth', () => {
    // There is always somebody in frame at a trade show. Size is what separates
    // a visitor from the crowd walking past behind them.
    const tracker = new PresenceTracker(tuning)
    expect(feed(tracker, 0, 3, face(0, 0.004)).events).toEqual([])
    expect(tracker.present).toBe(false)
  })

  it('does not arrive on a glance that walks on', () => {
    const tracker = new PresenceTracker(tuning)
    feed(tracker, 0, 0.25, face())
    const after = feed(tracker, 0.25, 1, null)
    const back = feed(tracker, 1.25, 0.25, face())
    expect([...after.events, ...back.events]).toEqual([])
  })

  it('absorbs a dropout without departing', () => {
    const tracker = new PresenceTracker(tuning)
    feed(tracker, 0, 1, face())
    const gap = feed(tracker, 1, 1.2, null)
    const resumed = feed(tracker, 2.2, 0.5, face())
    expect([...gap.events, ...resumed.events]).toEqual([])
    expect(tracker.present).toBe(true)
  })

  it('departs once absence outlasts the window', () => {
    const tracker = new PresenceTracker(tuning)
    feed(tracker, 0, 1, face())
    const { events } = feed(tracker, 1, 2.5, null)
    expect(events.map((e) => e.event)).toEqual(['departed'])
    expect(tracker.present).toBe(false)
  })

  it('counts each visitor separately', () => {
    const tracker = new PresenceTracker(tuning)
    feed(tracker, 0, 1, face())
    const first = tracker.visitorId
    feed(tracker, 1, 2.5, null)
    feed(tracker, 3.5, 1, face())
    expect(tracker.visitorId).toBe(first + 1)
  })

  it('treats a reappearance somewhere else as the next person in the queue', () => {
    // One visitor steps away, the next steps in. Without this they'd inherit the
    // first one's greeting and get ignored.
    const tracker = new PresenceTracker(tuning)
    feed(tracker, 0, 1, face(-0.7))
    const first = tracker.visitorId

    feed(tracker, 1, 0.8, null)
    const swap = feed(tracker, 1.8, 0.1, face(0.7))
    expect(swap.events.map((e) => e.event)).toEqual(['departed'])

    const next = feed(tracker, 1.9, 0.5, face(0.7))
    expect(next.events.map((e) => e.event)).toEqual(['arrived'])
    expect(tracker.visitorId).toBe(first + 1)
  })

  it('does not mistake ordinary movement for a new visitor', () => {
    const tracker = new PresenceTracker(tuning)
    feed(tracker, 0, 1, face(-0.7))
    const id = tracker.visitorId
    // Same person walking across the frame, seen the whole way — no gap, so no swap.
    let at = 1
    for (let x = -0.7; x <= 0.7; x += 0.05) {
      expect(tracker.update(at, face(x))).toBeNull()
      at += TICK
    }
    expect(tracker.visitorId).toBe(id)
  })
})
