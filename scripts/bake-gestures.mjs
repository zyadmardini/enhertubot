#!/usr/bin/env node
/**
 * Resolve each answer's inline tags to audio times, offline, and write them into
 * the manifest as a `cues` track.
 *
 *   npm run bake:gestures            # bake anything new or stale
 *   npm run bake:gestures -- --force # re-bake everything, discarding hand edits
 *
 * Why this exists at all, given the app can already place a tag from its
 * character position: because the runtime's only input is "how many characters
 * in, out of how many" and no real sentence is spoken at a constant rate. The
 * pause before a punchline, the extra beat on a list — those move a gesture by a
 * few hundred milliseconds, which is exactly enough for a wave to land after the
 * word it belongs to.
 *
 * Three sources, in order of preference:
 *
 *   1. `<id>.phones.json` beside the MP3 — word boundaries measured against the
 *      recording by a forced aligner, written by `npm run bake:visemes`. A cue
 *      belongs to a word, not to a character offset, so this is the source that
 *      matches the question being asked.
 *   2. `<id>.alignment.json` — per-character times captured when the audio was
 *      generated, if the TTS reported them.
 *   3. Proportional against the measured duration. No better than what the app
 *      derives at runtime, and offered because it is a starting point a human can
 *      then correct.
 *
 * The last case is the one worth understanding: baking it changes nothing on
 * its own. What it buys is a number sitting in a file that someone can nudge
 * until the gesture lands right, and that then stays nudged. Hand-edited times
 * survive a re-bake unless the answer's text or audio changed — see `stampOf`.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTags, stampOf } from './lib/tags.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FALLBACK_DIR = path.join(ROOT, 'apps/kiosk/public/fallback')
const MANIFEST_PATH = path.join(FALLBACK_DIR, 'manifest.json')

const FORCE = process.argv.includes('--force')

/* ── MP3 duration ─────────────────────────────────────────────────────────── */

const MPEG1_RATES = [44100, 48000, 32000]
const MPEG2_RATES = [22050, 24000, 16000]
const MPEG25_RATES = [11025, 12000, 8000]
// Layer III only — the bank is MP3 and nothing here needs to read a Layer II file.
const L3_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const L3_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]

/**
 * Duration in seconds, by walking every frame header.
 *
 * Counting frames rather than dividing file size by bitrate, because a VBR
 * encode makes that division wrong by whatever the encoder felt like — and being
 * wrong about total duration scales every cue in the answer.
 */
function mp3Duration(buffer) {
  let offset = 0

  // ID3v2 header: 'ID3', 2 version bytes, flags, then a syncsafe 28-bit size.
  if (buffer.length > 10 && buffer.toString('latin1', 0, 3) === 'ID3') {
    const size =
      ((buffer[6] & 0x7f) << 21) |
      ((buffer[7] & 0x7f) << 14) |
      ((buffer[8] & 0x7f) << 7) |
      (buffer[9] & 0x7f)
    offset = 10 + size
  }

  let seconds = 0
  let frames = 0

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) {
      offset += 1
      continue
    }

    const versionBits = (buffer[offset + 1] >> 3) & 0x03
    const layerBits = (buffer[offset + 1] >> 1) & 0x03
    const bitrateIndex = (buffer[offset + 2] >> 4) & 0x0f
    const rateIndex = (buffer[offset + 2] >> 2) & 0x03
    const padding = (buffer[offset + 2] >> 1) & 0x01

    // versionBits 01 is reserved; layerBits 01 is Layer III and all we handle.
    if (versionBits === 0x01 || layerBits !== 0x01 || bitrateIndex === 0 || bitrateIndex === 0x0f || rateIndex === 0x03) {
      offset += 1
      continue
    }

    const mpeg1 = versionBits === 0x03
    const rates = mpeg1 ? MPEG1_RATES : versionBits === 0x02 ? MPEG2_RATES : MPEG25_RATES
    const sampleRate = rates[rateIndex]
    const bitrate = (mpeg1 ? L3_BITRATES_V1 : L3_BITRATES_V2)[bitrateIndex] * 1000
    const samples = mpeg1 ? 1152 : 576
    const length = Math.floor((samples / 8) * (bitrate / sampleRate)) + padding
    if (length <= 0) {
      offset += 1
      continue
    }

    seconds += samples / sampleRate
    frames += 1
    offset += length
  }

  return frames > 0 ? seconds : null
}

/* ── Timing ───────────────────────────────────────────────────────────────── */

/**
 * How many words start before `charIndex`.
 *
 * Tokenised the same way `scripts/align/align.py` tokenises the text it aligned,
 * because the answer this feeds is an index into that aligner's word list. The
 * two splitting on different rules is a class of bug that shows up as every cue
 * in one answer being one word out.
 */
