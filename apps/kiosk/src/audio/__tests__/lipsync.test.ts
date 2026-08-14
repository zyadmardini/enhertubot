import { describe, expect, it } from 'vitest'
import { LipSync } from '../lipsync.ts'
import type { LipSyncOptions } from '../lipsync.ts'
import type { AudioBus } from '../AudioBus.ts'
import type { ArticulationDetail, CharAlignment } from '../alignment.ts'

const OPTIONS: LipSyncOptions = {
  attackSeconds: 0.005,
  releaseSeconds: 0.07,
  noiseFloor: 0.04,
  articulationLeadSeconds: 0.045,
  minArticulationSeconds: 0.05,
  articulationDetail: 'full',
  // Off for the classification tests: they step one frame at a time and assert on
  // what was decided, and a hold would report the previous frame's answer instead.
  // Exercised deliberately in its own block below.
  minVisemeSeconds: 0,
  bands: {
    f1: [200, 1000],
    f2: [1100, 2800],
    postalveolar: [2800, 4200],
    sibilant: [4500, 10000],
    sibilantRatio: 0.62,
    ih: 1.15,
    E: 0.72,
    aa: 0.42,
    oh: 0.22,
  },
}

/** Anything the analyser can produce. Used where the assertion is "not a consonant". */
const VOWELS = ['aa', 'E', 'ih', 'oh', 'ou']

/**
 * Enough of the bus for the analyser path. A real AudioBus needs an AudioContext,
 * which the node test environment has no notion of — and the thing under test is
 * how the viseme sources are layered, not Web Audio itself.
 */
class FakeBus {
  analyser = { fftSize: 1024, frequencyBinCount: 512 }
  /** Real rate, because the classifier turns Hz windows into bin indices with it. */
  sampleRate = 48000
  isPlaying = true
  playbackSeconds = 0

  /** A square wave of this amplitude, so RMS is exactly the value set here. */
  amplitude = 0.25

  /**
   * Spectrum shape, as four flat plateaus — one per band the classifier reads.
   * Deliberately crude: it only ever compares band means, so a synthetic vowel is
   * four numbers. `shush` is the postalveolar plateau that separates /ʃ/ from /s/.
   */
  spectrum = { low: 120, mid: 120, shush: 120, high: 120 }

  getTimeDomainData(out: Uint8Array): void {
    for (let i = 0; i < out.length; i++) {
      out[i] = 128 + (i % 2 === 0 ? 1 : -1) * this.amplitude * 128
    }
  }

  getFrequencyData(out: Uint8Array): void {
    const binHz = this.sampleRate / this.analyser.fftSize
    for (let i = 0; i < out.length; i++) {
      const hz = i * binHz
      // Plateau edges match the band windows in OPTIONS, so each band reads
      // exactly one plateau.
      out[i] =
        hz < 1000
          ? this.spectrum.low
          : hz < 2800
            ? this.spectrum.mid
            : hz < 4200
              ? this.spectrum.shush
              : this.spectrum.high
    }
  }
}

function setup(
  detail: ArticulationDetail = 'full',
  overrides: Partial<LipSyncOptions> = {},
): { bus: FakeBus; lip: LipSync } {
  const bus = new FakeBus()
  const lip = new LipSync(bus as unknown as AudioBus, {
    ...OPTIONS,
    articulationDetail: detail,
    ...overrides,
  })
  return { bus, lip }
}

/** Run the envelope to steady state so assertions aren't reading the attack ramp. */
function settle(lip: LipSync, frames = 30): void {
  for (let i = 0; i < frames; i++) lip.update(1 / 60)
}

function align(text: string, msPerChar = 100): CharAlignment {
  const chars = [...text]
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => i * msPerChar),
    charDurationsMs: chars.map(() => msPerChar),
  }
}

/** The viseme the given spelling produces at `seconds` into the utterance. */
function visemeAt(text: string, seconds: number, detail: ArticulationDetail = 'full'): string {
  const { bus, lip } = setup(detail)
  lip.alignment.append(align(text), 0)
  settle(lip)
  bus.playbackSeconds = seconds
  return lip.update(1 / 60).viseme
}

