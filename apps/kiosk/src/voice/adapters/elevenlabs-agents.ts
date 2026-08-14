import type { ConversationDriver, DriverDeps, DriverEvent } from '../types.ts'

/**
 * Route A — ElevenLabs Agents: STT + LLM + TTS + turn-taking over one socket.
 *
 * NOT YET IMPLEMENTED. This is deliberately a typed skeleton, because the first
 * task of Week 3 is a timeboxed spike that answers four questions against the
 * current API before we commit:
 *
 *   1. Can we drive it push-to-talk (explicit mic mute/unmute or turn control),
 *      rather than always-listening? A booth floor is far too noisy for VAD.
 *   2. Is there a gesture side-channel — client tools/events the LLM can invoke,
 *      or clean per-sentence transcript events we can parse tags out of?
 *   3. Can we tap the output audio for lip-sync — either their frequency-data
 *      API, or an output node we can route into our AudioBus?
 *   4. Do we get full system-prompt control, including the redirect rule?
 *
 * All four pass → this ships. Any blocker → `assembled.ts`, which is already
 * scoped. Record the answer in ENGINEERING-PLAN.md §7 either way.
 *
 * Implementation sketch:
 *   - POST {proxyUrl}/session to mint a signed WebSocket URL. The API key stays
 *     server-side; the browser only ever sees a short-lived signed URL.
 *   - Open the socket, forward mic PCM on pttDown..pttUp.
 *   - Decode returned audio into deps.audioContext and emit {type:'audio'}.
 *     Never play it directly — see AudioBus.
 */
export class ElevenLabsAgentsDriver implements ConversationDriver {
  readonly id = 'elevenlabs-agents'
  #listeners = new Set<(event: DriverEvent) => void>()

  constructor(_deps: DriverDeps) {}

  async connect(): Promise<void> {
    throw new Error(
      'ElevenLabsAgentsDriver is not implemented yet. Run the Week-3 spike first, ' +
        'or set driver: "mock" in enubot.config.ts. See ENGINEERING-PLAN.md §3.5.',
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
