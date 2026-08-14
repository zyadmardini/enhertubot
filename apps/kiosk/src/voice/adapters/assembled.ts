import type { ConversationDriver, DriverDeps, DriverEvent } from '../types.ts'

/**
 * Route B — assembled: Deepgram STT → LLM → ElevenLabs streaming TTS.
 *
 * NOT YET IMPLEMENTED. This is the fallback if the Week-3 Route A spike hits a
 * blocker; the interfaces exist now so choosing it costs days, not a rewrite.
 *
 * The one thing that must not be lost when this is built: sentence chunking.
 * The first completed sentence goes to TTS immediately rather than waiting for
 * the full answer — that single decision is worth roughly a second of perceived
 * latency, which is the difference between alive and broken.
 *
 * Implementation sketch (every leg via the proxy, never direct to a vendor):
 *   - pttDown:  getUserMedia → AudioWorklet → WS {proxyUrl}/stt
 *   - pttUp:    force-finalise the transcript rather than waiting on VAD
 *   - then:     POST {proxyUrl}/chat, read the SSE token stream
 *   - on each completed sentence: WS {proxyUrl}/tts, decode chunks into
 *     deps.audioContext, emit {type:'audio'} — never play directly (see AudioBus)
 */
export class AssembledDriver implements ConversationDriver {
  readonly id = 'assembled'
  #listeners = new Set<(event: DriverEvent) => void>()

  constructor(_deps: DriverDeps) {}

  async connect(): Promise<void> {
    throw new Error(
      'AssembledDriver is not implemented yet. Set driver: "mock" in enubot.config.ts, ' +
        'or build this after the Week-3 spike. See ENGINEERING-PLAN.md §3.5.',
    )
  }

  pttDown(): void {}
  pttUp(): void {}
  interrupt(): void {}
  disconnect(): void {
    this.#listeners.clear()
  }

  on(listener: (event: DriverEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
