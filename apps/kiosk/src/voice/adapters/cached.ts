import type { CharAlignment } from '../../audio/alignment.ts'
import type {
  CannedAnswer,
  CannedAnswerBank,
  ConversationDriver,
  DriverDeps,
  DriverEvent,
} from '../types.ts'

/**
 * Cache-only driver: pre-rendered answers, no STT and no LLM.
 *
 * This is tier 1 of the three-tier cache in `docs/elevenlabs-integration.md` §8,
 * standing on its own with the live pipeline switched off. It is a real answer
 * path rather than a stub — the same one that runs when `/health` fails — so
 * everything downstream of the port exercises for real: the state machine runs a
 * full turn, gestures schedule against actual audio playback position, and the
 * mouth is driven by an analyser reading real speech instead of synthesised
 * babble.
 *
 * What it deliberately does not do is guess what the visitor said. With no STT
 * there is no transcript to match against `qa.json`, so a push-to-talk press
 * walks the bank in order and a staff hotkey selects an answer directly. When
 * STT lands, the matching goes in `#pick` and nothing else here moves.
 *
 * Audio is fetched, decoded into the shared context and handed over as a buffer.
 * It never plays here — see AudioBus for why that rule has no exceptions.
 */

const FALLBACK_BASE = '/fallback'
const MANIFEST_URL = `${FALLBACK_BASE}/manifest.json`

/** Roughly what tier 1 costs in practice: no network, just decode and schedule. */
const TRANSCRIPT_DELAY_MS = 120
const TEXT_DELAY_MS = 60

/**
 * How many clips are fetched and decoded at once while warming the bank.
 *
 * The bank used to be warmed by firing every fetch on the same tick, which
 * sounds like the fastest thing to do and is only fastest for the bank. Measured
 * on a 6Mbps link, eleven parallel MP3 requests take about eleven twelfths of the
 * pipe and leave the 1.3MB character model the rest: the bank finished at 1.8s
 * and the robot did not appear until 6.5s. Nothing had gone wrong — the bytes
 * were simply allocated to the half of the boot nobody was waiting on yet.
 *
 * Three at a time keeps the connection busy without starving the model, and
 * finishes the bank in `qa.json` order, which is the order the press-to-talk
 * cursor walks it in. Same link, same bytes: bank at 3.8s, robot at 4.6s.
 */
const WARM_CONCURRENCY = 3

interface Manifest {
  answers: CannedAnswer[]
  refusalFallback?: CannedAnswer
}

export class CachedDriver implements ConversationDriver, CannedAnswerBank {
  readonly id = 'cached'
  #deps: DriverDeps
  #listeners = new Set<(event: DriverEvent) => void>()
  #timers: ReturnType<typeof setTimeout>[] = []
  #answers: CannedAnswer[] = []
  #refusal: CannedAnswer | null = null
  /** Decoded clips, and the in-flight decodes, keyed by answer id. */
  #buffers = new Map<string, Promise<AudioBuffer>>()
  /**
   * Character timings, for the answers that have them.
   *
   * Loaded up front with the manifest rather than beside the audio decode: it is
   * a small JSON file, and a closure track that arrives after the first chunk is
   * already playing would press the lips shut a syllable late.
   */
  #alignments = new Map<string, CharAlignment>()
  #cursor = 0
  /** Bumped on every interrupt so a decode that lands late can't speak. */
  #turn = 0
  /** Set by disconnect, so a warm in flight stops rather than filling a dead map. */
  #disposed = false

  constructor(deps: DriverDeps) {
    this.#deps = deps
  }

  get bank(): readonly CannedAnswer[] {
    return this.#answers
  }

