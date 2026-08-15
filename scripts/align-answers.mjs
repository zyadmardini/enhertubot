#!/usr/bin/env node
/**
 * Force-align every pre-rendered answer against its script, offline, and write
 * the phone timings beside its MP3.
 *
 *   npm run bake:visemes                        # anything new or stale
 *   npm run bake:visemes -- --force             # everything, again
 *   npm run bake:visemes -- --backend mfa       # with Montreal Forced Aligner
 *
 * This is the step that makes the mouth articulate rather than approximate.
 *
 * At runtime the kiosk has two sources for mouth shape and both are inferences.
 * The analyser reads band energy, which orders the vowels correctly and is blind
 * to every consonant that is quiet — which is most of them. Character alignment
 * reads the spelling, which knows "phone" starts with an /f/ but has to guess at
 * "though", and only ever arrives from a vendor that ships per-character times.
 * The cached bank ships none, so on the shipping driver the mouth is the
 * analyser alone.
 *
 * A forced aligner removes the inference. Given audio and the words in it, it
 * runs an acoustic model constrained to that word sequence and reports where
 * each phone actually starts and ends. The output is not a better guess — it is
 * a measurement, and it covers exactly the consonants neither runtime source can
 * see. See docs/forced-alignment.md for what the alternatives were.
 *
 * The result is committed as `<id>.phones.json`, so nothing about a clone, a
 * build or the running kiosk needs Python. Only re-baking does.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseTags, stampOf } from './lib/tags.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FALLBACK_DIR = path.join(ROOT, 'apps/kiosk/public/fallback')
const MANIFEST_PATH = path.join(FALLBACK_DIR, 'manifest.json')
const LEXICON_PATH = path.join(ROOT, 'content/lexicon.txt')
const ALIGNER = path.join(ROOT, 'scripts/align/align.py')

const args = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const FORCE = args.includes('--force')
const BACKEND = flag('backend', 'pocketsphinx')
const PYTHON = flag('python', process.env.PYTHON ?? 'python3')

/** Times are written to the millisecond. Finer than that is noise from a 10ms model. */
const round = (value) => Number(value.toFixed(3))

/* ── Run the aligner ──────────────────────────────────────────────────────── */

function align(spec) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [ALIGNER], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''

    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `${PYTHON} not found. The aligner is a Python script — install its ` +
                'dependencies with:\n    pip install -r scripts/align/requirements.txt',
            )
          : error,
      )
    })
    child.on('close', (code) => {
      let parsed = null
      try {
        parsed = JSON.parse(out)
      } catch {
        // Falls through to the error below: a non-JSON stdout means the aligner
        // died before it could report anything, and its stderr is the real news.
      }
      if (parsed?.error) return reject(new Error(parsed.error))
      if (code !== 0 || !parsed) {
        return reject(new Error(err.trim() || `aligner exited ${code} with no output`))
      }
      resolve(parsed)
    })

    child.stdin.end(JSON.stringify(spec))
  })
}

/* ── Collect the work ─────────────────────────────────────────────────────── */

