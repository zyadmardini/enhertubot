import { readFile, watch } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const CONTENT_DIR = path.resolve(HERE, '../../../content')

/**
 * Persona and Q&A live as data on disk, not in the bundle.
 *
 * Two reasons this matters, and neither is tidiness. Visitors at a public kiosk
 * can open devtools, and the system prompt is both intellectual property and
 * attack surface — so it is assembled here, server-side. And the wording of the
 * answers always changes on the morning of the event, so it has to be editable
 * without a rebuild.
 */

let cache = null

async function readOptional(file) {
  const full = path.join(CONTENT_DIR, file)
  if (!existsSync(full)) return null
  return readFile(full, 'utf8')
}

export async function loadContent() {
  const [persona, redirects, qaRaw] = await Promise.all([
    readOptional('persona.md'),
    readOptional('redirects.md'),
    readOptional('qa.json'),
  ])

  if (!persona) throw new Error(`content/persona.md not found in ${CONTENT_DIR}`)
  if (!qaRaw) throw new Error(`content/qa.json not found in ${CONTENT_DIR}`)

  const qa = JSON.parse(qaRaw)
  if (!Array.isArray(qa.answers)) {
    throw new Error('content/qa.json must have an "answers" array')
  }

  const route = voiceRoute()
  cache = {
    persona: persona.trim(),
    redirects: (redirects ?? '').trim(),
    qa,
    route,
    systemPrompt: buildSystemPrompt(persona, redirects, qa, route),
    loadedAt: new Date().toISOString(),
  }
  return cache
}

export const VOICE_ROUTES = ['assembled', 'elevenlabs-agents']

/**
 * Which voice route the prompt is being built for.
 *
 * Read inside the function, never at module scope: `server.js` imports this
 * module before it calls `dotenv.config()`, and ES module bodies are evaluated
 * at import time — a top-level read would see an empty `.env` every time.
 *
 * Fail fast on a typo. A misspelled route silently building the wrong gesture
 * instruction is exactly the kind of bug that only shows up as Enubot saying the
 * word "wave" out loud to a visitor.
 */
function voiceRoute() {
  const raw = process.env.ENUBOT_VOICE_ROUTE ?? 'assembled'
  if (!VOICE_ROUTES.includes(raw)) {
    throw new Error(
      `ENUBOT_VOICE_ROUTE must be one of ${VOICE_ROUTES.join(' | ')} — got "${raw}"`,
    )
  }
  return raw
}

export function getContent() {
  if (!cache) throw new Error('Content not loaded. Call loadContent() first.')
  return cache
}

/** Re-read on any change so `qa.json` edits take effect without a restart. */
export async function watchContent(onReload) {
  const watcher = watch(CONTENT_DIR)
  for await (const _event of watcher) {
    try {
      await loadContent()
      onReload?.(getContent())
    } catch (error) {
      // A half-saved qa.json shouldn't take the proxy down mid-event; keep
      // serving the last good copy and say what broke.
      console.error('[proxy] Content reload failed, keeping previous version:', error.message)
    }
  }
}

/**
 * The gesture instruction is the one part of the prompt that is route-dependent,
 * and getting it wrong is audible.
 *
 * Route B and the mock parse gesture tags out of the text and strip them before
 * anything is synthesised, so inline tags are free. Route A hands the model's
 * output straight to ElevenLabs' TTS with no seam in between — an inline `[wave]`
 * is read aloud to the visitor. Gestures there travel as a client tool call
 * instead, on a channel the TTS never sees.
 *
 * `before_phrase` is what buys back exact timing: looked up in the per-character
 * alignment that ships with the audio, it gives a real playback position to
 * schedule against, rather than firing the gesture whenever the event happens to
 * land. See docs/elevenlabs-integration.md §5.
 */
const GESTURE_INSTRUCTIONS = {
  assembled: `Insert gesture tags inline where a person would naturally move: [wave] [point]
[shrug] [nod] [think]. Use them sparingly — at most one per sentence, and only
where the movement genuinely fits the words.`,

  'elevenlabs-agents': `You have a tool called play_gesture. Call it where a person would naturally
move — at most once per sentence, and only where the movement genuinely fits the
words. Pass the gesture name (wave, point, shrug, nod or think) and, in
before_phrase, the first few words of the clause it belongs to, copied exactly
from your reply so the movement lands on the right words.

Never write a gesture in square brackets. Everything you write is spoken aloud
exactly as written, so a stray [wave] is heard as the word "wave".`,
}

export function buildSystemPrompt(persona, redirects, qa, route = 'assembled') {
  const gestures = GESTURE_INSTRUCTIONS[route]
  if (!gestures) throw new Error(`No gesture instruction for route "${route}"`)

  const answers = qa.answers
    .map((entry, index) => {
      const variants = Array.isArray(entry.variants) && entry.variants.length
        ? `\n   Also asked as: ${entry.variants.join(' / ')}`
        : ''
      return `${index + 1}. Q: ${entry.question}${variants}\n   A: ${entry.answer}`
    })
    .join('\n\n')

  return `${persona.trim()}

# What you know about the event

These are your core answers. Deliver them in your own voice — don't recite them
word for word, but never contradict the facts.

${answers}

# Off-script questions

${redirects?.trim() || 'Steer politely back to the event, in character.'}

# How you speak

- Two to three sentences. Never more. A queue builds at a booth otherwise.
- Spoken aloud, so: no lists, no markdown, no emoji, no stage directions.
- If you don't know something, say so in character and offer what you do know.
- Do not include internal or system XML tags in your response.

# Gestures

${gestures}`
}