  async connect(): Promise<void> {
    const response = await fetch(MANIFEST_URL)
    if (!response.ok) {
      throw new Error(
        `No answer cache at ${MANIFEST_URL} (HTTP ${response.status}). ` +
          'Render the answers first — see assets/README.md.',
      )
    }

    // A dev server's SPA fallback answers a missing file with index.html and a
    // 200, so an ok response is not on its own proof the manifest is there.
    // Caught here because `response.json()` on HTML throws a JSON syntax error,
    // which sends whoever hits it looking for a malformed manifest rather than a
    // missing one.
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('text/html')) {
      throw new Error(
        `${MANIFEST_URL} returned HTML, which means the file isn't there. ` +
          'Render the answers first — see assets/README.md.',
      )
    }

    const manifest = (await response.json()) as Manifest
    if (!Array.isArray(manifest.answers) || manifest.answers.length === 0) {
      throw new Error(`${MANIFEST_URL} has no answers array.`)
    }

    this.#answers = manifest.answers
    this.#refusal = manifest.refusalFallback ?? null

    // Warm the bank in the background. Awaiting it here would put every decode in
    // front of the first frame; leaving it out would put one fetch in front of
    // the first answer, which is the latency the cache exists to remove. `#play`
    // awaits whichever decode it needs, in flight or done.
    //
    // The count goes out before connect resolves so the runtime knows a warm is
    // coming and boot has a total to count against — a driver that emits nothing
    // here is treated as ready the moment it connects.
    const queue = [...this.#answers, ...(this.#refusal ? [this.#refusal] : [])]
    this.#emit({ type: 'warming', done: 0, total: queue.length })
    void this.#warmBank(queue)
  }

  /**
   * Fetch and decode the whole bank, `WARM_CONCURRENCY` clips at a time.
   *
   * Every failure is swallowed to a warning: one clip that 404s must not stop the
   * other ten from warming, and it must not stall boot behind a `done` that never
   * reaches `total` either. The press for that one answer then fails the way it
   * always did, with a recoverable error.
   */
  async #warmBank(queue: readonly CannedAnswer[]): Promise<void> {
    let next = 0
    let done = 0

