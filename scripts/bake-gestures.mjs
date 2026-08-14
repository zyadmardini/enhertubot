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
 * Two sources, in order of preference:
 *
 *   1. `<id>.alignment.json` beside the MP3 — per-character times captured when
 *      the audio was generated. Exact, and the reason to keep the timestamped
 *      variant of whatever TTS renders the bank.
 *   2. Proportional against the measured duration. No better than what the app
 *      derives at runtime, and offered because it is a starting point a human can
 *      then correct.
 *
 * The second case is the one worth understanding: baking it changes nothing on
 * its own. What it buys is a number sitting in a file that someone can nudge
 * until the gesture lands right, and that then stays nudged. Hand-edited times
 * survive a re-bake unless the answer's text or audio changed — see `stamp`.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FALLBACK_DIR = path.join(ROOT, 'apps/kiosk/public/fallback')
const MANIFEST_PATH = path.join(FALLBACK_DIR, 'manifest.json')

const FORCE = process.argv.includes('--force')

/**
 * Must stay in step with `parseGestureTags` in src/core/gestures.ts.
 *
 * Kept as a copy rather than imported because these scripts run on plain node
 * with no build step. `src/core/__tests__/bake.test.ts` runs the real parser
 * over the committed manifest and fails if the two ever disagree, so the
 * duplication is checked rather than trusted.
 */
const GESTURE_NAMES = ['wave', 'bye', 'point', 'present', 'shrug', 'nod', 'shake', 'think']
const EXPRESSION_NAMES = ['happy', 'confused', 'surprised', 'sorry']
const TAG_PATTERN = /\[([a-z_]+)(\?)?\]/gi

function parseTags(text) {
  const cues = []
  let clean = ''
  let lastIndex = 0

  const append = (chunk) => {
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
    if (GESTURE_NAMES.includes(token)) {
      cues.push({ kind: 'gesture', name: token, charIndex: clean.length, optional })
    } else if (EXPRESSION_NAMES.includes(token)) {
      cues.push({ kind: 'expression', name: token, charIndex: clean.length })
    } else {
      append(match[0])
    }
  }
  append(text.slice(lastIndex))

  clean = clean.replace(/[ \t]+$/, '')
  for (const cue of cues) cue.charIndex = Math.min(cue.charIndex, clean.length)
  return { clean, cues }
}

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
 * Audio time for a character position.
 *
 * With alignment, the answer is looked up directly. Without it, the character
 * position is scaled across the measured duration — which is honest about being
 * a straight-line guess, and is the number a human then corrects by ear.
 */
function timeFor(charIndex, totalChars, duration, alignment) {
  if (alignment) {
    const starts = alignment.charStartTimesMs
    const index = Math.min(charIndex, starts.length - 1)
    const ms = starts[index]
    if (typeof ms === 'number') return ms / 1000
  }
  if (totalChars === 0) return 0
  return (charIndex / totalChars) * duration
}

/** Cheap staleness key: re-bake when the words or the recording changed. */
const stampOf = (answer, bytes) => `${answer.length}:${bytes}`

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
  if (!alignment) untimed += 1

  entry.cues = cues.map((cue) => {
    const atSeconds = Number(
      timeFor(cue.charIndex, clean.length, duration, alignment).toFixed(3),
    )
    return cue.kind === 'expression'
      ? { kind: 'expression', name: cue.name, atSeconds }
      : { kind: 'gesture', name: cue.name, atSeconds, ...(cue.optional ? { optional: true } : {}) }
  })
  entry.cuesStamp = stamp
  entry.alignmentFile = alignment ? `${entry.id}.alignment.json` : undefined
  if (!entry.alignmentFile) delete entry.alignmentFile

  baked += 1
  const source = alignment ? 'alignment' : 'proportional'
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
    `\n  ${untimed} answer(s) had no alignment file and were timed proportionally.\n` +
      '  That is a straight-line guess across the recording, not a measurement —\n' +
      '  it matches what the app already infers at runtime. To improve on it,\n' +
      '  either render with a timestamped TTS and drop <id>.alignment.json beside\n' +
      '  the MP3, or edit the atSeconds values in the manifest by ear. Hand edits\n' +
      '  survive re-baking unless the answer text or its audio changes.\n',
  )
}