function wordIndexAt(clean, charIndex) {
  const pattern = /[a-z']+/g
  const text = clean.toLowerCase().replace(/[—–-]/g, ' ')
  let index = 0
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match.index >= charIndex) break
    if (match[0].replace(/'/g, '').length > 0) index += 1
  }
  return index
}

/**
 * Audio time for a character position, from the best source that has one.
 *
 * Word boundaries first: a `[point]` belongs before a word, and a forced aligner
 * says exactly when that word starts. Character times next. Failing both, the
 * character position is scaled across the measured duration — honest about being
 * a straight-line guess, and the number a human then corrects by ear.
 */
function timeFor(charIndex, clean, duration, alignment, phones) {
  const words = phones?.words
  if (Array.isArray(words) && words.length > 0) {
    const index = wordIndexAt(clean, charIndex)
    // A cue past the last word belongs at the end of the audio, not at the start
    // of the word before it.
    const word = words[index]
    if (word) return word.start
    return words[words.length - 1]?.end ?? duration
  }

  if (alignment) {
    const starts = alignment.charStartTimesMs
    const index = Math.min(charIndex, starts.length - 1)
    const ms = starts[index]
    if (typeof ms === 'number') return ms / 1000
  }

  if (clean.length === 0) return 0
  return (charIndex / clean.length) * duration
}

/* ── Run ──────────────────────────────────────────────────────────────────── */

if (!existsSync(MANIFEST_PATH)) {
  console.error(`✗ No manifest at ${path.relative(ROOT, MANIFEST_PATH)}. Render the bank first.`)
  process.exit(1)
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
const entries = [...(manifest.answers ?? []), manifest.refusalFallback].filter(Boolean)

let baked = 0
let skipped = 0
let untimed = 0
const problems = []

for (const entry of entries) {
  const { clean, cues } = parseTags(entry.answer ?? '')

  if (cues.length === 0) {
    // Nothing to time. Clear any stale track so a removed tag doesn't keep firing.
    if (entry.cues) delete entry.cues
    if (entry.cuesStamp) delete entry.cuesStamp
    continue
  }

  const audioPath = path.join(FALLBACK_DIR, entry.file ?? '')
  if (!entry.file || !existsSync(audioPath)) {
    problems.push(`"${entry.id}" — no audio at ${entry.file ?? '(unset)'}; cannot time its cues.`)
    continue
  }

  const bytes = statSync(audioPath).size
  const stamp = stampOf(entry.answer, bytes)
  if (!FORCE && entry.cuesStamp === stamp && Array.isArray(entry.cues)) {
    skipped += 1
    continue
  }

  const duration = mp3Duration(await readFile(audioPath))
  if (duration === null) {
    problems.push(`"${entry.id}" — ${entry.file} has no readable MP3 frames.`)
    continue
  }

  const alignPath = path.join(FALLBACK_DIR, `${entry.id}.alignment.json`)
  let alignment = null
  if (existsSync(alignPath)) {
    try {
      alignment = JSON.parse(await readFile(alignPath, 'utf8'))
      if (!Array.isArray(alignment?.charStartTimesMs)) {
        problems.push(`"${entry.id}" — alignment file has no charStartTimesMs array.`)
        alignment = null
      }
    } catch (error) {
      problems.push(`"${entry.id}" — alignment file is not valid JSON: ${error.message}`)
    }
  }

  const phonesPath = path.join(FALLBACK_DIR, `${entry.id}.phones.json`)
  let phones = null
  if (existsSync(phonesPath)) {
    try {
      phones = JSON.parse(await readFile(phonesPath, 'utf8'))
      if (!Array.isArray(phones?.words) || phones.words.length === 0) {
        problems.push(`"${entry.id}" — phones file has no words array.`)
        phones = null
      }
    } catch (error) {
      problems.push(`"${entry.id}" — phones file is not valid JSON: ${error.message}`)
    }
  }
  if (!alignment && !phones) untimed += 1

  entry.cues = cues.map((cue) => {
    const atSeconds = Number(timeFor(cue.charIndex, clean, duration, alignment, phones).toFixed(3))
    return cue.kind === 'expression'
      ? { kind: 'expression', name: cue.name, atSeconds }
      : { kind: 'gesture', name: cue.name, atSeconds, ...(cue.optional ? { optional: true } : {}) }
  })
  entry.cuesStamp = stamp
  entry.alignmentFile = alignment ? `${entry.id}.alignment.json` : undefined
  if (!entry.alignmentFile) delete entry.alignmentFile

  baked += 1
  const source = phones ? 'word boundaries' : alignment ? 'alignment' : 'proportional'
  console.log(
    `  ${entry.id.padEnd(20)} ${String(cues.length).padStart(2)} cue(s)  ` +
      `${duration.toFixed(2)}s  (${source})`,
  )
}

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  • ${problem}`)
  console.error('')
  process.exit(1)
}

await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(`\n✓ Baked ${baked} answer(s)${skipped > 0 ? `, ${skipped} already current` : ''}.`)
if (untimed > 0) {
  console.log(
    `\n  ${untimed} answer(s) had no timings to work from and were timed proportionally.\n` +
      '  That is a straight-line guess across the recording, not a measurement —\n' +
      '  it matches what the app already infers at runtime. To improve on it, run\n' +
      '  `npm run bake:visemes`, which force-aligns each recording against its\n' +
      '  script and writes the word boundaries this step prefers. Failing that,\n' +
      '  edit the atSeconds values in the manifest by ear: hand edits survive\n' +
      '  re-baking unless the answer text or its audio changes.\n',
  )
}
