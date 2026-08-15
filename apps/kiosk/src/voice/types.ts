/**
 * The swap seam for the whole voice pipeline.
 *
 * Route A (ElevenLabs Agents) and Route B (Deepgram + LLM + ElevenLabs) both
 * implement this, and so does the mock. Nothing downstream can tell them apart,
 * which is what makes the Week-3 route decision cost days instead of a rewrite.
 *
 * Note what is absent: no adapter plays audio. Adapters hand decoded buffers to
 * the runtime, which feeds the shared AudioBus. See AudioBus for why.
 */

import type { CharAlignment } from '../audio/alignment.ts'
import type { BakedTrack } from '../core/gestures.ts'

export type DriverEvent =
  | { type: 'user_transcript'; text: string; final: boolean }
  | { type: 'agent_text'; text: string; done: boolean }
  /**
   * Cues whose audio times are already known, superseding anything the runtime
   * would infer from tag positions in `agent_text`.
   *
   * The cached path emits these from the bake, where the times were measured
   * against the actual recording. It is also the seam Route A needs: their LLM
   * output goes straight into their TTS with no place to strip a `[wave]`, so
   * gestures have to arrive beside the text rather than inside it.
   */
  | { type: 'cues'; track: BakedTrack }
  /**
   * A decoded chunk of Enubot's speech, ready to schedule on the bus.
   *
   * `alignment` is optional because it is a vendor luxury, not a contract: a
   * driver that has character timings improves the mouth by passing them, and
   * one that doesn't falls back to the analyser with no branch anywhere
   * downstream. It rides on this event rather than its own so it cannot be
   * paired with the wrong chunk.
   */
  | { type: 'audio'; buffer: AudioBuffer; alignment?: CharAlignment }
  /**
   * How far along this driver is in getting to the point where its first answer
   * is fast, emitted once per unit of work with `done === total` meaning ready.
   *
   * The cached path counts decoded clips, and that count is what the boot screen
   * holds the kiosk back for: a bank still downloading is the difference between
   * a press that speaks and a press that waits on a fetch — which is what a
   * visitor reads as a broken robot. A driver with nothing to warm never emits
   * it, and connecting is then readiness on its own.
   */
  | { type: 'warming'; done: number; total: number }
  | { type: 'error'; message: string; recoverable: boolean }

export interface DriverDeps {
  /** Shared context — adapters decode into it so buffers are bus-compatible. */
  audioContext: AudioContext
  proxyUrl: string
}

export interface ConversationDriver {
  readonly id: string
  connect(): Promise<void>
  /** Open the mic / start a turn. */
  pttDown(): void
  /** Close the mic and commit the turn. */
  pttUp(): void
  /** Barge-in: abandon the in-flight turn. */
  interrupt(): void
  disconnect(): void
  on(listener: (event: DriverEvent) => void): () => void
}

/** One pre-rendered answer, keyed by its `content/qa.json` id. */
export interface CannedAnswer {
  id: string
  /** Keyboard key that plays it from the staff hotkeys, if it has one. */
  hotkey?: string
  /** The question as a visitor would ask it. Shown as the user caption. */
  question: string
  /** Answer *with* inline gesture tags, exactly as the live LLM is prompted to emit. */
  answer: string
  /** File name under `public/fallback/`. */
  file: string
  /**
   * Cue times measured against this answer's recording, written by
   * `npm run bake:gestures`.
   *
   * Optional because a freshly authored answer has none until the bake runs, and
   * the driver falls back to the character-rate estimate rather than refusing to
   * speak. Present, it replaces that estimate entirely — the tags in `answer`
   * then only serve the captions and the word-for-word cache check.
   */
  cues?: BakedTrack
  /**
   * Per-character timings beside the MP3, when the audio was rendered by a TTS
   * that reports them.
   *
   * Written by the bake. An MP3 carries no timings of its own, so without this
   * the cached path is analyser-only and the lips never quite meet on a /m/ —
   * see audio/alignment.ts for why that one gap is the audible one.
   */
  alignmentFile?: string
}

/**
 * Optional capability: this driver can speak pre-rendered answers by id.
 *
 * Deliberately not part of `ConversationDriver` — a live driver has nothing to
 * say here, and widening the port to accommodate one adapter is how a port stops
 * being a port. The runtime feature-detects and degrades to playing the MP3
 * straight through the bus, which is what every driver could already do.
 */
export interface CannedAnswerBank {
  /** Every answer available with no network at all, in `qa.json` order. */
  readonly bank: readonly CannedAnswer[]
  /** Speak one by id, emitting the same events a live turn would. */
  speak(id: string): void
}

export function hasCannedAnswers(
  driver: ConversationDriver,
): driver is ConversationDriver & CannedAnswerBank {
  const candidate = driver as Partial<CannedAnswerBank>
  return Array.isArray(candidate.bank) && typeof candidate.speak === 'function'
}
