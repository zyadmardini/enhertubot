/** Minimal typed event emitter. Kept local so core has zero dependencies. */

export type Listener<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  #listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, listener: Listener<Events[K]>): () => void {
    let set = this.#listeners.get(event)
    if (!set) {
      set = new Set()
      this.#listeners.set(event, set)
    }
    set.add(listener as Listener<never>)
    return () => this.off(event, listener)
  }

  off<K extends keyof Events>(event: K, listener: Listener<Events[K]>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>)
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event)
    if (!set) return
    // Copy first: a listener may unsubscribe itself while we iterate.
    for (const listener of [...set]) (listener as Listener<Events[K]>)(payload)
  }

  clear(): void {
    this.#listeners.clear()
  }
}
