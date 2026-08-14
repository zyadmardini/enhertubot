/**
 * The half of lip-sync that spectral analysis cannot do.
 *
 * `LipSync` infers vowel shape from band energy, which works because vowels are
 * loud and spectrally distinct. Consonants are neither: a bilabial /m/ and a pause
 * are both near-silent, so an analyser sees the same thing for "summer" and
 * "su—er" and the lips never meet. A /θ/ and a /d/ are quieter still, and neither
 * has a spectral signature worth the name. That is what makes DSP-only lip-sync
 * read as approximate — the vowels are right and every consonant is a guess.
 *
 * ElevenLabs hands us per-character timings alongside every audio chunk, which is
 * enough to know when the tongue and lips *must* be somewhere regardless of what
 * the spectrum says. This track turns those timings into articulation spans on the
 * AudioBus playback clock; LipSync overlays them on the DSP baseline.
 *
 * Deliberately one-directional: articulation never supplies a vowel. Characters
 * are not phonemes, and English spelling is a poor guide to vowel sounds —
 * "though", "through" and "tough" share four letters and no vowel. The analyser
 * is the better source for those, so it keeps them outright.
 */

import type { Viseme } from './lipsync.ts'

/**
 * The consonant articulations a spelling can be trusted for.
 *
 * A subset of `Viseme`: every vowel is missing on purpose, and so is `SS` — the
 * analyser detects sibilance outright and does it better, because it hears the
 * difference between the s in "rose" and the s in "sun" that the letter hides.
 *
 * `ou` is here despite being a vowel shape because /w/ is a lip gesture, not a
 * tongue one: "way" is a pucker no matter what follows it.
 */
export type Articulation = Extract<
  Viseme,
  'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'nn' | 'RR' | 'ou'
>

/**
 * How much of the spelling to trust.
 *
 * `closures` is the conservative original: only the lip gestures p/b/m and f/v,
 * which are the two an analyser provably cannot see. `full` adds the tongue
 * articulations, which are a bigger win and a bigger bet — they lean on English
 * orthography, and a bad guess puts the tongue somewhere visible and wrong.
 *
 * Exposed rather than hardcoded so the two can be compared against the same
 * utterance on the inspector page. "Busier" and "better" are easy to confuse.
 */
export type ArticulationDetail = 'closures' | 'full'

/** The `alignment` block as it arrives on an ElevenLabs `audio` event. */
export interface CharAlignment {
  chars: string[]
  charStartTimesMs: number[]
  charDurationsMs: number[]
}

export interface AlignmentTrackOptions {
  /**
   * Shortest an articulation may render for. A /p/ can be alignment-reported at
   * 20ms, which at 60fps can fall between two frames and never be drawn at all —
   * the lips would stay open through a sound whose entire job is closing them.
   * Extends the end only, so an articulation never lands early.
   */
  minArticulationSeconds: number
  detail: ArticulationDetail
}

interface ArticulationSpan {
  articulation: Articulation
  /** Seconds in AudioBus playback space, not chunk-relative. */
  start: number
  end: number
}

export class AlignmentTrack {
  #spans: ArticulationSpan[] = []
  #opts: AlignmentTrackOptions

  constructor(opts: AlignmentTrackOptions) {
    this.#opts = opts
  }

  get spanCount(): number {
    return this.#spans.length
  }

  get detail(): ArticulationDetail {
    return this.#opts.detail
  }

  /** Takes effect on the next `append`; spans already laid down are unaffected. */
  set detail(value: ArticulationDetail) {
    this.#opts.detail = value
  }

  /**
   * Add one chunk's alignment.
   *
   * `offsetSeconds` is where this chunk begins on the bus playback clock —
   * `AudioBus.enqueue` returns it for exactly this purpose. Character times
   * within a block are chunk-relative, and chunks are scheduled back to back, so
   * without the offset every chunk after the first would drive the mouth with
   * the timings of the one before it.
   *
   * If ElevenLabs is ever found to send utterance-relative times instead, this
   * becomes a one-line change at the call site: pass 0.
   */
  append(alignment: CharAlignment, offsetSeconds: number): void {
    const { chars, charStartTimesMs, charDurationsMs } = alignment

    for (let i = 0; i < chars.length; i++) {
      const hit = classify(chars, i, this.#opts.detail)
      if (!hit) continue

      // A silent cluster consumes its characters and lays down nothing, which is
      // the whole point of it — the k in "know" must not become a /k/.
      if (hit.articulation === null) {
        i += hit.width - 1
        continue
      }

      const startMs = charStartTimesMs[i]
      if (startMs === undefined) continue

      // A digraph spans two characters; its end comes from the last of them.
      const lastIndex = i + hit.width - 1
      const lastStart = charStartTimesMs[lastIndex] ?? startMs
      const lastDuration = charDurationsMs[lastIndex] ?? 0

      const start = offsetSeconds + startMs / 1000
      const end = Math.max(
        offsetSeconds + (lastStart + lastDuration) / 1000,
        start + this.#opts.minArticulationSeconds,
      )

      this.#push({ articulation: hit.articulation, start, end })
      i = lastIndex
    }
  }

  /**
   * The articulation covering `seconds`, or null to let the analyser decide.
   *
   * Spans are appended in time order, so this binary-searches for the last span
   * starting at or before the query and checks whether it is still open. Kept
   * stateless on purpose — a cursor would have to be rewound on every barge-in
   * and replay, and getting that wrong strands the mouth shut.
   */
  articulationAt(seconds: number): Articulation | null {
    let lo = 0
    let hi = this.#spans.length - 1
    let found = -1

    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const span = this.#spans[mid]
      if (span === undefined) break
      if (span.start <= seconds) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }

    if (found === -1) return null
    const span = this.#spans[found]
    if (span === undefined) return null
    return seconds < span.end ? span.articulation : null
  }

