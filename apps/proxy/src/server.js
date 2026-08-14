import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import Anthropic from '@anthropic-ai/sdk'
import { getContent, loadContent, watchContent } from './content.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(HERE, '../.env') })

const HOST = process.env.PROXY_HOST ?? '127.0.0.1'
const PORT = Number(process.env.PROXY_PORT ?? 8787)
const KIOSK_ORIGIN = process.env.KIOSK_ORIGIN ?? 'http://127.0.0.1:5173'
const MODEL = process.env.ENUBOT_LLM_MODEL ?? 'claude-opus-5'
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 60)
const EVENT_MODE = process.env.EVENT_MODE === '1'

/**
 * Key custody for the kiosk.
 *
 * Runs on the event machine itself, bound to loopback: no network-exposed
 * surface at the venue, and localhost is a secure context so getUserMedia works
 * with no TLS certificate to manage. The browser is hardened separately, but
 * nothing here depends on that — this assumes a hostile client.
 */
const app = Fastify({ logger: { level: EVENT_MODE ? 'warn' : 'info' } })

await app.register(cors, { origin: KIOSK_ORIGIN })

// Coarse per-minute cap. Layer two of the same defence is a spend cap on every
// provider dashboard — a tampered kiosk should be able to annoy, not bankrupt.
let windowStart = Date.now()
let windowCount = 0
app.addHook('onRequest', async (request, reply) => {
  if (request.method !== 'POST') return
  const now = Date.now()
  if (now - windowStart > 60_000) {
    windowStart = now
    windowCount = 0
  }
  if (++windowCount > RATE_LIMIT) {
    reply.code(429).send({ error: 'rate_limited' })
  }
})

await loadContent()
app.log.info(`Loaded ${getContent().qa.answers.length} Q&A pairs from content/`)
void watchContent((content) => {
  app.log.warn(`Content reloaded — ${content.qa.answers.length} answers now live.`)
})

app.get('/health', async () => ({
  ok: true,
  model: MODEL,
  eventMode: EVENT_MODE,
  // Which gesture instruction the live prompt carries. Worth surfacing: the
  // wrong one is only detectable by hearing Enubot say "wave" to a visitor.
  voiceRoute: getContent().route,
  contentLoadedAt: getContent().loadedAt,
  hasAnthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
}))

/** Debug view of the assembled prompt. Never reachable from outside loopback. */
app.get('/content', async () => {
  const content = getContent()
  return {
    loadedAt: content.loadedAt,
    route: content.route,
    answers: content.qa.answers,
    systemPrompt: content.systemPrompt,
  }
})

app.post('/reload-content', async () => {
  await loadContent()
  return { ok: true, loadedAt: getContent().loadedAt }
})

const anthropic = new Anthropic()

/**
 * Streamed answer, as Server-Sent Events.
 *
 * Thinking is off and effort is low on purpose. The budget from mic release to
 * first audio is about 600ms, and thinking tokens are generated before any text
 * — a thinking pass would spend the entire budget before the first word. The
 * task (ten scripted answers, two to three sentences, in character) sits well
 * inside what that setting handles.
 */
app.post('/chat', async (request, reply) => {
  const { question } = request.body ?? {}
  if (typeof question !== 'string' || question.trim().length === 0) {
    return reply.code(400).send({ error: 'question required' })
  }

  const content = getContent()
  if (!EVENT_MODE) app.log.info({ question }, 'chat')

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const send = (payload) => reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
  const controller = new AbortController()
  request.raw.on('close', () => controller.abort())

  let emitted = 0
  try {
    const stream = anthropic.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: 300,
        // Route a policy decline to Anthropic's recommended fallback rather than
        // returning nothing. A kiosk that goes silent mid-answer reads as broken.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // The persona block is byte-identical on every turn — cache it and the
        // whole prefix is served at cache-read rates and lower latency.
        system: [
          { type: 'text', text: content.systemPrompt, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: question }],
        thinking: { type: 'disabled' },
        output_config: { effort: 'low' },
      },
      { signal: controller.signal },
    )

    stream.on('text', (text) => {
      emitted += text.length
      send({ type: 'delta', text })
    })

    const final = await stream.finalMessage()

    // Safety classifiers can decline. Never surface that to a visitor as an
    // error — redirect in character, which is what the persona does anyway.
    if (final.stop_reason === 'refusal' && emitted === 0) {
      send({ type: 'delta', text: content.qa.refusalFallback ?? "[shrug] That one's not for me. Ask me about the event instead." })
    }

    send({ type: 'done', stopReason: final.stop_reason, model: final.model })
  } catch (error) {
    if (!controller.signal.aborted) {
      app.log.error(error, 'chat failed')
      send({ type: 'error', message: 'upstream_failed' })
    }
  } finally {
    reply.raw.end()
  }
})

