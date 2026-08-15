/**
 * Mouth shape from measured phone boundaries, which is the one source here that
 * is not an inference.
 *
 * The other two both guess, in opposite directions. `LipSync`'s analyser reads
 * band energy: it orders the vowels correctly because that is what the F2:F1
 * ratio is, and it is blind to every consonant that is quiet, which is most of
 * them. `AlignmentTrack` reads the spelling: it knows "phone" opens with an /f/,
 * and it has to guess at "though", "tough" and "through" — and it only exists at
 * all when a vendor ships per-character times, which the pre-rendered bank does
 * not.
 *
 * A forced aligner answers the question both are working around: what sound is
 * happening at 3.47 seconds. Run offline over audio whose script is known, it
 * reports the phone boundaries directly — see `scripts/align-answers.mjs` and
 * `docs/forced-alignment.md`. This turns that file into shapes.
 *
 * Consequences worth naming, because they are the reason to do it:
 *
 *  - **Vowels come from the aligner too.** Alignment deliberately never supplied
 *    one, because letters are a poor guide to vowel sound. Phones are not
 *    letters: `AY` is a diphthong wherever it appears, whether it was spelled
 *    "eye", "I" or "aisle".
 *  - **No rate limiting.** `minVisemeSeconds` exists to stop two unreliable
 *    sources from flickering; these boundaries are measurements, and a 60ms /t/
 *    is a real 60ms /t/. Holding it back would smooth away the articulation this
 *    whole path exists to add.
 *  - **Silence is a shape.** A gap would hand the mouth back to the analyser,
 *    which cannot tell a closed mouth from a pause.
 */

import type { Viseme } from './lipsync.ts'

/** One phone as the aligner measured it. Seconds, on the clip's own clock. */
export interface PhoneSpan {
  /** ARPAbet or IPA, stress marks optional. `SIL` for silence. */
  p: string
  start: number
  end: number
}

/** One word, for the inspector and for timing gestures against real speech. */
export interface WordSpan {
  w: string
  start: number
  end: number
}

/** The `<id>.phones.json` sidecar, as written by `npm run bake:visemes`. */
export interface PhoneTrack {
  version?: number
  /** Which aligner produced it. Recorded so a regression can be attributed. */
  aligner?: string
  alphabet?: string
  durationSeconds?: number
  words?: WordSpan[]
  phones: PhoneSpan[]
}

export interface VisemeSpan {
  viseme: Viseme
  /** Seconds in AudioBus playback space, not clip-relative. */
  start: number
  end: number
}

export interface VisemeTrackOptions {
  /**
   * Shortest a measured viseme may render for.
   *
   * Not a smoothing filter — the shapes and their order are kept exactly. This
   * only guarantees a shape survives long enough to be drawn: a 15ms burst is
   * under a frame at 60fps and can fall between two of them, so the lips would
   * miss a /p/ that the aligner found. Roughly two frames is enough.
   */
  minSpanSeconds: number
}

/**
 * ARPAbet to the OVR viseme set.
 *
 * Stress digits are stripped before lookup, so `AA1` and `AA0` both land here.
 * The consonant rows are the standard grouping — the one every viseme sheet from
 * Preston Blair to `XR_META_face_tracking_visemes` agrees on — because they
 * group by *place of articulation*, which is precisely what a mouth shows.
 *
 * Two entries are worth arguing about. `L` maps to `nn` rather than a shape of
 * its own because from the front an /l/ and an /n/ are the same picture: tongue
 * tip up behind the teeth. And `ER` maps to `RR` even though it is a vowel, for
 * the same reason in reverse — the bunched tongue is the shape, whatever the
 * phonology calls it.
 */
const ARPABET: Readonly<Record<string, Viseme>> = {
  // Vowels, in the F2:F1 order the analyser already sorts them into.
  IY: 'ih',
  IH: 'ih',
  EH: 'E',
  AE: 'aa',
  AA: 'aa',
  AH: 'E',
  AO: 'oh',
  UH: 'ou',
  UW: 'ou',
  ER: 'RR',
  AX: 'E',

  // Consonants, by place.
  P: 'PP',
  B: 'PP',
  M: 'PP',
  F: 'FF',
  V: 'FF',
  TH: 'TH',
  DH: 'TH',
  T: 'DD',
  D: 'DD',
  S: 'SS',
  Z: 'SS',
  N: 'nn',
  L: 'nn',
  SH: 'CH',
  ZH: 'CH',
  CH: 'CH',
  JH: 'CH',
  R: 'RR',
  Y: 'ih',
  W: 'ou',
  K: 'kk',
  G: 'kk',
  NG: 'kk',

  SIL: 'sil',
  SP: 'sil',
  SPN: 'sil',
  NSN: 'sil',
}

