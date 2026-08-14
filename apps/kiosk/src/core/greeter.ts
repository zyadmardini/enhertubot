import type { PresenceEvent } from './presence.ts'

export type GreetTrigger = 'arrival' | 'wave'

export interface GreetingTuning {
  /** Wave at someone who walks up, before they do anything. */
  onArrival: boolean
  /** Minimum gap between any two greetings. */
  cooldownSeconds: number
}

export interface GreetInput {
  event: PresenceEvent | null
  /** True on the sample a wave completed. */
  waved: boolean
  /** From PresenceTracker — used to greet each visitor's arrival exactly once. */
  visitorId: number
  /** False during a turn. Enubot never greets over its own conversation. */
  idle: boolean
}

/**
 * Decides whether Enubot waves back, and refuses far more often than it agrees.
 *
 * Separate from detection on purpose: whether a wave *happened* is a question
 * about the camera, and whether to *answer* it is a question about the booth.
 * They change for different reasons and they're tested with different inputs.
 *
 * The failure mode this guards against is a robot that waves constantly. On a
 * busy floor, arrivals fire whenever the nearest face changes, so the rules are:
 * never over a conversation, never twice for the same visitor's arrival, and
 * never twice inside the cooldown however good the reason.
 */
export class Greeter {
  #tuning: GreetingTuning
  #lastGreetAt = -Infinity
  #greetedVisitor = -1

  constructor(tuning: GreetingTuning) {
    this.#tuning = tuning
  }

  /** True while a greeting would be refused on timing alone. */
  inCooldown(now: number): boolean {
    return now - this.#lastGreetAt < this.#tuning.cooldownSeconds
  }

  consider(now: number, input: GreetInput): GreetTrigger | null {
    // A greeting mid-answer reads as a glitch, and the wave clip would cut
    // across the talking pose.
    if (!input.idle) return null
    if (this.inCooldown(now)) return null

    // A wave was addressed to Enubot directly, so it outranks the unprompted
    // hello — and it's worth answering even for someone already greeted on
    // arrival, because ignoring it is the one thing that reads as broken.
    if (input.waved) return this.#fire(now, 'wave', input.visitorId)

    if (input.event === 'arrived' && this.#tuning.onArrival && this.#greetedVisitor !== input.visitorId) {
      return this.#fire(now, 'arrival', input.visitorId)
    }

    return null
  }

  #fire(now: number, trigger: GreetTrigger, visitorId: number): GreetTrigger {
    this.#lastGreetAt = now
    this.#greetedVisitor = visitorId
    return trigger
  }
}
