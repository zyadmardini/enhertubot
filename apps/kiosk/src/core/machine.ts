import { Emitter } from './emitter.ts'
import type { ConversationState } from './types.ts'

export type MachineEvent =
  | { type: 'ptt_down' }
  | { type: 'ptt_up' }
  | { type: 'transcript_final'; text: string }
  | { type: 'agent_text'; text: string; done: boolean }
  | { type: 'audio_start' }
  | { type: 'audio_end' }
  | { type: 'interrupt' }
  | { type: 'error'; recoverable: boolean }

/**
 * Timestamps for one turn, in ms since page load (performance.now()).
 * `null` means that stage never happened — an interrupted turn has no audioEndAt.
 */
export interface TurnMetrics {
  pttDownAt: number | null
  pttUpAt: number | null
  transcriptAt: number | null
  firstTextAt: number | null
  firstAudioAt: number | null
  audioEndAt: number | null
  interrupted: boolean
}

interface MachineEvents extends Record<string, unknown> {
  state: { from: ConversationState; to: ConversationState }
  /** Fired when a turn reaches a terminal state, whether it completed or was cut off. */
  turn: TurnMetrics
  /** The visitor's question, once transcribed. */
  userText: string
  /** Enubot's answer, accumulated. */
  agentText: { text: string; done: boolean }
}

const emptyTurn = (): TurnMetrics => ({
  pttDownAt: null,
  pttUpAt: null,
  transcriptAt: null,
  firstTextAt: null,
  firstAudioAt: null,
  audioEndAt: null,
  interrupted: false,
})

/**
 * Per-turn clock: IDLE → LISTENING → THINKING → SPEAKING → IDLE.
 *
 * Pure logic — it owns no audio, no timers and no DOM, which is what makes the
 * whole turn lifecycle testable without a browser.
 */
export class ConversationMachine extends Emitter<MachineEvents> {
  #state: ConversationState = 'idle'
  #turn: TurnMetrics = emptyTurn()
  #now: () => number

  constructor(now: () => number = () => performance.now()) {
    super()
    this.#now = now
  }

  get state(): ConversationState {
    return this.#state
  }

  get turn(): Readonly<TurnMetrics> {
    return this.#turn
  }

  send(event: MachineEvent): void {
    const t = this.#now()

    switch (event.type) {
      case 'ptt_down':
        // A press during a turn is a barge-in *and* the start of the next turn.
        if (this.#state === 'speaking' || this.#state === 'thinking') this.#endTurn(t, true)
        this.#turn = emptyTurn()
        this.#turn.pttDownAt = t
        this.#transition('listening')
        break

      case 'ptt_up':
        if (this.#state !== 'listening') return
        this.#turn.pttUpAt = t
        this.#transition('thinking')
        break

      case 'transcript_final':
        this.#turn.transcriptAt ??= t
        this.emit('userText', event.text)
        break

      case 'agent_text':
        this.#turn.firstTextAt ??= t
        this.emit('agentText', { text: event.text, done: event.done })
        break

      case 'audio_start':
        if (this.#state === 'idle') return
        this.#turn.firstAudioAt ??= t
        this.#transition('speaking')
        break

      case 'audio_end':
        if (this.#state !== 'speaking') return
        this.#endTurn(t, false)
        break

      case 'interrupt':
        if (this.#state === 'idle') return
        this.#endTurn(t, true)
        break

      case 'error':
        // Unrecoverable errors still return to idle; the UI drops to canned mode
        // on its own via the proxy health check.
        if (this.#state !== 'idle') this.#endTurn(t, true)
        break
    }
  }

  #endTurn(t: number, interrupted: boolean): void {
    this.#turn.audioEndAt = interrupted ? null : t
    this.#turn.interrupted = interrupted
    this.#transition('idle')
    this.emit('turn', { ...this.#turn })
  }

  #transition(to: ConversationState): void {
    if (to === this.#state) return
    const from = this.#state
    this.#state = to
    this.emit('state', { from, to })
  }
}

/** The number that decides whether a turn reads as broken. */
export function pressToVoiceMs(turn: TurnMetrics): number | null {
  if (turn.pttUpAt === null || turn.firstAudioAt === null) return null
  return turn.firstAudioAt - turn.pttUpAt
}
