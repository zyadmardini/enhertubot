import { Emitter } from './emitter.ts'
import { jitter as jitterBy, seededRng } from './random.ts'
import type { Rng } from './random.ts'
import { EXPRESSION_NAMES, GESTURE_NAMES } from './types.ts'
import type { ExpressionName, GestureName } from './types.ts'

/**
 * Any `[token]`, recognised or not. Narrowing this to the known vocabulary would
 * be tidier but silently swallows a typo — `[shurg]` would reach TTS and be read
 * aloud to a visitor. Matching everything and putting back what we don't know
 * means an unrecognised tag survives into the captions, where it is visible.
 */
const TAG_PATTERN = /\[([a-z_]+)(\?)?\]/gi

export interface GestureTag {
  name: GestureName
  /** Index into the *cleaned* text where the tag sat. */
  charIndex: number
  /** Authored as `[nod?]` — a beat that may be skipped for variety. */
  optional: boolean
}

export interface ExpressionTag {
  name: ExpressionName
  charIndex: number
}

export interface ParsedText {
  /** Text with tags stripped. This is what goes to TTS — never the raw text. */
  clean: string
  tags: GestureTag[]
  expressions: ExpressionTag[]
}

/**
 * Pull `[wave]`-style tags out of an answer.
 *
 * charIndex is measured against the cleaned text so it can be converted to an
 * audio timestamp later: the TTS never sees the tags, so raw-text offsets would
 * drift further out of alignment with every tag in the sentence.
 */
export function parseGestureTags(text: string): ParsedText {
  const tags: GestureTag[] = []
  const expressions: ExpressionTag[] = []
  let clean = ''
  let lastIndex = 0

  // A tag usually sits mid-sentence with a space either side, so removing it
  // leaves a double space. Collapsing that has to happen as the string is built,
  // not afterwards: a later cleanup pass would shift every index already
  // recorded, firing each subsequent gesture progressively early.
  const append = (chunk: string): void => {
    let next = chunk.replace(/[ \t]{2,}/g, ' ')
    if (clean.length === 0 || /[ \t]$/.test(clean)) next = next.replace(/^[ \t]+/, '')
    clean += next
  }

  TAG_PATTERN.lastIndex = 0
  for (let match = TAG_PATTERN.exec(text); match !== null; match = TAG_PATTERN.exec(text)) {
    append(text.slice(lastIndex, match.index))
    lastIndex = match.index + match[0].length

    const token = match[1]?.toLowerCase()
    const optional = match[2] === '?'

    if (token && (GESTURE_NAMES as readonly string[]).includes(token)) {
      tags.push({ name: token as GestureName, charIndex: clean.length, optional })
    } else if (token && (EXPRESSION_NAMES as readonly string[]).includes(token)) {
      expressions.push({ name: token as ExpressionName, charIndex: clean.length })
    } else {
      // Not ours. Put it back verbatim so it shows up in the captions rather
      // than vanishing into a gesture that never fires.
      append(match[0])
    }
  }
  append(text.slice(lastIndex))

  // Only trailing whitespace is left to trim, which can't move an earlier index —
  // but a tag placed after the final word can land past the end, so clamp.
  clean = clean.replace(/[ \t]+$/, '')
  for (const tag of tags) tag.charIndex = Math.min(tag.charIndex, clean.length)
  for (const tag of expressions) tag.charIndex = Math.min(tag.charIndex, clean.length)

  return { clean, tags, expressions }
}

/**
 * A cue with its audio time already resolved offline.
 *
 * This is what `scripts/bake-gestures.mjs` writes into the answer manifest, and
 * it is strictly better than anything derivable at runtime: the bake has the
 * rendered audio in hand, so `atSeconds` is measured rather than estimated from
 * a character rate that no real sentence obeys.
 */
export type BakedCue =
  | { kind: 'gesture'; name: GestureName; atSeconds: number; optional?: boolean }
  /** Never optional — dropping one leaves the wrong face on for the rest of the line. */
  | { kind: 'expression'; name: ExpressionName; atSeconds: number }

export type BakedTrack = readonly BakedCue[]

interface SchedulerEvents extends Record<string, unknown> {
  fire: GestureName
  express: ExpressionName
}

type QueuedCue =
  | { kind: 'gesture'; name: GestureName; atSeconds: number; fired: boolean }
  | { kind: 'expression'; name: ExpressionName; atSeconds: number; fired: boolean }

export interface SchedulerOptions {
  /** Fire this far ahead of the clause. Anticipation is what makes it read as intent. */
  leadSeconds: number
  /** Used to place tags before real audio duration is known. */
  charsPerSecond: number
  /**
   * ± spread applied to every fire time.
   *
   * Small on purpose. This is not "randomise the performance" — it is enough
   * wobble that two plays of the same cached answer don't land on the identical
   * frame, which is the tell that makes a kiosk read as a recording.
   */
  jitterSeconds?: number
  /** Chance an `[x?]` beat plays at all. Rolled once, at schedule time. */
  optionalChance?: number
  /** Seed the variation. Omit for a fresh stream per scheduler. */
  rng?: Rng
}

