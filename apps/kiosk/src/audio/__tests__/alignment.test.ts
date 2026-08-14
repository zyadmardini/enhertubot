import { describe, expect, it } from 'vitest'
import { AlignmentTrack } from '../alignment.ts'
import type { ArticulationDetail, CharAlignment } from '../alignment.ts'

/** Even character timings, the shape ElevenLabs sends alongside each chunk. */
function align(text: string, msPerChar = 100): CharAlignment {
  const chars = [...text]
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => i * msPerChar),
    charDurationsMs: chars.map(() => msPerChar),
  }
}

function track(detail: ArticulationDetail = 'full', minArticulationSeconds = 0.05): AlignmentTrack {
  return new AlignmentTrack({ minArticulationSeconds, detail })
}

/** The articulation a spelling produces at `seconds`, on a fresh track. */
function at(text: string, seconds: number, detail: ArticulationDetail = 'full'): string | null {
  const t = track(detail)
  t.append(align(text), 0)
  return t.articulationAt(seconds)
}

describe('AlignmentTrack', () => {
  describe('lip gestures', () => {
    it('closes the lips on bilabials and leaves vowels to the analyser', () => {
      const t = track()
      t.append(align('map'), 0)

      expect(t.articulationAt(0.05)).toBe('PP')
      // The vowel is deliberately not claimed — spelling is a bad guide to vowel
      // sound, so the spectrum is the better source for it.
      expect(t.articulationAt(0.15)).toBeNull()
      expect(t.articulationAt(0.25)).toBe('PP')
    })

    it('tucks the lip on labiodentals', () => {
      const t = track()
      t.append(align('favour'), 0)

      expect(t.articulationAt(0.05)).toBe('FF')
      expect(t.articulationAt(0.15)).toBeNull()
      expect(t.articulationAt(0.25)).toBe('FF')
    })

    it('reads ph as /f/, not /p/', () => {
      const t = track()
      t.append(align('phone'), 0)

      // Pressing the lips shut in the middle of "phone" is the exact failure this
      // digraph case exists to prevent.
      expect(t.articulationAt(0.05)).toBe('FF')
      expect(t.articulationAt(0.15)).toBe('FF')
      expect(t.articulationAt(0.25)).toBeNull()
    })
  })

  describe('tongue gestures', () => {
    it('reads th as the interdental, not as a t', () => {
      expect(at('thin', 0.05)).toBe('TH')
      expect(at('thin', 0.15)).toBe('TH')
    })

    it('reads the postalveolar spellings as one gesture each', () => {
      expect(at('ship', 0.05)).toBe('CH')
      expect(at('chair', 0.05)).toBe('CH')
      expect(at('watch', 0.35)).toBe('CH')
    })

    it('splits c and g on the letter that follows', () => {
      expect(at('cat', 0.05)).toBe('kk')
      expect(at('got', 0.05)).toBe('kk')
      // Soft c is /s/ and belongs to the analyser; soft g is /dʒ/, which is CH.
      expect(at('city', 0.05)).toBeNull()
      expect(at('gem', 0.05)).toBe('CH')
    })

    it('reads ng as a nasal rather than an n then a g', () => {
      expect(at('sing', 0.25)).toBe('nn')
    })

    it('purses the lips on w and wh', () => {
      expect(at('way', 0.05)).toBe('ou')
      expect(at('what', 0.05)).toBe('ou')
    })

    it('drops the silent letter in kn and wr', () => {
      expect(at('know', 0.05)).toBe('nn')
      expect(at('write', 0.05)).toBe('RR')
    })

    it('lays down nothing at all for gh', () => {
      const t = track()
      t.append(align('night'), 0)

      // Silent in "night", /f/ in "laugh". Drawing nothing on the rare one is far
      // cheaper than drawing a hard velar on the common ones.
      expect(t.articulationAt(0.25)).toBeNull()
      expect(t.articulationAt(0.35)).toBeNull()
      // n at the front, t at the back — the gh between them is simply skipped.
      expect(t.spanCount).toBe(2)
    })
  })

  describe('detail levels', () => {
    it('keeps only the lip gestures at closures detail', () => {
      expect(at('pat', 0.05, 'closures')).toBe('PP')
      expect(at('fat', 0.05, 'closures')).toBe('FF')
      expect(at('phone', 0.05, 'closures')).toBe('FF')
    })

    it('claims nothing for the tongue at closures detail', () => {
      expect(at('thin', 0.05, 'closures')).toBeNull()
      expect(at('cat', 0.05, 'closures')).toBeNull()
      expect(at('ship', 0.05, 'closures')).toBeNull()
      expect(at('way', 0.05, 'closures')).toBeNull()
    })

    it('does not resurrect a silent letter when the cluster is filtered out', () => {
      // 'kn' is dropped at closures detail, and the k underneath it must not come
      // back as a /k/ — the filter removes the gesture, not the exception.
      expect(at('know', 0.05, 'closures')).toBeNull()
    })
  })

  describe('span bookkeeping', () => {
    it('merges a doubled consonant into one press', () => {
      const t = track()
      t.append(align('hammer'), 0)

      // The mm is one span; the r at the end is the other.
      expect(t.spanCount).toBe(2)
      expect(t.articulationAt(0.25)).toBe('PP')
      expect(t.articulationAt(0.35)).toBe('PP')
    })

    it('merges a silent letter into the gesture before it', () => {
      const t = track()
      // "climb" — the b is silent but still a lip press, so it extends the m
      // rather than re-closing the lips after they have already opened.
      t.append(align('climb'), 0)

      expect(t.articulationAt(0.35)).toBe('PP')
      expect(t.articulationAt(0.45)).toBe('PP')
      // c, l, then the merged mb: three spans, not four.
      expect(t.spanCount).toBe(3)
    })

    it('places each chunk on the bus playback clock, not its own', () => {
      const t = track()
      t.append(align('ma'), 0)
      t.append(align('ba'), 1)

      expect(t.articulationAt(0.05)).toBe('PP')
      // Without the offset the second chunk's b would land back at 0s and drive
      // the mouth with the previous chunk's syllables.
      expect(t.articulationAt(0.55)).toBeNull()
      expect(t.articulationAt(1.05)).toBe('PP')
    })

    it('holds a very brief gesture long enough to render', () => {
      const t = track('full', 0.05)
      // 10ms per character: at 60fps this /m/ could fall entirely between frames.
      t.append(align('am', 10), 0)

      expect(t.articulationAt(0.05)).toBe('PP')
      expect(t.articulationAt(0.08)).toBeNull()
    })

    it('reports nothing when there is no alignment at all', () => {
      // The cached-answer path: pre-rendered MP3s carry no timings, and the mouth
      // has to fall back to the analyser rather than freeze shut.
      const t = track()
      expect(t.articulationAt(0)).toBeNull()
      expect(t.articulationAt(12)).toBeNull()
    })

    it('reports nothing past the end of the last gesture', () => {
      const t = track()
      t.append(align('ma'), 0)
      expect(t.articulationAt(99)).toBeNull()
    })

    it('drops everything on clear', () => {
      const t = track()
      t.append(align('map'), 0)
      t.clear()

      // Barge-in. Spans from an abandoned answer would otherwise drive the mouth
      // partway through the next one, whose clock restarts at zero.
      expect(t.spanCount).toBe(0)
      expect(t.articulationAt(0.05)).toBeNull()
    })
  })
})
