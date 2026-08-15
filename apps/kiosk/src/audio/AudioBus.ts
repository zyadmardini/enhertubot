/**
 * The single audio path for everything Enubot says.
 *
 * Hard rule: no ConversationDriver adapter is allowed to play audio on its own
 * element. Every vendor's output goes through this bus, because lip-sync and
 * gesture timing both read from it — if a vendor plays audio directly, swapping
 * TTS providers silently breaks the mouth and the gesture queue.
 */

// A MediaElementAudioSourceNode can only be created once per element; a second
// call throws. Cache them so re-playing canned audio is safe.
const elementSources = new WeakMap<HTMLAudioElement, MediaElementAudioSourceNode>()

export class AudioBus {
  readonly ctx: AudioContext
  readonly master: GainNode
  readonly analyser: AnalyserNode

  #sources: AudioBufferSourceNode[] = []
  #queueStart = 0
  #queueEnd = 0
  #element: HTMLAudioElement | null = null
  #mode: 'idle' | 'buffer' | 'element' = 'idle'
  #endedCallbacks = new Set<() => void>()
  #endTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' })
    this.master = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 1024
    this.analyser.smoothingTimeConstant = 0.5
    // Analyser sits inline so it sees exactly what the speaker plays.
    this.master.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
  }

  /**
   * Browsers suspend a context created without a user gesture. The kiosk Chrome
   * flags cover this, but a stray suspended context is silent audio with no
   * error, so resume defensively on first interaction too.
   *
   * Never await this on a startup path. `resume()` on a context the browser has
   * blocked does not reject and does not resolve — the spec parks the promise
   * until user activation arrives — so anything sequenced behind it waits for the
   * visitor to touch something. Boot used to await it, which meant the answer
   * cache started downloading at the moment of the first press instead of before
   * it, and that press was the one that felt broken.
   */
  async unlock(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  /**
   * Resume on the first interaction anywhere, not just on the talk button.
   *
   * Decoding works fine on a suspended context, so the bank can warm before this
   * ever fires; what it buys is that the context is already running by the time
   * a buffer is scheduled, rather than resuming in the same tick. Returns a
   * disposer.
   */
  unlockOnFirstGesture(): () => void {
    const types = ['pointerdown', 'keydown', 'touchstart'] as const
    const onGesture = () => {
      void this.unlock()
      off()
    }
    const off = () => {
      for (const type of types) window.removeEventListener(type, onGesture)
    }
    for (const type of types) window.addEventListener(type, onGesture, { passive: true })
    return off
  }

  /**
   * Context sample rate. Exposed because the lip-sync classifier declares its
   * formant windows in Hz and has to turn them into FFT bin indices — hardcoding
   * 48kHz there silently mistunes the vowels on any device that opens at 44.1.
   */
  get sampleRate(): number {
    return this.ctx.sampleRate
  }

  /**
   * How far behind the mixer the speaker is, seconds.
   *
   * `playbackSeconds` reports where the audio graph has got to, which is not
   * where the visitor's ears have got to: the device buffer holds some
   * milliseconds of already-mixed audio that has not been heard yet. Anything
   * synchronising a *picture* to the sound has to subtract this, or it runs
   * early by exactly that much — a few milliseconds on a wired desktop output,
   * and well over a frame through Bluetooth or a TV's audio return.
   *
   * `outputLatency` is the honest number and Chrome reports it; `baseLatency`
   * covers only the graph's own buffering and is the fallback where it isn't
   * available. Zero is the safe floor: it degrades to exactly the behaviour
   * before this existed.
   */
  get outputLatencySeconds(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number }
    const reported = ctx.outputLatency ?? ctx.baseLatency
    return typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : 0
  }

  get isPlaying(): boolean {
    if (this.#mode === 'element') return this.#element ? !this.#element.paused : false
    if (this.#mode === 'buffer') return this.ctx.currentTime < this.#queueEnd
    return false
  }

  /** Playback position of the current utterance, seconds. The gesture clock. */
  get playbackSeconds(): number {
    if (this.#mode === 'element' && this.#element) return this.#element.currentTime
    if (this.#mode === 'buffer') return Math.max(0, this.ctx.currentTime - this.#queueStart)
    return 0
  }

  /** Total known duration, or null while still streaming. */
  get durationSeconds(): number | null {
    if (this.#mode === 'element' && this.#element) {
      return Number.isFinite(this.#element.duration) ? this.#element.duration : null
    }
    if (this.#mode === 'buffer') return this.#queueEnd - this.#queueStart
    return null
  }

  onEnded(cb: () => void): () => void {
    this.#endedCallbacks.add(cb)
    return () => this.#endedCallbacks.delete(cb)
  }

  /**
   * Append a decoded chunk. Chunks are scheduled back-to-back so a streamed
   * answer plays gaplessly and playbackSeconds stays continuous across them.
   *
   * Returns where this chunk begins in `playbackSeconds` space, which is what
   * per-chunk alignment data has to be offset by to land on the same clock.
   * Returned rather than exposed as a getter because the queue may restart
   * inside this call — read before it and the answer can be a chunk stale.
   */
  enqueue(buffer: AudioBuffer): number {
    if (this.#mode === 'element') this.stop()
    const now = this.ctx.currentTime
    if (this.#mode !== 'buffer' || this.#queueEnd <= now) {
      // Small lead so the first chunk isn't scheduled in the past under load.
      this.#queueStart = now + 0.02
      this.#queueEnd = this.#queueStart
      this.#mode = 'buffer'
    }

    const offsetSeconds = this.#queueEnd - this.#queueStart

    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.master)
    source.start(this.#queueEnd)
    this.#queueEnd += buffer.duration
    this.#sources.push(source)
    source.onended = () => {
      this.#sources = this.#sources.filter((s) => s !== source)
    }

    this.#scheduleEndCheck()
    return offsetSeconds
  }

  /** Play a file through the bus — used by the canned-answer fallback. */
  async playUrl(url: string): Promise<void> {
    this.stop()
    const el = new Audio(url)
    el.crossOrigin = 'anonymous'
    let source = elementSources.get(el)
    if (!source) {
      source = this.ctx.createMediaElementSource(el)
      elementSources.set(el, source)
    }
    source.connect(this.master)
    this.#element = el
    this.#mode = 'element'
    el.addEventListener('ended', () => this.#fireEnded(), { once: true })
    await el.play()
  }

  /** Barge-in. Silences everything immediately and clears the schedule. */
  stop(): void {
    if (this.#endTimer !== null) {
      clearTimeout(this.#endTimer)
      this.#endTimer = null
    }
    for (const source of this.#sources) {
      source.onended = null
      try {
        source.stop()
      } catch {
        // Already stopped or never started — nothing to unwind.
      }
      source.disconnect()
    }
    this.#sources = []
    if (this.#element) {
      this.#element.pause()
      this.#element.currentTime = 0
      this.#element = null
    }
    this.#mode = 'idle'
    this.#queueStart = 0
    this.#queueEnd = 0
  }

  // The buffer type parameter is explicit: the Web Audio typings reject a
  // Uint8Array that might be backed by a SharedArrayBuffer.
  getTimeDomainData(out: Uint8Array<ArrayBuffer>): void {
    this.analyser.getByteTimeDomainData(out)
  }

  getFrequencyData(out: Uint8Array<ArrayBuffer>): void {
    this.analyser.getByteFrequencyData(out)
  }

  async dispose(): Promise<void> {
    this.stop()
    this.#endedCallbacks.clear()
    await this.ctx.close()
  }

  #scheduleEndCheck(): void {
    if (this.#endTimer !== null) clearTimeout(this.#endTimer)
    const msUntilEnd = (this.#queueEnd - this.ctx.currentTime) * 1000
    this.#endTimer = setTimeout(() => {
      this.#endTimer = null
      // A later chunk may have arrived while we waited; only end if truly drained.
      if (this.ctx.currentTime >= this.#queueEnd - 0.01) {
        this.#mode = 'idle'
        this.#fireEnded()
      }
    }, Math.max(20, msUntilEnd + 30))
  }

  #fireEnded(): void {
    for (const cb of [...this.#endedCallbacks]) cb()
  }
}
