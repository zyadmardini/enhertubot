import { describe, expect, it } from 'vitest'
import { VisemeTrack, visemesForPhone } from '../visemes.ts'
import type { PhoneSpan, PhoneTrack } from '../visemes.ts'

/** Phones back to back, one per entry, at a fixed length each. */
function track(phones: string[], seconds = 0.1, from = 0): PhoneTrack {
  return {
    phones: phones.map((p, i) => ({ p, start: from + i * seconds, end: from + (i + 1) * seconds })),
  }
}

function build(phones: PhoneSpan[], minSpanSeconds = 0): VisemeTrack {
  const t = new VisemeTrack({ minSpanSeconds })
  t.append({ phones }, 0)
  return t
}

/** What the track shows across a clip, as the run of shapes in order. */
function shapesOf(t: VisemeTrack, until: number, step = 0.005): string[] {
  const out: string[] = []
  for (let time = 0; time < until; time += step) {
    const viseme = t.visemeAt(time)
    if (viseme && viseme !== out[out.length - 1]) out.push(viseme)
  }
  return out
}

describe('visemesForPhone', () => {
  it('groups consonants by place of articulation', () => {
    expect(visemesForPhone('P')).toEqual(['PP'])
    expect(visemesForPhone('B')).toEqual(['PP'])
    expect(visemesForPhone('M')).toEqual(['PP'])
    expect(visemesForPhone('F')).toEqual(['FF'])
    expect(visemesForPhone('TH')).toEqual(['TH'])
    expect(visemesForPhone('DH')).toEqual(['TH'])
    expect(visemesForPhone('NG')).toEqual(['kk'])
    // From the front an /l/ and an /n/ are the same picture.
    expect(visemesForPhone('L')).toEqual(['nn'])
  })

  it('ignores stress marks', () => {
    expect(visemesForPhone('AA1')).toEqual(visemesForPhone('AA'))
    expect(visemesForPhone('IH0')).toEqual(['ih'])
  })

  it('splits a diphthong into the two shapes it travels between', () => {
    // The difference between "no" and "gnaw": one of them rounds at the end.
    expect(visemesForPhone('OW')).toEqual(['oh', 'ou'])
    expect(visemesForPhone('AY')).toEqual(['aa', 'ih'])
  })

  it('reads IPA as well as ARPAbet', () => {
    // MFA's newer English dictionaries are IPA, and re-baking with one must not
    // need a code change.
    expect(visemesForPhone('ʃ')).toEqual(['CH'])
    expect(visemesForPhone('θ')).toEqual(['TH'])
    expect(visemesForPhone('tʃ')).toEqual(['CH'])
    expect(visemesForPhone('aɪ')).toEqual(['aa', 'ih'])
  })

  it('claims nothing for a phone with no shape of its own', () => {
    // /h/ takes the shape of whatever follows it — see TRANSPARENT.
    expect(visemesForPhone('HH')).toBeNull()
    // And an unknown symbol is left alone rather than guessed at.
    expect(visemesForPhone('ʡ')).toBeNull()
  })

  it('treats silence as a shape', () => {
    expect(visemesForPhone('SIL')).toEqual(['sil'])
    expect(visemesForPhone('SP')).toEqual(['sil'])
  })
})