/**
 * One-shot TTS with character alignment, for the lip-sync debug page.
 *
 * Exists because the hybrid mouth cannot be judged against synthetic timings —
 * evenly spaced characters make every closure land perfectly, which is exactly
 * the bug this is meant to catch. Real speech has uneven consonants.
 *
 * This is the standard TTS endpoint, not Agents: it needs no agent, no session
 * and no websocket, so the mouth can be tuned before the driver exists. The two
 * return different alignment shapes — see normaliseAlignment.
 *
 * Dev only. Off in event mode, and it is a POST so the rate limiter covers it.
 */
app.post('/tts-sample', async (request, reply) => {
  if (EVENT_MODE) return reply.code(404).send({ error: 'not_found' })

  const key = process.env.ELEVENLABS_API_KEY
  if (!key) {
    return reply.code(503).send({
      error: 'elevenlabs_not_configured',
      hint: 'Set ELEVENLABS_API_KEY in apps/proxy/.env. The debug page falls back to local synthesis without it.',
    })
  }

  const { text, voiceId } = request.body ?? {}
  if (typeof text !== 'string' || text.trim().length === 0) {
    return reply.code(400).send({ error: 'text required' })
  }
  if (text.length > 500) {
    return reply.code(400).send({ error: 'text too long', max: 500 })
  }

  const voice = voiceId ?? process.env.ELEVENLABS_VOICE_ID
  if (!voice) {
    return reply.code(503).send({ error: 'no_voice', hint: 'Set ELEVENLABS_VOICE_ID in apps/proxy/.env.' })
  }

  try {
    const upstream = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}/with-timestamps`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          model_id: process.env.ELEVENLABS_TTS_MODEL ?? 'eleven_flash_v2_5',
        }),
        signal: AbortSignal.timeout(20_000),
      },
    )

    if (!upstream.ok) {
      const detail = await upstream.text()
      app.log.error({ status: upstream.status, detail }, 'tts-sample upstream failed')
      return reply.code(502).send({ error: 'upstream_failed', status: upstream.status, detail })
    }

    const payload = await upstream.json()
    // Prefer the normalised alignment: the audio is synthesised from normalised
    // text, so "1997" is spoken as "nineteen ninety seven" and the closures live
    // in that form, not in the four digits the caller sent.
    const alignment = normaliseAlignment(payload.normalized_alignment ?? payload.alignment)

    if (!alignment) {
      // Loud rather than silent. A shape change here would otherwise present as
      // a mouth that simply stopped closing, with nothing in the logs.
      const observed = Object.keys(payload.normalized_alignment ?? payload.alignment ?? payload)
      app.log.error({ observed }, 'tts-sample: unrecognised alignment shape')
      return reply.code(502).send({ error: 'unrecognised_alignment_shape', observed })
    }

    return {
      audioBase64: payload.audio_base64,
      mimeType: 'audio/mpeg',
      alignment,
      chars: alignment.chars.length,
    }
  } catch (error) {
    app.log.error(error, 'tts-sample failed')
    return reply.code(502).send({ error: 'upstream_failed' })
  }
})

/**
 * Both ElevenLabs alignment shapes into the one the kiosk consumes.
 *
 * Standard TTS returns `characters` with start/end in *seconds*; the Agents
 * websocket returns `chars` with start/duration in *milliseconds*. The kiosk
 * speaks the latter, so this converts and the debug page and the live driver end
 * up feeding AlignmentTrack identical data.
 *
 * Returns null on anything unrecognised so the caller can report the real keys
 * rather than guessing.
 */
function normaliseAlignment(raw) {
  if (!raw || typeof raw !== 'object') return null

  if (Array.isArray(raw.characters) && Array.isArray(raw.character_start_times_seconds)) {
    const starts = raw.character_start_times_seconds
    const ends = raw.character_end_times_seconds ?? []
    return {
      chars: raw.characters,
      charStartTimesMs: starts.map((s) => s * 1000),
      charDurationsMs: starts.map((s, i) => Math.max(0, (ends[i] ?? s) - s) * 1000),
    }
  }

  if (Array.isArray(raw.chars) && Array.isArray(raw.char_start_times_ms)) {
    return {
      chars: raw.chars,
      charStartTimesMs: raw.char_start_times_ms,
      charDurationsMs: raw.char_durations_ms ?? raw.chars.map(() => 0),
    }
  }

  return null
}

/**
 * Route A session minting. Returns a short-lived signed WebSocket URL so the
 * ElevenLabs key never reaches the browser.
 *
 * Stubbed until the Week-3 spike confirms Route A — see ENGINEERING-PLAN.md §3.5.
 */
app.post('/session', async (_request, reply) => {
  if (!process.env.ELEVENLABS_API_KEY || !process.env.ELEVENLABS_AGENT_ID) {
    return reply.code(503).send({ error: 'elevenlabs_not_configured' })
  }
  return reply.code(501).send({ error: 'not_implemented', see: 'ENGINEERING-PLAN.md §3.5' })
})

await app.listen({ host: HOST, port: PORT })
app.log.info(`Enubot proxy on http://${HOST}:${PORT} — model ${MODEL}, event mode ${EVENT_MODE}`)