/**
 * Diphthongs, as the two shapes they actually are.
 *
 * A diphthong is a glide between two vowel targets, and drawing only the first
 * is why "no" and "gnaw" look identical on a mouth that should visibly round at
 * the end of one of them. Splitting them is the cheapest articulation available
 * here: the aligner gives one span, and the shape has somewhere to travel.
 */
const DIPHTHONGS: Readonly<Record<string, readonly [Viseme, Viseme]>> = {
  AY: ['aa', 'ih'],
  EY: ['E', 'ih'],
  OY: ['oh', 'ih'],
  AW: ['aa', 'ou'],
  OW: ['oh', 'ou'],
}

/**
 * Where a diphthong hands over, as a fraction of its span.
 *
 * Late, because the first target is the one that is held — the glide is the last
 * part of the sound, not half of it.
 */
const GLIDE_AT = 0.62

/**
 * IPA, for aligners that report it.
 *
 * MFA's newer English dictionaries are IPA rather than ARPAbet, and the sidecar
 * records which alphabet it used — but nothing downstream should have to care,
 * so both are read and the file can be regenerated with either without touching
 * a line of app code.
 */
const IPA: Readonly<Record<string, Viseme>> = {
  i: 'ih',
  ɪ: 'ih',
  e: 'E',
  ɛ: 'E',
  æ: 'aa',
  a: 'aa',
  ɑ: 'aa',
  ɒ: 'oh',
  ɔ: 'oh',
  o: 'oh',
  ʊ: 'ou',
  u: 'ou',
  ʌ: 'E',
  ə: 'E',
  ɚ: 'RR',
  ɝ: 'RR',
  ɜ: 'RR',
  p: 'PP',
  b: 'PP',
  m: 'PP',
  f: 'FF',
  v: 'FF',
  θ: 'TH',
  ð: 'TH',
  t: 'DD',
  d: 'DD',
  ɾ: 'DD',
  s: 'SS',
  z: 'SS',
  n: 'nn',
  l: 'nn',
  ɫ: 'nn',
  ʃ: 'CH',
  ʒ: 'CH',
  ɹ: 'RR',
  ɻ: 'RR',
  j: 'ih',
  w: 'ou',
  k: 'kk',
  ɡ: 'kk',
  g: 'kk',
  ŋ: 'kk',
  h: 'E',
  ʔ: 'sil',
}

/** IPA affricates and diphthongs, which arrive as two code points. */
const IPA_CLUSTERS: Readonly<Record<string, Viseme | readonly [Viseme, Viseme]>> = {
  tʃ: 'CH',
  dʒ: 'CH',
  aɪ: ['aa', 'ih'],
  eɪ: ['E', 'ih'],
  ɔɪ: ['oh', 'ih'],
  aʊ: ['aa', 'ou'],
  oʊ: ['oh', 'ou'],
  əʊ: ['oh', 'ou'],
}

/**
 * Phones with no shape of their own.
 *
 * /h/ is a puff of air through whatever the mouth is already doing, so it wears
 * the shape of the vowel after it — "he" and "who" have nothing in common at the
 * lips, and giving /h/ a fixed shape puts a wrong one in front of both. Handled
 * by inheriting rather than by guessing.
 */
const TRANSPARENT = new Set(['HH', 'H', 'ʰ'])

/** `AY1` → `AY`, `ˈɑ` → `ɑ`. */
function bare(phone: string): string {
  return phone.replace(/[0-9ˈˌːˑ]/g, '').trim()
}

/**
 * The shape or shapes a phone draws, or null if it has none.
 *
 * Unknown phones return null rather than a guess. An aligner from outside this
 * repo may use symbols neither table has, and showing the previous shape a beat
 * longer is a smaller error than showing a confidently wrong one.
 */
export function visemesForPhone(phone: string): readonly Viseme[] | null {
  const symbol = bare(phone)
  if (symbol === '') return ['sil']
  if (TRANSPARENT.has(symbol) || TRANSPARENT.has(symbol.toUpperCase())) return null

  const upper = symbol.toUpperCase()
  const diphthong = DIPHTHONGS[upper]
  if (diphthong) return diphthong
  const arpabet = ARPABET[upper]
  if (arpabet) return [arpabet]

  const cluster = IPA_CLUSTERS[symbol]
  if (cluster) return typeof cluster === 'string' ? [cluster] : cluster
  const ipa = IPA[symbol]
  if (ipa) return [ipa]

  // A cluster the table doesn't list, e.g. a length-marked IPA vowel pair: fall
  // back to the first code point, which carries the mouth shape in every case
  // this can reach.
  const first = IPA[[...symbol][0] ?? '']
  return first ? [first] : null
}

/**
 * Measured phone spans, as the shapes to draw.
 *
 * Stateless queries, like `AlignmentTrack` and for the same reason: a cursor
 * would need rewinding on every barge-in and replay, and getting that wrong
 * strands the mouth mid-word.
 */
export class VisemeTrack {
  #spans: VisemeSpan[] = []
  #opts: VisemeTrackOptions

