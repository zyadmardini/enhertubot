#!/usr/bin/env node
/**
 * Runs the ten canonical questions plus a set of adversarial ones through the
 * live prompt and prints the answers for review.
 *
 * This is the regression suite for the character. Prompting is the whole
 * behaviour model here — there is no fine-tuning — so a wording change in
 * qa.json can quietly break the redirect rule or blow the length cap. Run it
 * after every content edit, including the ones made on the morning of the event.
 *
 * Usage:  npm run eval:persona            (all questions)
 *         npm run eval:persona -- --adversarial-only
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROXY = process.env.ENUBOT_PROXY ?? 'http://127.0.0.1:8787'
const adversarialOnly = process.argv.includes('--adversarial-only')

const qa = JSON.parse(await readFile(path.resolve(HERE, '../content/qa.json'), 'utf8'))

try {
  const health = await fetch(`${PROXY}/health`, { signal: AbortSignal.timeout(3000) })
  if (!health.ok) throw new Error(String(health.status))
  const info = await health.json()
  if (!info.hasAnthropicKey) {
    console.error('✗ Proxy is up but ANTHROPIC_API_KEY is not set in apps/proxy/.env')
    process.exit(1)
  }
  console.log(`Proxy up — model ${info.model}\n`)
} catch {
  console.error(`✗ No proxy at ${PROXY}. Start it with: npm run dev:proxy`)
  process.exit(1)
}

const questions = [
  ...(adversarialOnly ? [] : qa.answers.map((a) => ({ kind: 'canonical', text: a.question }))),
  ...(qa._evalAdversarial ?? []).map((text) => ({ kind: 'adversarial', text })),
]

const TAG = /\[(wave|point|shrug|nod|think)\]/gi
let overLength = 0
let failed = 0

for (const question of questions) {
  const started = Date.now()
  let answer = ''

  try {
    const response = await fetch(`${PROXY}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question.text }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    // Minimal SSE reader: events are newline-delimited `data: {json}` frames.
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      const frames = buffered.split('\n\n')
      buffered = frames.pop() ?? ''
      for (const frame of frames) {
        if (!frame.startsWith('data: ')) continue
        const event = JSON.parse(frame.slice(6))
        if (event.type === 'delta') answer += event.text
        if (event.type === 'error') throw new Error(event.message)
      }
    }
  } catch (error) {
    failed += 1
    console.log(`\n[${question.kind}] ${question.text}`)
    console.log(`  ✗ ${error.message}`)
    continue
  }

  const spoken = answer.replace(TAG, '').trim()
  // The 2–3 sentence cap protects booth throughput; flag anything that drifts.
  const sentences = spoken.split(/[.!?]+\s/).filter(Boolean).length
  const long = sentences > 3
  if (long) overLength += 1

  console.log(`\n[${question.kind}] ${question.text}`)
  console.log(`  ${spoken}`)
  console.log(
    `  ${long ? '⚠ ' : ''}${sentences} sentence(s) · ${spoken.length} chars · ${Date.now() - started} ms` +
      `${(answer.match(TAG) ?? []).length ? ` · tags: ${(answer.match(TAG) ?? []).join(' ')}` : ''}`,
  )
}

console.log(`\n${'—'.repeat(60)}`)
console.log(`${questions.length} asked · ${overLength} over the 3-sentence cap · ${failed} failed`)
console.log('Read the adversarial answers yourself — the check that matters is')
console.log('whether Enubot stayed in character, and no script can judge that.\n')

if (failed > 0) process.exit(1)
