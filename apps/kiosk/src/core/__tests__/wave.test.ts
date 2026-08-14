import { describe, expect, it } from 'vitest'
import { WaveDetector } from '../wave.ts'
import type { WaveTuning } from '../wave.ts'
import type { VisionSample } from '../../tracking/types.ts'

const tuning: WaveTuning = {
  windowSeconds: 1.3,
  minReversals: 3,
  minAmplitude: 0.1,
  minSegment: 0.025,
  minOpenness: 0.35,
  maxYBelowFace: 0.05,
  maxY: 0.15,
  refractorySeconds: 3,
}

const TICK = 1 / 15

interface HandOptions {
  x: number
  y?: number
  openness?: number
}

const sample = (t: number, hand: HandOptions | null): VisionSample => ({
  t,
  face: { x: 0, y: 0, size: 0.05, confidence: 1 },
  hand:
    hand === null
      ? null
      : { x: hand.x, y: hand.y ?? -0.3, openness: hand.openness ?? 0.9, confidence: 0.9 },
})

/**
 * Feed a sine-shaped wave and return the time it was detected, or null.
 * 2.5Hz and ±0.12 is an ordinary human hello.
 */
function wave(
  detector: WaveDetector,
  seconds: number,
  from = 0,
  { hz = 2.5, amplitude = 0.12, openness = 0.9, y = -0.3 } = {},
): number | null {
  const ticks = Math.round(seconds / TICK)
  for (let i = 0; i < ticks; i += 1) {
    const t = from + i * TICK
    const x = Math.sin(t * hz * 2 * Math.PI) * amplitude
    if (detector.update(t, sample(t, { x, y, openness }))) return t
  }
  return null
}

describe('WaveDetector', () => {
  it('detects an ordinary hello wave', () => {
    const detector = new WaveDetector(tuning)
    expect(wave(detector, 2)).not.toBeNull()
  })

  it('reports it within about a second', () => {
    // Longer than this and the visitor has already given up and walked off.
    const detector = new WaveDetector(tuning)
    expect(wave(detector, 3)).toBeLessThan(1.2)
  })

  it('ignores a hand held still', () => {
    // Someone gesturing mid-sentence, or holding up a phone.
    const detector = new WaveDetector(tuning)
    for (let i = 0; i < 60; i += 1) {
      const t = i * TICK
      expect(detector.update(t, sample(t, { x: 0.2 }))).toBe(false)
    }
  })

  it('ignores a hand that sweeps past once', () => {
    const detector = new WaveDetector(tuning)
    for (let i = 0; i < 30; i += 1) {
      const t = i * TICK
      expect(detector.update(t, sample(t, { x: -0.5 + i * 0.04 }))).toBe(false)
    }
  })

  it('ignores a closed hand', () => {
    // Arm swing of somebody walking past, not a greeting.
    const detector = new WaveDetector(tuning)
    expect(wave(detector, 3, 0, { openness: 0 })).toBeNull()
  })

  it('ignores a wave down at waist level', () => {
    const detector = new WaveDetector(tuning)
    expect(wave(detector, 3, 0, { y: 0.6 })).toBeNull()
  })

  it('ignores a swing too small to be meant for anyone', () => {
    const detector = new WaveDetector(tuning)
    expect(wave(detector, 3, 0, { amplitude: 0.02 })).toBeNull()
  })

  it('tolerates the frames a fast wave blurs away', () => {
    // The classifier gives up on a fair share of frames during a real wave.
    // Requiring an open palm on every one of them would reject exactly the
    // enthusiastic waves that most deserve an answer.
    const detector = new WaveDetector(tuning)
    let fired: number | null = null
    for (let i = 0; i < 45; i += 1) {
      const t = i * TICK
      const x = Math.sin(t * 2.5 * 2 * Math.PI) * 0.12
      // Every third frame loses the palm classification entirely.
      const openness = i % 3 === 0 ? 0 : 0.95
      if (detector.update(t, sample(t, { x, openness }))) {
        fired = t
        break
      }
    }
    expect(fired).not.toBeNull()
  })

  it('survives brief loss of the hand without restarting', () => {
    const detector = new WaveDetector(tuning)
    let fired: number | null = null
    for (let i = 0; i < 45; i += 1) {
      const t = i * TICK
      const x = Math.sin(t * 2.5 * 2 * Math.PI) * 0.12
      // A wave crossing in front of the face loses tracking constantly.
      const lost = i % 5 === 0
      if (detector.update(t, sample(t, lost ? null : { x }))) {
        fired = t
        break
      }
    }
    expect(fired).not.toBeNull()
  })

  it('fires once, then holds off', () => {
    const detector = new WaveDetector(tuning)
    const first = wave(detector, 4)
    expect(first).not.toBeNull()
    // Keep waving through the refractory window: no second trigger.
    expect(wave(detector, tuning.refractorySeconds - 0.3, first! + TICK)).toBeNull()
  })

  it('will answer again after the refractory window', () => {
    const detector = new WaveDetector(tuning)
    const first = wave(detector, 4)!
    expect(wave(detector, 3, first + tuning.refractorySeconds)).not.toBeNull()
  })

  it('does nothing without a hand', () => {
    const detector = new WaveDetector(tuning)
    for (let i = 0; i < 30; i += 1) {
      expect(detector.update(i * TICK, sample(i * TICK, null))).toBe(false)
    }
  })
})
