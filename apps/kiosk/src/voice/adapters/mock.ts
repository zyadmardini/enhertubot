import type { CharAlignment } from '../../audio/alignment.ts'
import type { ConversationDriver, DriverDeps, DriverEvent } from '../types.ts'

/**
 * Scripted driver with synthesised speech. No network, no API keys, no spend.
 *
 * This exists so Weeks 2 and 3 aren't serialised on vendor accounts: the whole
 * front-end — state machine, face, gestures, lip-sync, tracking — runs and demos
 * against this. It's also what the soak test drives, and what a client review
 * runs on, since it's deterministic in a way a live LLM is not.
 */

interface MockTurn {
  question: string
  /** Answer with inline gesture tags, exactly as the real LLM is prompted to emit. */
  answer: string
}

const SCRIPT: MockTurn[] = [
  {
    question: 'What are you?',
    answer: "[wave] I'm Enubot, and I live on this screen. Ask me anything about the event.",
  },
  {
    question: 'Where is the keynote?',
    answer: "[point] Main hall, straight past the coffee. It kicks off at ten sharp.",
  },
  {
    question: 'Who built you?',
    answer: "[nod] A very patient team. They taught me roughly ten things and hoped for the best.",
  },
  {
    question: 'What is the meaning of life?',
    answer:
      "[think] Above my pay grade, honestly. [shrug] But I can tell you where the good coffee is.",
  },
]

const STT_DELAY_MS = 250
const LLM_DELAY_MS = 400
const TTS_FIRST_BYTE_MS = 150
const CHARS_PER_SECOND = 14

export class MockDriver implements ConversationDriver {
  readonly id = 'mock'
  #deps: DriverDeps
  #listeners = new Set<(event: DriverEvent) => void>()
  #timers: ReturnType<typeof setTimeout>[] = []
  #turnIndex = 0

  constructor(deps: DriverDeps) {
    this.#deps = deps
  }

  async connect(): Promise<void> {
    // Nothing to connect to — that's the point.
  }

  pttDown(): void {
    this.interrupt()
  }

  pttUp(): void {
    const turn = SCRIPT[this.#turnIndex % SCRIPT.length]
    this.#turnIndex += 1
    if (!turn) return

    this.#after(STT_DELAY_MS, () => {
      this.#emit({ type: 'user_transcript', text: turn.question, final: true })
    })

    this.#after(STT_DELAY_MS + LLM_DELAY_MS, () => {
      this.#emit({ type: 'agent_text', text: turn.answer, done: true })
    })

    this.#after(STT_DELAY_MS + LLM_DELAY_MS + TTS_FIRST_BYTE_MS, () => {
      // The runtime strips tags before this is spoken; length here is close enough
      // for a realistic duration.
      const spoken = turn.answer.replace(/\[[a-z]+\]/gi, '').trim()
      const buffer = synthesizeBabble(this.#deps.audioContext, spoken)
      this.#emit({ type: 'audio', buffer, alignment: linearAlignment(spoken, buffer.duration) })
    })
  }

  interrupt(): void {
    for (const timer of this.#timers) clearTimeout(timer)
    this.#timers = []
  }

  disconnect(): void {
    this.interrupt()
    this.#listeners.clear()
  }

  on(listener: (event: DriverEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #after(ms: number, fn: () => void): void {
    this.#timers.push(setTimeout(fn, ms))
  }

  #emit(event: DriverEvent): void {
    for (const listener of [...this.#listeners]) listener(event)
  }
}

/**
 * Character timings spread evenly across the babble.
 *
 * The babble has no real phonetics, so these times are a fiction — but they are
 * the same *shape* of fiction ElevenLabs sends, and that is what makes them
 * worth emitting: the closure track, the per-chunk offsetting and the mm/ff
 * mouth shapes all exercise in dev with no account and no spend. Without it the
 * mock covers only the analyser half, which is the half that already worked.
 */
export function linearAlignment(text: string, durationSeconds: number): CharAlignment {
  const chars = [...text]
  const perCharMs = (durationSeconds * 1000) / Math.max(1, chars.length)
  return {
    chars,
    charStartTimesMs: chars.map((_, i) => i * perCharMs),
    charDurationsMs: chars.map(() => perCharMs),
  }
}

/**
 * Speech-shaped noise: a voiced buzz under a syllable-rate envelope, with pauses
 * at sentence boundaries.
 *
 * It is deliberately not intelligible — it exists so the lip-sync analyser has a
 * realistic amplitude and spectral envelope to chew on. A sine tone would make
 * the mouth look perfect and hide exactly the bugs this is meant to surface.
 */
export function synthesizeBabble(ctx: AudioContext, text: string): AudioBuffer {
  const duration = Math.max(0.5, text.length / CHARS_PER_SECOND)
  const sampleRate = ctx.sampleRate
  const frames = Math.floor(duration * sampleRate)
  const buffer = ctx.createBuffer(1, frames, sampleRate)
  const data = buffer.getChannelData(0)

  // Silence windows where a speaker would breathe.
  const pauses: Array<[number, number]> = []
  for (let i = 0; i < text.length; i++) {
    if (/[.!?,]/.test(text[i] ?? '')) {
      const at = (i / text.length) * duration
      pauses.push([at, at + 0.16])
    }
  }

  const f0 = 118
  const syllableRate = 4.6
  let phase = 0

  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate

    let envelope = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * syllableRate * t - Math.PI / 2), 1.6)
    for (const [start, end] of pauses) {
      if (t >= start && t < end) envelope *= 0.04
    }
    // Fade the utterance in and out so it doesn't click.
    envelope *= Math.min(1, t / 0.05, (duration - t) / 0.08)

    // Slow drift in brightness so the viseme classifier sees real variation.
    const brightness = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t + 1.1)
    phase += (2 * Math.PI * (f0 + 12 * Math.sin(2 * Math.PI * 0.35 * t))) / sampleRate

    const voiced =
      Math.sin(phase) * 0.6 +
      Math.sin(phase * 2) * 0.25 * brightness +
      Math.sin(phase * 3) * 0.12 * brightness
    const fricative = (Math.random() * 2 - 1) * 0.12 * brightness

    data[i] = (voiced + fricative) * envelope * 0.35
  }

  return buffer
}