    const worker = async (): Promise<void> => {
      while (next < queue.length && !this.#disposed) {
        const answer = queue[next++]
        if (!answer) continue
        // The sidecar rides beside its own clip rather than in a second wave:
        // both are needed at the same moment, and an alignment that lands after
        // the audio it describes presses the lips shut a syllable late.
        await Promise.all([
          this.#decode(answer).catch((error: unknown) => {
            console.warn(`[enubot] Pre-rendered answer "${answer.id}" failed to load.`, error)
          }),
          this.#loadAlignment(answer),
        ])
        done += 1
        this.#emit({ type: 'warming', done, total: queue.length })
      }
    }

    await Promise.all(Array.from({ length: Math.min(WARM_CONCURRENCY, queue.length) }, worker))
  }

  /**
   * Fetch one answer's character timings, if the bake recorded any.
   *
   * Failure is silent by design beyond a warning: no alignment means the mouth
   * falls back to the analyser, which is how every cached answer behaved before
   * this existed. A missing sidecar must never cost the answer its voice.
   */
  async #loadAlignment(answer: CannedAnswer): Promise<void> {
    if (!answer.alignmentFile) return
    try {
      const response = await fetch(`${FALLBACK_BASE}/${answer.alignmentFile}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const alignment = (await response.json()) as CharAlignment
      if (!Array.isArray(alignment.charStartTimesMs)) throw new Error('no charStartTimesMs')
      this.#alignments.set(answer.id, alignment)
    } catch (error) {
      console.warn(`[enubot] Alignment for "${answer.id}" failed to load; analyser only.`, error)
    }
  }

  pttDown(): void {
    this.interrupt()
  }

  pttUp(): void {
    const answer = this.#pick()
    if (answer) this.#play(answer)
  }

  /** Staff hotkey, or any caller that already knows which answer it wants. */
  speak(id: string): void {
    const answer = this.#answers.find((candidate) => candidate.id === id) ?? this.#refusal
    if (!answer) {
      this.#emit({ type: 'error', message: `No pre-rendered answer "${id}".`, recoverable: true })
      return
    }
    this.interrupt()
    this.#play(answer)
  }

  interrupt(): void {
    this.#turn += 1
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers = []
  }

  disconnect(): void {
    this.#disposed = true
    this.interrupt()
    this.#listeners.clear()
    this.#buffers.clear()
    this.#alignments.clear()
  }

  on(listener: (event: DriverEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /**
   * Which answer a push-to-talk press gets.
   *
   * Cycling rather than picking at random is a demo decision: pressing the button
   * n times walks the whole bank, so a review or a gesture check covers every
   * clip instead of hitting the same three. This is the seam where transcript
   * matching goes when STT lands.
   */
  #pick(): CannedAnswer | null {
    if (this.#answers.length === 0) return this.#refusal
    const answer = this.#answers[this.#cursor % this.#answers.length] ?? null
    this.#cursor += 1
    return answer
  }

  #play(answer: CannedAnswer): void {
    const turn = this.#turn
    const startedAt = performance.now()

    this.#after(TRANSCRIPT_DELAY_MS, () => {
      this.#emit({ type: 'user_transcript', text: answer.question, final: true })
    })

    this.#after(TRANSCRIPT_DELAY_MS + TEXT_DELAY_MS, () => {
      // Tags travel in the text and the runtime strips them; this is the same
      // shape the mock and Route B emit, so the gesture path is identical.
      this.#emit({ type: 'agent_text', text: answer.answer, done: true })
      // Baked times, when the answer has them, land after the text so the
      // captions are already up — the runtime treats them as replacing whatever
      // it inferred from the tags, so the order is a preference, not a contract.
      if (answer.cues && answer.cues.length > 0) {
        this.#emit({ type: 'cues', track: answer.cues })
      }
    })

    void this.#decode(answer)
      .then((buffer) => {
        // A barge-in during the decode abandoned this turn. Emitting now would
        // speak an answer to a question the visitor already moved on from.
        if (turn !== this.#turn) return
        // Time from the press, not from the decode: a warm clip resolves in
        // roughly no time, and adding the pacing delay on top of a slow cold
        // decode would push the voice out twice as far as it needs to go.
        const remaining = Math.max(
          0,
          TRANSCRIPT_DELAY_MS + TEXT_DELAY_MS - (performance.now() - startedAt),
        )
        this.#after(remaining, () => {
          if (turn !== this.#turn) return
          // Alignment only when it was captured at render time and written beside
          // the MP3. Inventing linear timings over real speech would drive the
          // closure track to fire at the wrong syllables — worse than the
          // analyser alone, which is exactly why it is optional on the event.
          const alignment = this.#alignments.get(answer.id)
          this.#emit(alignment ? { type: 'audio', buffer, alignment } : { type: 'audio', buffer })
        })
      })
      .catch((error: unknown) => {
        if (turn !== this.#turn) return
        this.#emit({
          type: 'error',
          message: `Pre-rendered answer "${answer.id}" is missing or undecodable: ${String(error)}`,
          recoverable: true,
        })
      })
  }

  #decode(answer: CannedAnswer): Promise<AudioBuffer> {
    const existing = this.#buffers.get(answer.id)
    if (existing) return existing

    const pending = (async () => {
      const response = await fetch(`${FALLBACK_BASE}/${answer.file}`)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      // decodeAudioData detaches the ArrayBuffer, so the decoded result is what
      // gets cached — a second press cannot re-decode the same bytes.
      return this.#deps.audioContext.decodeAudioData(await response.arrayBuffer())
    })()

    // Don't cache a failure: a clip that 404s during a dev restart should be
    // retried on the next press rather than being dead for the session.
    pending.catch(() => this.#buffers.delete(answer.id))
    this.#buffers.set(answer.id, pending)
    return pending
  }

  #after(ms: number, fn: () => void): void {
    this.#timers.push(setTimeout(fn, ms))
  }

  #emit(event: DriverEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }
}