  constructor(opts: VisemeTrackOptions) {
    this.#opts = opts
  }

  get spanCount(): number {
    return this.#spans.length
  }

  /** Every span, for the inspector. Not for the render path — it allocates. */
  get spans(): readonly VisemeSpan[] {
    return this.#spans
  }

  /**
   * Add one clip's phones.
   *
   * `offsetSeconds` is where the clip begins on the bus playback clock, exactly
   * as `AlignmentTrack.append` takes it — `AudioBus.enqueue` returns it, and
   * without it a second clip would drive the mouth with the first one's timings.
   */
  append(track: PhoneTrack, offsetSeconds: number): void {
    const raw: VisemeSpan[] = []
    /** Indices into `raw` that are waiting to inherit a shape. See TRANSPARENT. */
    const pending: number[] = []

    for (const phone of track.phones ?? []) {
      const start = offsetSeconds + phone.start
      const end = offsetSeconds + phone.end
      if (!(end > start)) continue

      const shapes = visemesForPhone(phone.p)
      if (shapes === null) {
        pending.push(raw.length)
        raw.push({ viseme: 'sil', start, end })
        continue
      }

      for (const [index, viseme] of shapes.entries()) {
        // A diphthong hands over inside its own span rather than borrowing time
        // from its neighbours, so the boundaries the aligner measured survive.
        const from = index === 0 ? start : start + (end - start) * GLIDE_AT
        const to = index === 0 && shapes.length > 1 ? start + (end - start) * GLIDE_AT : end
        if (to > from) raw.push({ viseme, start: from, end: to })
      }
    }

    for (const index of pending) {
      const span = raw[index]
      if (!span) continue
      span.viseme = raw[index + 1]?.viseme ?? raw[index - 1]?.viseme ?? 'sil'
    }

    for (const span of merge(enforceMinimum(merge(raw), this.#opts.minSpanSeconds))) {
      this.#push(span)
    }
  }

  /**
   * The shape at `seconds`, or null where the track says nothing.
   *
   * Null means "before this clip, after it, or between two of them" — never
   * "during a pause", which is an explicit `sil`. The caller falls back to the
   * analyser only in the first case, which is what keeps a gap between chunks
   * from freezing the mouth.
   */
  visemeAt(seconds: number): Viseme | null {
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
    return seconds < span.end ? span.viseme : null
  }

  /** Dropped on barge-in and at end of utterance — the clock restarts at zero. */
  clear(): void {
    this.#spans = []
  }

  #push(span: VisemeSpan): void {
    const previous = this.#spans[this.#spans.length - 1]
    if (previous && previous.viseme === span.viseme && span.start <= previous.end + 1e-6) {
      previous.end = Math.max(previous.end, span.end)
      return
    }
    this.#spans.push(span)
  }
}

/** Adjacent runs of the same shape become one span, so a held /s/ is one /s/. */
function merge(spans: VisemeSpan[]): VisemeSpan[] {
  const out: VisemeSpan[] = []
  for (const span of spans) {
    const previous = out[out.length - 1]
    if (previous && previous.viseme === span.viseme && span.start <= previous.end + 1e-6) {
      previous.end = Math.max(previous.end, span.end)
      continue
    }
    out.push({ ...span })
  }
  return out
}

/**
 * Give every shape long enough to be drawn, without reordering any of them.
 *
 * Two rules, and the split between them is the point:
 *
 *  - A **short silence** is deleted. Between two words an aligner marks the stop
 *    closure before a /t/ or /k/ as silence — 20ms of it — and that is not a
 *    pause, it is part of the consonant. Rendering it shuts the mouth mid-word.
 *  - A **short shape** is extended forwards into its neighbour, never backwards.
 *    A consonant that starts early lands on the wrong vowel, which is the exact
 *    failure that reads as "the mouth is out of sync"; one that runs a frame long
 *    reads as nothing at all.
 */
function enforceMinimum(spans: VisemeSpan[], minimum: number): VisemeSpan[] {
  if (minimum <= 0) return spans

  const kept = spans.filter(
    (span, index) =>
      span.viseme !== 'sil' ||
      span.end - span.start >= minimum ||
      // A silence at either end of a clip is a real one however short: there is
      // no neighbouring shape it could be part of.
      index === 0 ||
      index === spans.length - 1,
  )

  for (let i = 0; i < kept.length; i++) {
    const span = kept[i]
    if (!span) continue
    // Close the hole a deleted silence left, so the track stays contiguous and a
    // query can never fall between two spans.
    const next = kept[i + 1]
    if (next && next.start > span.end) span.end = next.start

    if (span.end - span.start >= minimum) continue
    span.end = span.start + minimum
    if (next && next.start < span.end) next.start = span.end
  }

  // A span the growth above pushed past its own end was completely absorbed by
  // the shape before it, which is the honest outcome: there was no room for it.
  return kept.filter((span) => span.end > span.start)
}