  /**
   * Drop everything. Called on barge-in and at end of utterance — stale spans
   * would otherwise drive the mouth partway through the *next* answer, whose
   * playback clock starts from zero again.
   */
  clear(): void {
    this.#spans = []
  }

  /**
   * Merge into the previous span when it is the same articulation and touching,
   * so the double letter in "hammer" is one press rather than two, the silent b
   * in "climb" extends the m instead of re-closing after it, and "little" holds
   * one tongue-tip contact across the tt rather than stuttering.
   */
  #push(span: ArticulationSpan): void {
    const previous = this.#spans[this.#spans.length - 1]
    if (previous && previous.articulation === span.articulation && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end)
      return
    }
    this.#spans.push(span)
  }
}

interface ClassifiedChar {
  /** null means "these characters are silent" — consume them, draw nothing. */
  articulation: Articulation | null
  /** Characters consumed. */
  width: number
}

/** Letters that soften a preceding c or g. */
const SOFTENERS = new Set(['e', 'i', 'y'])

/**
 * Multi-character spellings, longest first.
 *
 * Every one of these exists because the naive per-letter reading is visibly
 * wrong: `ph` would press the lips in the middle of "phone", `th` would tap the
 * tongue behind the teeth instead of between them, and `kn` would put a /k/ at
 * the front of "know" that no listener ever hears.
 *
 * `gh` is the odd one — it maps to nothing at all. It is silent in "night" and
 * "though" and an /f/ in "laugh", and drawing nothing on the rare one is a far
 * cheaper mistake than drawing a hard velar on the common ones.
 */
const CLUSTERS: ReadonlyArray<readonly [string, Articulation | null]> = [
  ['tch', 'CH'],
  ['sch', 'CH'],
  ['th', 'TH'],
  ['ch', 'CH'],
  ['sh', 'CH'],
  ['ph', 'FF'],
  ['wh', 'ou'],
  ['ng', 'nn'],
  ['ck', 'kk'],
  ['qu', 'kk'],
  ['kn', 'nn'],
  ['wr', 'RR'],
  ['gh', null],
]

/** Single letters whose articulation never depends on what follows. */
const LETTERS: Readonly<Record<string, Articulation>> = {
  p: 'PP',
  b: 'PP',
  m: 'PP',
  f: 'FF',
  v: 'FF',
  t: 'DD',
  d: 'DD',
  n: 'nn',
  l: 'nn',
  r: 'RR',
  w: 'ou',
  j: 'CH',
  k: 'kk',
  x: 'kk',
  q: 'kk',
}

/**
 * Which articulation, if any, a character begins.
 *
 * The lip gestures — p/b/m pressed together, f/v tucked under the teeth — are
 * the pair an analyser provably cannot see, so they are taken at every detail
 * level. The tongue gestures are `full` only, because they are the ones English
 * spelling can get wrong.
 *
 * Vowels, h, y, s and z are deliberately absent. The first three carry no
 * reliable shape; s and z belong to the analyser, which hears sibilance directly
 * and is not fooled by the silent s in "island" or the /ʒ/ in "measure".
 */
function classify(chars: string[], index: number, detail: ArticulationDetail): ClassifiedChar | null {
  const c = chars[index]?.toLowerCase()
  if (c === undefined) return null

  for (const [spelling, articulation] of CLUSTERS) {
    if (!matches(chars, index, spelling)) continue
    if (articulation !== null && !allowed(articulation, detail)) break
    return { articulation, width: spelling.length }
  }

  // Soft c is /s/ — the analyser's job. Soft g is /dʒ/, which is the CH shape.
  if (c === 'c' || c === 'g') {
    const soft = SOFTENERS.has(chars[index + 1]?.toLowerCase() ?? '')
    if (c === 'c') return soft ? null : hit('kk', detail)
    return hit(soft ? 'CH' : 'kk', detail)
  }

  const letter = LETTERS[c]
  if (letter === undefined) return null
  return hit(letter, detail)
}

function hit(articulation: Articulation, detail: ArticulationDetail): ClassifiedChar | null {
  return allowed(articulation, detail) ? { articulation, width: 1 } : null
}

/** At `closures` detail only the two lip gestures survive. */
function allowed(articulation: Articulation, detail: ArticulationDetail): boolean {
  if (detail === 'full') return true
  return articulation === 'PP' || articulation === 'FF'
}

function matches(chars: string[], index: number, spelling: string): boolean {
  for (let i = 0; i < spelling.length; i++) {
    if (chars[index + i]?.toLowerCase() !== spelling[i]) return false
  }
  return true
}