describe('VisemeTrack', () => {
  it('reports the shape covering a time and nothing outside the track', () => {
    const t = build(track(['M', 'AE', 'P']).phones)

    expect(t.visemeAt(0.05)).toBe('PP')
    expect(t.visemeAt(0.15)).toBe('aa')
    expect(t.visemeAt(0.25)).toBe('PP')
    expect(t.visemeAt(0.45)).toBeNull()
  })

  it('offsets onto the bus playback clock', () => {
    const t = new VisemeTrack({ minSpanSeconds: 0 })
    t.append(track(['M', 'AE']), 2)

    expect(t.visemeAt(0.05)).toBeNull()
    expect(t.visemeAt(2.05)).toBe('PP')
    expect(t.visemeAt(2.15)).toBe('aa')
  })

  it('merges a run of the same shape into one span', () => {
    // Two phones that draw the same picture are one held shape, not two.
    const t = build(track(['N', 'L']).phones)
    expect(t.spanCount).toBe(1)
    expect(t.visemeAt(0.15)).toBe('nn')

    // But a different shape beside them still breaks the run.
    expect(build(track(['N', 'L', 'T']).phones).spanCount).toBe(2)
  })

  it('gives /h/ the shape of the vowel after it', () => {
    // "he" and "who" have nothing in common at the lips; a fixed shape for /h/
    // puts a wrong one in front of both.
    expect(build(track(['HH', 'IY']).phones).visemeAt(0.05)).toBe('ih')
    expect(build(track(['HH', 'UW']).phones).visemeAt(0.05)).toBe('ou')
  })

  it('keeps a diphthong inside its own span', () => {
    const t = build([{ p: 'OW', start: 0, end: 0.2 }])

    expect(t.visemeAt(0.05)).toBe('oh')
    expect(t.visemeAt(0.18)).toBe('ou')
    // Never borrows from a neighbour: the aligner's boundaries are the point.
    expect(t.visemeAt(0.21)).toBeNull()
  })

  describe('minimum span', () => {
    it('grows a brief shape forwards rather than backwards', () => {
      // A /p/ can be measured at 15ms, which is under a frame at 60fps and can
      // fall between two of them — the lips would miss a closure that is there.
      const t = build(
        [
          { p: 'P', start: 0.1, end: 0.115 },
          { p: 'AA', start: 0.115, end: 0.4 },
        ],
        0.05,
      )

      // Not early: a consonant that starts before its time lands on the wrong
      // vowel, which is the failure that reads as being out of sync.
      expect(t.visemeAt(0.09)).toBeNull()
      expect(t.visemeAt(0.14)).toBe('PP')
      expect(t.visemeAt(0.16)).toBe('aa')
    })

    it('deletes a stop closure marked as silence mid-word', () => {
      // An aligner marks the closure before a /t/ as silence. It is part of the
      // consonant, not a pause, and rendering it shuts the mouth mid-word.
      const t = build(
        [
          { p: 'AA', start: 0, end: 0.2 },
          { p: 'SIL', start: 0.2, end: 0.22 },
          { p: 'T', start: 0.22, end: 0.3 },
        ],
        0.05,
      )

      expect(shapesOf(t, 0.3)).toEqual(['aa', 'DD'])
      expect(t.visemeAt(0.21)).toBe('aa')
    })

    it('keeps a real pause', () => {
      const t = build(
        [
          { p: 'AA', start: 0, end: 0.2 },
          { p: 'SIL', start: 0.2, end: 0.9 },
          { p: 'T', start: 0.9, end: 1 },
        ],
        0.05,
      )

      expect(t.visemeAt(0.5)).toBe('sil')
    })

    it('leaves no gap for a query to fall into', () => {
      const t = build(
        [
          { p: 'AA', start: 0, end: 0.2 },
          { p: 'SIL', start: 0.2, end: 0.21 },
          { p: 'M', start: 0.21, end: 0.5 },
        ],
        0.05,
      )

      for (let time = 0; time < 0.5; time += 0.001) {
        expect(t.visemeAt(time)).not.toBeNull()
      }
    })
  })

  it('drops everything on clear', () => {
    const t = build(track(['M', 'AE', 'P']).phones)
    t.clear()

    expect(t.spanCount).toBe(0)
    expect(t.visemeAt(0.05)).toBeNull()
  })

  it('survives a track with no usable phones', () => {
    const t = new VisemeTrack({ minSpanSeconds: 0.033 })
    t.append({ phones: [] }, 0)
    t.append({ phones: [{ p: 'M', start: 0.2, end: 0.1 }] }, 0)

    expect(t.spanCount).toBe(0)
    expect(t.visemeAt(0.15)).toBeNull()
  })
})