describe('LipSync', () => {
  it('drives the mouth from the analyser when there is no alignment', () => {
    const { lip } = setup()
    settle(lip)

    const frame = lip.update(1 / 60)
    expect(frame.mouthOpen).toBeGreaterThan(0.5)
    expect(VOWELS).toContain(frame.viseme)
  })

  it('shuts the mouth on a bilabial the analyser would have left open', () => {
    const { bus, lip } = setup()
    lip.alignment.append(align('ma'), 0)
    settle(lip)

    // Loud audio, so the analyser alone would report a wide-open mouth here.
    bus.playbackSeconds = 0.02
    const frame = lip.update(1 / 60)
    expect(frame.viseme).toBe('PP')
    expect(frame.mouthOpen).toBe(0)
  })

  it('leaves a labiodental slightly open', () => {
    const { bus, lip } = setup()
    lip.alignment.append(align('fa'), 0)
    settle(lip)

    bus.playbackSeconds = 0.02
    const frame = lip.update(1 / 60)
    expect(frame.viseme).toBe('FF')
    expect(frame.mouthOpen).toBeGreaterThan(0)
    expect(frame.mouthOpen).toBeLessThanOrEqual(0.28)
  })

  it('hands the vowel back to the analyser once the articulation passes', () => {
    const { bus, lip } = setup()
    lip.alignment.append(align('ma'), 0)
    settle(lip)

    bus.playbackSeconds = 0.02
    expect(lip.update(1 / 60).viseme).toBe('PP')

    bus.playbackSeconds = 0.15
    expect(VOWELS).toContain(lip.update(1 / 60).viseme)
  })

  it('keeps the envelope advancing through a closure', () => {
    const { bus, lip } = setup()
    lip.alignment.append(align('ma'), 0)

    // Hold the lips shut for a long stretch while loud audio plays.
    bus.playbackSeconds = 0.02
    for (let i = 0; i < 30; i++) lip.update(1 / 60)

    // The level must have tracked the audio underneath rather than being frozen
    // at zero, or the mouth lurches open from nothing when the closure releases.
    bus.playbackSeconds = 0.15
    expect(lip.update(1 / 60).mouthOpen).toBeGreaterThan(0.5)
  })

  it('leads the articulation so it lands with the sound rather than after it', () => {
    const { bus, lip } = setup()
    // An articulation occupying 1.00–1.10s of playback.
    lip.alignment.append(align('ama'), 1)
    settle(lip)

    // Still short of it, but inside the lead window.
    bus.playbackSeconds = 1.1 - OPTIONS.articulationLeadSeconds + 0.005
    expect(lip.update(1 / 60).viseme).toBe('PP')
  })

  it('closes the mouth when nothing is playing', () => {
    const { bus, lip } = setup()
    settle(lip)
    bus.isPlaying = false
    settle(lip)

    const frame = lip.update(1 / 60)
    expect(frame.viseme).toBe('sil')
    expect(frame.mouthOpen).toBe(0)
  })

  describe('articulation from spelling', () => {
    it('puts the tongue between the teeth on a th', () => {
      expect(visemeAt('thin', 0.02)).toBe('TH')
    })

    it('reads a hard c as a velar and a soft c as nothing at all', () => {
      expect(visemeAt('cat', 0.02)).toBe('kk')
      // Soft c is /s/, which belongs to the analyser — so the mouth must be
      // showing whatever it heard, not a /k/ the spelling invented.
      expect(visemeAt('city', 0.02)).not.toBe('kk')
    })

    it('reads a soft g as the postalveolar shape', () => {
      expect(visemeAt('gem', 0.02)).toBe('CH')
      expect(visemeAt('got', 0.02)).toBe('kk')
    })

    it('does not pronounce the silent k in "know"', () => {
      expect(visemeAt('know', 0.02)).toBe('nn')
    })

    it('swallows gh rather than guessing at it', () => {
      // n, then the vowel, then gh — which must lay nothing down, leaving the
      // analyser in charge through it. A velar here would be plainly wrong.
      expect(visemeAt('night', 0.22)).not.toBe('kk')
    })

    it('treats sh as one postalveolar rather than an s then an h', () => {
      expect(visemeAt('ship', 0.02)).toBe('CH')
    })

    it('purses the lips on a w', () => {
      expect(visemeAt('way', 0.02)).toBe('ou')
    })

    it('holds one contact across a doubled letter', () => {
      const { lip } = setup()
      lip.alignment.append(align('letter'), 0)
      // l, tt, r — three spans, not four. The merge is what stops "little"
      // stuttering the tongue against the same spot twice.
      expect(lip.alignment.spanCount).toBe(3)
    })

    it('caps the jaw per articulation rather than letting the vowel through', () => {
      const { bus, lip } = setup()
      lip.alignment.append(align('cat'), 0)
      bus.amplitude = 0.9
      settle(lip)

      bus.playbackSeconds = 0.02
      const frame = lip.update(1 / 60)
      expect(frame.viseme).toBe('kk')
      expect(frame.mouthOpen).toBeLessThanOrEqual(0.4)
    })

    it('drops every tongue gesture at closures detail, and keeps the lips', () => {
      expect(visemeAt('thin', 0.02, 'closures')).not.toBe('TH')
      expect(visemeAt('cat', 0.02, 'closures')).not.toBe('kk')
      expect(visemeAt('pat', 0.02, 'closures')).toBe('PP')
      expect(visemeAt('fat', 0.02, 'closures')).toBe('FF')
    })
  })

  describe('viseme hold', () => {
    const HOLD = 0.1

    const IH = { low: 100, mid: 140, shush: 20, high: 20 }
    const AA = { low: 200, mid: 100, shush: 20, high: 20 }
    const OH = { low: 200, mid: 60, shush: 20, high: 20 }
    const SS = { low: 40, mid: 50, shush: 60, high: 200 }

    it('refuses a second change until the first has been shown', () => {
      const { bus, lip } = setup('full', { minVisemeSeconds: HOLD })
      bus.spectrum = IH
      settle(lip)

      // A shape held since before anyone was watching has served its time, so
      // the first change goes straight through. That is the point: the hold
      // limits successive changes, it does not delay every one.
      bus.spectrum = AA
      expect(lip.update(1 / 60).viseme).toBe('aa')

      // A third shape one frame later is the flicker case, and is refused.
      bus.spectrum = OH
      expect(lip.update(1 / 60).viseme).toBe('aa')

      // Once the hold is served it goes through.
      for (let i = 0; i < 7; i++) lip.update(1 / 60)
      expect(lip.update(1 / 60).viseme).toBe('oh')
    })

    it('lets a bilabial through mid-hold', () => {
      const { bus, lip } = setup('full', { minVisemeSeconds: HOLD })
      lip.alignment.append(align('ma'), 0)
      bus.spectrum = IH
      // Past the /m/ span, so the analyser is in charge to begin with.
      bus.playbackSeconds = 0.5
      settle(lip)

      bus.spectrum = AA
      expect(lip.update(1 / 60).viseme).toBe('aa')

      // Now the lips must meet, one frame into a hold that has barely started.
      // Too visible and too brief to wait its turn — waiting swallows the /m/
      // in "summer" entirely.
      bus.playbackSeconds = 0.02
      expect(lip.update(1 / 60).viseme).toBe('PP')
    })

    it('caps the jaw on the shape being shown, not the one being asked for', () => {
      const { bus, lip } = setup('full', { minVisemeSeconds: HOLD })
      bus.spectrum = AA
      bus.amplitude = 0.9
      settle(lip)

      bus.spectrum = SS
      expect(lip.update(1 / 60).viseme).toBe('SS')

      // A loud open vowel arrives while the /s/ is still held. The shape stays
      // SS, so the aperture must stay SS's too — otherwise the mouth hangs open
      // on a shape that is drawn nearly shut.
      bus.spectrum = AA
      const frame = lip.update(1 / 60)
      expect(frame.viseme).toBe('SS')
      expect(frame.mouthOpen).toBeLessThanOrEqual(0.22)
    })

    it('closes immediately when the audio stops', () => {
      const { bus, lip } = setup('full', { minVisemeSeconds: 10 })
      settle(lip)
      bus.isPlaying = false

      // A ten-second hold must not keep the mouth open after the answer ends.
      expect(lip.update(1 / 60).viseme).toBe('sil')
    })
  })

  describe('analyser classification', () => {
    /** Drive the classifier with one synthetic spectrum and read the shape back. */
    function visemeFor(spectrum: {
      low: number
      mid: number
      shush: number
      high: number
    }): string {
      const { bus, lip } = setup()
      bus.spectrum = spectrum
      settle(lip)
      return lip.update(1 / 60).viseme
    }

    it('orders the vowels by F2:F1, close and spread through to rounded', () => {
      expect(visemeFor({ low: 100, mid: 140, shush: 20, high: 20 })).toBe('ih')
      expect(visemeFor({ low: 200, mid: 180, shush: 20, high: 20 })).toBe('E')
      expect(visemeFor({ low: 200, mid: 100, shush: 20, high: 20 })).toBe('aa')
      expect(visemeFor({ low: 200, mid: 60, shush: 20, high: 20 })).toBe('oh')
      // The distinction a coarser split could not make: both rounded vowels are
      // dark, and drawing them identically is what made them read as mush.
      expect(visemeFor({ low: 200, mid: 25, shush: 20, high: 20 })).toBe('ou')
    })

    it('detects a sibilant from broadband energy above the formants', () => {
      // The one consonant class an analyser can identify outright. Without it the
      // /s/ in "yes" inherits the vowel's jaw and the word ends wide open.
      expect(visemeFor({ low: 40, mid: 50, shush: 60, high: 200 })).toBe('SS')
    })

    it('separates a postalveolar from a sibilant by where the noise peaks', () => {
      // "ship" against "sip", with no help from spelling — the whole reason the
      // extra band is worth reading.
      expect(visemeFor({ low: 40, mid: 50, shush: 200, high: 60 })).toBe('CH')
    })

    it('holds a sibilant nearly shut however loud it is', () => {
      const { bus, lip } = setup()
      bus.spectrum = { low: 40, mid: 50, shush: 60, high: 200 }
      bus.amplitude = 0.9
      settle(lip)

      const frame = lip.update(1 / 60)
      expect(frame.viseme).toBe('SS')
      expect(frame.mouthOpen).toBeLessThanOrEqual(0.22)
    })
  })
})
