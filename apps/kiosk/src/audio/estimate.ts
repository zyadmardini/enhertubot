import type { CharAlignment } from './alignment.ts'

/**
 * Character timings estimated from audio that did not come with any.
 *
 * The cached answers are pre-rendered MP3s whose script we know exactly and whose
 * timings we know not at all. Spreading the characters evenly over the duration —
 * which is what `linearAlignment` does — gets the first syllable right and drifts
 * from there: it puts articulations inside pauses, holds the lips shut through
 * silence, and by the end of a sentence is a syllable or more out. It also
 * changes shape at a flat character rate, around 14 times a second, where real
 * speech changes about 5 to 8 times. That combination is what reads as jitter.
 *
 * This is the cheap fix for both: let the text say *what* the shapes are and let
 * the audio say *when*.
 *
 * Two ideas, neither novel:
 *
 *  1. **Characters are not equally long.** A vowel is held, a plosive is a burst,
 *     and a full stop is a pause with no character in it at all. Weighting them
 *     by expected duration is the same duration modelling any TTS front end does,
 *     just crude.
 *  2. **Warp those weights onto the clip's energy.** Walk the cumulative energy
 *     curve rather than the clock, so a character advances when the audio does.
 *     Silence carries no energy, so nothing is placed inside it; a held vowel
 *     carries a lot, so it gets the time it deserves.
 *
 * What this is not is forced alignment. A real aligner (Montreal Forced Aligner,
 * Gentle, whisper-timestamped) runs an acoustic model over the audio and gives
 * per-phoneme boundaries that are correct rather than merely plausible. That is
 * the right answer for a **pre-rendered** bank, and it belongs offline in a bake
 * step writing `alignmentFile` into the manifest — the field already exists and
 * the driver already reads it. This estimate is for the case that cannot be
 * baked, and for judging the mouth before anyone commits to a voice.
 */

export interface EstimateOptions {
  /** Envelope resolution, Hz. 100 gives 10ms hops, finer than any viseme needs. */
  envelopeHz: number
  /**
   * Fraction of peak amplitude below which audio counts as silence.
   *
   * Silence contributes no energy, so no character is placed in it. Set this too
   * low and room tone starts absorbing syllables; too high and quiet consonants
   * get skipped over.
   */
  silenceFloor: number
  /**
   * Ceiling on one character's span, seconds.
   *
   * Backstop for the case energy warping cannot fix: if a clip opens with two
   * seconds of near-silence, the first character would otherwise be stretched
   * across all of it and a /p/ would hold the lips shut for two seconds.
   */
  maxCharSeconds: number
}

export const DEFAULT_ESTIMATE: EstimateOptions = {
  envelopeHz: 100,
  silenceFloor: 0.06,
  maxCharSeconds: 0.22,
}

/**
 * Expected relative duration per character.
 *
 * Rough on purpose — the energy warp does the real work and these only decide how
 * the weight is shared out inside a burst of sound. The numbers that matter are
 * the punctuation ones: a full stop has to be heavy enough to absorb a sentence
 * gap, or the characters on either side stretch across it and articulate through
 * the pause.
 */
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u', 'y'])
const PLOSIVES = new Set(['p', 'b', 't', 'd', 'k', 'g'])

function weightOf(char: string): number {
  const c = char.toLowerCase()
  if (c === ' ') return 1.2
  if (c === ',' || c === ';' || c === ':') return 2
  if (c === '.' || c === '!' || c === '?') return 3.5
  if (c === '-' || c === '—') return 0.6
  if (VOWELS.has(c)) return 1.3
  if (PLOSIVES.has(c)) return 0.7
  if (c >= 'a' && c <= 'z') return 0.9
  return 0.4
}

/**
 * Estimate character timings for `text` against `buffer`.
 *
 * Falls back to even spacing when the clip carries no energy at all, which is the
 * only case the warp cannot describe.
 */
