#!/usr/bin/env node
/**
 * Prove the answer cache still agrees with `content/qa.json`.
 *
 * A cached answer that contradicts the live one is worse than having no cache:
 * it is confidently, consistently wrong, and nothing in the running app can
 * detect it — the MP3 plays perfectly, it just says last week's coffee time.
 * The failure is created by an ordinary, reasonable edit (fix a word in qa.json,
 * ship) and it stays invisible until a visitor is standing there. So it gets a
 * check rather than a paragraph in a README.
 *
 *   npm run check:cache
 *
 * What it enforces:
 *   1. Every qa.json answer has a manifest entry, by id, in the same order.
 *   2. The manifest's text, with gesture tags removed, is word-for-word the
 *      qa.json answer — i.e. the recording says what the prompt says.
 *   3. Every referenced MP3 exists and is not a stub.
 *   4. Hotkeys are unique.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QA_PATH = path.join(ROOT, 'content/qa.json')
const FALLBACK_DIR = path.join(ROOT, 'apps/kiosk/public/fallback')
const MANIFEST_PATH = path.join(FALLBACK_DIR, 'manifest.json')

/** Anything smaller than this is a truncated download, not speech. */
const MIN_MP3_BYTES = 2048

const problems = []
const fail = (message) => problems.push(message)

/**
 * The words a recording should contain: gesture tags out, whitespace normalised.
 *
 * Deliberately looser than `parseGestureTags` in the app, which has to preserve
 * exact character offsets because gesture timing is derived from them. Here only
 * the words matter, and matching on words rather than on byte-identical spacing
 * keeps this check from failing on a double space nobody can hear.
 */
const TAGS =
  'wave|bye|point|present|shrug|nod|shake|think|happy|confused|surprised|sorry'

const spoken = (text) =>
  text
    .replace(new RegExp(`\\[(${TAGS})\\??\\]`, 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim()

const readJson = async (file, label) => {
  if (!existsSync(file)) {
    fail(`${label} not found at ${path.relative(ROOT, file)}`)
    return null
  }
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    fail(`${label} is not valid JSON: ${error.message}`)
    return null
  }
}

const qa = await readJson(QA_PATH, 'content/qa.json')
const manifest = await readJson(MANIFEST_PATH, 'answer manifest')

if (!qa || !manifest) {
  report()
} else {
  const qaAnswers = Array.isArray(qa.answers) ? qa.answers : []
  const entries = Array.isArray(manifest.answers) ? manifest.answers : []

  if (qaAnswers.length === 0) fail('content/qa.json has no answers.')
  if (entries.length === 0) fail('The manifest has no answers.')

  // Order matters as much as membership: the two files are read side by side by
  // whoever is re-rendering, and a silently reordered manifest makes that job
  // into a diff hunt.
  const qaIds = qaAnswers.map((answer) => answer.id)
  const manifestIds = entries.map((entry) => entry.id)
  if (qaIds.join(',') !== manifestIds.join(',')) {
    fail(
      'Manifest ids do not match content/qa.json, in order.\n' +
        `  qa.json:  ${qaIds.join(' ')}\n` +
        `  manifest: ${manifestIds.join(' ')}`,
    )
  }

  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (const answer of qaAnswers) {
    const entry = byId.get(answer.id)
    if (!entry) {
      fail(`"${answer.id}" has no pre-rendered answer. Render it, or drop it from qa.json.`)
      continue
    }
    if (spoken(entry.answer) !== spoken(answer.answer)) {
      fail(
        `"${answer.id}" — the recording and content/qa.json say different things.\n` +
          `  qa.json:  ${spoken(answer.answer)}\n` +
          `  recorded: ${spoken(entry.answer)}\n` +
          '  Re-render this answer, or revert the text.',
      )
    }
  }

  if (typeof qa.refusalFallback === 'string' && manifest.refusalFallback) {
    if (spoken(manifest.refusalFallback.answer) !== spoken(qa.refusalFallback)) {
      fail('The refusal fallback recording and content/qa.json say different things.')
    }
  }

  const hotkeys = new Map()
  for (const entry of entries) {
    if (entry.hotkey === undefined) continue
    const taken = hotkeys.get(entry.hotkey)
    if (taken) fail(`Hotkey "${entry.hotkey}" is on both "${taken}" and "${entry.id}".`)
    hotkeys.set(entry.hotkey, entry.id)
  }

  const files = [...entries, manifest.refusalFallback].filter(Boolean)
  for (const entry of files) {
    if (!entry.file) {
      fail(`"${entry.id}" has no file.`)
      continue
    }
    const full = path.join(FALLBACK_DIR, entry.file)
    if (!existsSync(full)) {
      fail(`"${entry.id}" → ${entry.file} is missing. Every turn for it falls through to live.`)
    } else if (statSync(full).size < MIN_MP3_BYTES) {
      fail(`"${entry.id}" → ${entry.file} is ${statSync(full).size} bytes. That is not speech.`)
    }
  }

  report(entries.length)
}

function report(count = 0) {
  if (problems.length > 0) {
    console.error(`\n✗ Answer cache is out of step (${problems.length} problem(s)):\n`)
    for (const problem of problems) console.error(`  • ${problem}\n`)
    console.error('  See assets/README.md for how to re-render.\n')
    process.exit(1)
  }
  console.log(`✓ Answer cache matches content/qa.json — ${count} answers, all audio present.`)
}