/**
 * Turns cue positions into a queue checked against audio playback position.
 *
 * Scheduling against playback time rather than wall-clock is what keeps gestures
 * aligned when audio buffers late or the stream stalls.
 *
 * Two ways in. `schedule()` takes parsed text and estimates from a character
 * rate, which is all a live route can do before its audio exists. `scheduleBaked()`
 * takes times measured offline against the actual recording — the cached path,
 * and the accurate one.
 */
export class GestureScheduler extends Emitter<SchedulerEvents> {
  #queue: QueuedCue[] = []
  #opts: SchedulerOptions
  #rng: Rng
  #totalChars = 0
  /** Baked times are already real; rescaling them against duration would skew them. */
  #baked = false

  constructor(opts: SchedulerOptions) {
    super()
    this.#opts = opts
    this.#rng = opts.rng ?? seededRng((Math.random() * 0xffffffff) >>> 0)
  }

  get pending(): number {
    return this.#queue.filter((cue) => !cue.fired).length
  }

  /**
   * Reseed for the next utterance.
   *
   * Called with a per-turn seed so the same answer varies between plays while
   * staying reproducible from that seed. Only meaningful between utterances —
   * reseeding mid-playback would re-roll cues already placed.
   */
  reseed(seed: number): void {
    this.#rng = seededRng(seed)
  }

  /** Queue a parsed utterance. Call once per answer, before playback starts. */
  schedule(parsed: ParsedText): void {
    this.#totalChars = parsed.clean.length
    this.#baked = false
    const secondsPerChar = 1 / this.#opts.charsPerSecond

    for (const tag of parsed.tags) {
      if (!this.#rollOptional(tag.optional)) continue
      this.#push({
        kind: 'gesture',
        name: tag.name,
        atSeconds: this.#place(tag.charIndex * secondsPerChar),
        fired: false,
      })
    }
    for (const tag of parsed.expressions) {
      this.#push({
        kind: 'expression',
        name: tag.name,
        // Expressions are a held state, not a beat — leading one would put the
        // face on before the clause that justifies it. Placed on the clause.
        atSeconds: Math.max(0, tag.charIndex * secondsPerChar),
        fired: false,
      })
    }
    this.#sort()
  }

  /**
   * Queue cues whose audio times were resolved offline.
   *
   * The lead and the jitter still apply — those are performance, not timing
   * error, and baking them in would freeze the variation into the asset.
   */
  scheduleBaked(track: BakedTrack): void {
    this.#totalChars = 0
    this.#baked = true

    for (const cue of track) {
      if (cue.kind === 'expression') {
        this.#push({ kind: 'expression', name: cue.name, atSeconds: Math.max(0, cue.atSeconds), fired: false })
        continue
      }
      if (!this.#rollOptional(cue.optional === true)) continue
      this.#push({
        kind: 'gesture',
        name: cue.name,
        atSeconds: this.#place(cue.atSeconds),
        fired: false,
      })
    }
    this.#sort()
  }

  /**
   * Re-time the queue once the real audio duration is known, which the estimate
   * from charsPerSecond can miss by several hundred milliseconds on a long answer.
   * Safe to call mid-playback; already-fired cues are left alone.
   *
   * A no-op on a baked track, whose times came from the recording in the first
   * place — rescaling those would take a correct number and make it wrong.
   */
  calibrate(actualDurationSeconds: number): void {
    if (this.#baked) return
    if (this.#totalChars === 0 || actualDurationSeconds <= 0) return
    const estimated = this.#totalChars / this.#opts.charsPerSecond
    if (estimated <= 0) return
    const scale = actualDurationSeconds / estimated
    const lead = this.#opts.leadSeconds
    for (const cue of this.#queue) {
      if (cue.fired) continue
      // Expressions were never led, so scaling them back through the lead would
      // shift them by a lead they never had.
      const applied = cue.kind === 'gesture' ? lead : 0
      cue.atSeconds = Math.max(0, (cue.atSeconds + applied) * scale - applied)
    }
  }

  /** Call every frame with the audio element / bus playback position. */
  update(playbackSeconds: number): void {
    for (const cue of this.#queue) {
      if (cue.fired || cue.atSeconds > playbackSeconds) continue
      cue.fired = true
      if (cue.kind === 'gesture') this.emit('fire', cue.name)
      else this.emit('express', cue.name)
    }
  }

  /**
   * Drop everything pending. Called on barge-in so Enubot never finishes a wave
   * for a sentence it stopped saying.
   */
  flush(): void {
    this.#queue = []
    this.#totalChars = 0
    this.#baked = false
  }

  /** Lead, jitter, clamp. The one place a gesture's final time is decided. */
  #place(clauseSeconds: number): number {
    const spread = this.#opts.jitterSeconds ?? 0
    const wobble = spread > 0 ? jitterBy(this.#rng, spread) : 0
    return Math.max(0, clauseSeconds - this.#opts.leadSeconds + wobble)
  }

  /**
   * Rolled here rather than at fire time so `pending` is honest and a barge-in
   * mid-answer doesn't re-roll what was already decided.
   */
  #rollOptional(optional: boolean): boolean {
    if (!optional) return true
    return this.#rng() < (this.#opts.optionalChance ?? 0.5)
  }

  #push(cue: QueuedCue): void {
    this.#queue.push(cue)
  }

  #sort(): void {
    this.#queue.sort((a, b) => a.atSeconds - b.atSeconds)
  }
}