if (!existsSync(MANIFEST_PATH)) {
  console.error(`✗ No manifest at ${path.relative(ROOT, MANIFEST_PATH)}. Render the bank first.`)
  process.exit(1)
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'))
const entries = [...(manifest.answers ?? []), manifest.refusalFallback].filter(Boolean)

const jobs = []
const byId = new Map()
const problems = []
let skipped = 0

for (const entry of entries) {
  const { clean } = parseTags(entry.answer ?? '')
  const audioPath = path.join(FALLBACK_DIR, entry.file ?? '')

  if (!entry.file || !existsSync(audioPath)) {
    problems.push(`"${entry.id}" — no audio at ${entry.file ?? '(unset)'}; nothing to align.`)
    continue
  }
  if (!clean.trim()) {
    problems.push(`"${entry.id}" — no answer text; nothing to align it against.`)
    continue
  }

  const stamp = stampOf(entry.answer, statSync(audioPath).size)
  const sidecar = path.join(FALLBACK_DIR, `${entry.id}.phones.json`)
  if (!FORCE && entry.phonesStamp === stamp && existsSync(sidecar)) {
    skipped += 1
    continue
  }

  byId.set(entry.id, { entry, stamp })
  jobs.push({ id: entry.id, audio: audioPath, text: clean })
}

if (jobs.length === 0) {
  console.log(
    problems.length > 0
      ? '\nNothing alignable.'
      : `\n✓ Nothing to do — ${skipped} answer(s) already aligned.`,
  )
  if (problems.length === 0) process.exit(0)
}

/* ── Align ────────────────────────────────────────────────────────────────── */

let response = { results: [], problems: [] }
if (jobs.length > 0) {
  console.log(`\nAligning ${jobs.length} answer(s) with ${BACKEND}…\n`)
  try {
    response = await align({
      jobs,
      backend: BACKEND,
      lexicon: existsSync(LEXICON_PATH) ? LEXICON_PATH : null,
      textgridDir: flag('textgrid-dir'),
      mfaBin: flag('mfa-bin'),
      acousticModel: flag('mfa-acoustic'),
      dictionaryModel: flag('mfa-dictionary'),
    })
  } catch (error) {
    console.error(`\n✗ ${error.message}\n`)
    process.exit(1)
  }
}

problems.push(...(response.problems ?? []))

/* ── Write the sidecars ───────────────────────────────────────────────────── */

let written = 0

for (const result of response.results ?? []) {
  const known = byId.get(result.id)
  if (!known) continue

  const phones = (result.phones ?? []).map((span) => ({
    p: span.p,
    start: round(span.start),
    end: round(span.end),
  }))
  if (phones.length === 0) {
    problems.push(`"${result.id}" — the aligner returned no phones.`)
    continue
  }

  // Speech as a share of the clip. A low number is the signal that something is
  // wrong in a way the timings alone will not show: the wrong MP3, a script that
  // does not match the recording, or an aligner that gave up and called most of
  // the answer silence.
  const spoken = phones
    .filter((span) => span.p !== 'SIL')
    .reduce((total, span) => total + (span.end - span.start), 0)
  const coverage = spoken / Math.max(0.001, result.durationSeconds)
  if (coverage < 0.4) {
    problems.push(
      `"${result.id}" — only ${(coverage * 100).toFixed(0)}% of the clip aligned to speech. ` +
        'Check that the manifest text matches the recording.',
    )
  }

  const sidecar = {
    _comment:
      'Phone timings measured against the recording by a forced aligner, written by ' +
      '`npm run bake:visemes`. The kiosk maps these to mouth shapes at runtime — see ' +
      'apps/kiosk/src/audio/visemes.ts — so the mapping stays tunable without re-aligning. ' +
      'Committed for the same reason manifest.json is: it is what the app actually reads, ' +
      'and re-deriving it needs Python and the audio. Re-render the MP3 and this goes stale; ' +
      'the bake tracks that with phonesStamp in the manifest.',
    version: 1,
    aligner: result.aligner,
    alphabet: result.alphabet,
    durationSeconds: round(result.durationSeconds),
    words: (result.words ?? []).map((span) => ({
      w: span.w,
      start: round(span.start),
      end: round(span.end),
    })),
    phones,
  }

  await writeFile(
    path.join(FALLBACK_DIR, `${result.id}.phones.json`),
    `${JSON.stringify(sidecar, null, 2)}\n`,
    'utf8',
  )

  known.entry.phonesFile = `${result.id}.phones.json`
  known.entry.phonesStamp = known.stamp
  written += 1

  const shapes = phones.filter((span) => span.p !== 'SIL').length
  console.log(
    `  ${result.id.padEnd(20)} ${String(shapes).padStart(3)} phones  ` +
      `${result.durationSeconds.toFixed(2)}s  ${(coverage * 100).toFixed(0)}% speech  ` +
      `(${result.aligner})`,
  )
}

// An answer that failed to align must not keep pointing at a sidecar describing
// audio it no longer matches — the mouth would articulate last week's recording.
for (const [id, { entry }] of byId) {
  if (response.results?.some((result) => result.id === id)) continue
  delete entry.phonesFile
  delete entry.phonesStamp
}

if (written > 0) {
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

if (problems.length > 0) {
  console.error(`\n✗ ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  • ${problem}`)
  console.error('')
  process.exit(1)
}

console.log(
  `\n✓ Aligned ${written} answer(s)${skipped > 0 ? `, ${skipped} already current` : ''}.\n` +
    '  Re-run `npm run bake:gestures` if any answer changed: gesture times are\n' +
    '  read from these word boundaries when they exist.\n',
)