export function estimateAlignment(
  buffer: AudioBuffer,
  text: string,
  opts: EstimateOptions = DEFAULT_ESTIMATE,
): CharAlignment {
  const chars = [...text]
  if (chars.length === 0) return { chars, charStartTimesMs: [], charDurationsMs: [] }

  const { times, cumulative } = energyCurve(buffer, opts)
  const total = cumulative[cumulative.length - 1] ?? 0
  if (total <= 0) return linear(chars, buffer.duration)

  // Cumulative character weight, normalised, with a leading 0 so index i reads
  // the fraction of the utterance completed *before* character i.
  const weights = chars.map(weightOf)
  const weightTotal = weights.reduce((sum, w) => sum + w, 0)
  const boundaries: number[] = [0]
  let running = 0
  for (const w of weights) {
    running += w
    boundaries.push(running / weightTotal)
  }

  const charStartTimesMs: number[] = []
  const charDurationsMs: number[] = []
  for (let i = 0; i < chars.length; i++) {
    const start = timeAtEnergy(times, cumulative, total * (boundaries[i] ?? 0))
    const end = timeAtEnergy(times, cumulative, total * (boundaries[i + 1] ?? 1))
    charStartTimesMs.push(start * 1000)
    charDurationsMs.push(Math.min(Math.max(0, end - start), opts.maxCharSeconds) * 1000)
  }

  return { chars, charStartTimesMs, charDurationsMs }
}

interface EnergyCurve {
  /** Frame start times, seconds. */
  times: number[]
  /** Cumulative energy at each frame boundary. One longer than `times`. */
  cumulative: number[]
}

/**
 * Cumulative RMS energy over the clip, with everything below the floor treated
 * as exactly zero so silence cannot slowly accumulate its way through a syllable.
 */
function energyCurve(buffer: AudioBuffer, opts: EstimateOptions): EnergyCurve {
  const samples = buffer.getChannelData(0)
  const hop = Math.max(1, Math.floor(buffer.sampleRate / opts.envelopeHz))
  const frames = Math.max(1, Math.ceil(samples.length / hop))

  const rms = new Float32Array(frames)
  let peak = 0
  for (let f = 0; f < frames; f++) {
    const from = f * hop
    const to = Math.min(samples.length, from + hop)
    let sumSquares = 0
    for (let i = from; i < to; i++) {
      const sample = samples[i] ?? 0
      sumSquares += sample * sample
    }
    const value = Math.sqrt(sumSquares / Math.max(1, to - from))
    rms[f] = value
    if (value > peak) peak = value
  }

  const floor = peak * opts.silenceFloor
  const times: number[] = []
  const cumulative: number[] = [0]
  let running = 0
  for (let f = 0; f < frames; f++) {
    times.push((f * hop) / buffer.sampleRate)
    const value = rms[f] ?? 0
    running += value > floor ? value : 0
    cumulative.push(running)
  }
  times.push(buffer.duration)

  return { times, cumulative }
}

/**
 * Invert the cumulative curve: the time by which `target` energy has elapsed.
 *
 * Linear within a frame, which at 10ms hops is finer than the mouth can resolve.
 * Silent stretches are flat in `cumulative`, so a target landing inside one
 * resolves to where the silence began — which is exactly right, and is why no
 * character is ever placed in the middle of a pause.
 */
function timeAtEnergy(times: number[], cumulative: number[], target: number): number {
  let lo = 0
  let hi = cumulative.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((cumulative[mid] ?? 0) < target) lo = mid + 1
    else hi = mid
  }

  const index = Math.max(1, lo)
  const before = cumulative[index - 1] ?? 0
  const after = cumulative[index] ?? before
  const span = after - before
  const fraction = span > 0 ? (target - before) / span : 0

  const start = times[index - 1] ?? 0
  const end = times[index] ?? start
  return start + (end - start) * Math.max(0, Math.min(1, fraction))
}

function linear(chars: string[], durationSeconds: number): CharAlignment {
  const perCharMs = (durationSeconds * 1000) / Math.max(1, chars.length)
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => i * perCharMs),
    charDurationsMs: chars.map(() => perCharMs),
  }
}
