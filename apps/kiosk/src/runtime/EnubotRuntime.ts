import config from '../../enubot.config.ts'
import { AudioBus } from '../audio/AudioBus.ts'
import { LipSync } from '../audio/lipsync.ts'
import { createFaceRenderer } from '../face/index.ts'
import type { FaceRenderer } from '../face/types.ts'
import { createVisionSource } from '../tracking/index.ts'
import type { VisionSample, VisionSource } from '../tracking/types.ts'
import { createDriver } from '../voice/index.ts'
import { hasCannedAnswers } from '../voice/types.ts'
import type { CannedAnswer, ConversationDriver } from '../voice/types.ts'
import { ConversationMachine, pressToVoiceMs } from '../core/machine.ts'
import { GestureScheduler, parseGestureTags } from '../core/gestures.ts'
import { GazeController } from '../core/gaze.ts'
import type { GazeOutput } from '../core/gaze.ts'
import { PresenceTracker } from '../core/presence.ts'
import { WaveDetector } from '../core/wave.ts'
import { Greeter } from '../core/greeter.ts'
import type { GreetTrigger } from '../core/greeter.ts'
import { LatencyTracker } from '../core/latency.ts'
import { Emitter } from '../core/emitter.ts'
import { hashString } from '../core/random.ts'
import type { ConversationState, GestureName } from '../core/types.ts'
import { STATE_EXPRESSIONS, TAG_EXPRESSIONS } from '../core/types.ts'

/**
 * How much of the voice the driver has in hand.
 *
 * `total` is 0 until a driver says it has something to warm, and a driver that
 * never says so is ready as soon as it connects — the mock synthesises its
 * babble and a live socket has no bank to download.
 */
export interface VoiceReadiness {
  done: number
  total: number
  ready: boolean
}

interface RuntimeEvents extends Record<string, unknown> {
  state: ConversationState
  gesture: GestureName
  captions: { user: string; agent: string }
  latency: { last: number | null; p50: number | null; p95: number | null }
  health: boolean
  /** A visitor arrived at, or left, the booth. */
  presence: boolean
  /** Enubot decided to say hello, and why. */
  greeting: GreetTrigger
  /** Boot progress for the voice. See VoiceReadiness. */
  voice: VoiceReadiness
}

/**
 * Wires the four clocks together.
 *
 *   per-turn     (~seconds)  → state machine, driven by pipeline events
 *   per-frame    (60fps)     → mouth + gaze, driven by the AudioBus analyser
 *   per-sentence (1–3s)      → gestures, scheduled against audio playback position
 *   per-detection (15Hz)     → presence + wave, driven by camera samples
 *
 * They are deliberately decoupled: a stalled network slows the turn clock without
 * freezing the face, a dropped frame doesn't desynchronise a gesture, and vision
 * running at a quarter of the frame rate doesn't make the head move in steps.
 *
 * This class owns no React. The scene reads `gaze` and subscribes to `gesture`
 * each frame; React subscribes only to the low-frequency events, so nothing
 * re-renders at 60fps.
 */
export class EnubotRuntime extends Emitter<RuntimeEvents> {
  readonly bus: AudioBus
  readonly face: FaceRenderer
  readonly machine: ConversationMachine
  readonly latency = new LatencyTracker()

  #lipSync: LipSync
  #vision: VisionSource
  #gazeController: GazeController
  #presence: PresenceTracker
  #wave: WaveDetector
  #greeter: Greeter
  #scheduler: GestureScheduler
  #driver: ConversationDriver
  #unsubscribers: Array<() => void> = []

  /** Latest gaze solution. Read by the scene every frame — never allocate here. */
  gaze: GazeOutput = { yaw: 0, pitch: 0, gazeX: 0, gazeY: 0, tracking: false, attention: 0 }

  #userText = ''
  #agentText = ''
  #turnHasAudio = false
  /** Baked cues arrived for this turn, so the tag estimate must not also run. */
  #turnHasCues = false
  /**
   * Bumped every turn and mixed into the animation seed.
   *
   * Without it the same cached answer would draw the same variants every time it
   * played — deterministic, reproducible, and exactly the repetition the
   * variation exists to break.
   */
  #turnCounter = 0
  #healthTimer: ReturnType<typeof setInterval> | null = null
  #voice: VoiceReadiness = { done: 0, total: 0, ready: false }
  #unlockOff: (() => void) | null = null

  /** Capture time of the last sample fed to presence/wave — they must not see one twice. */
  #lastSampleT = -1
  /** Wall time at which a greeting's expression hands back to the state expression. */
  #expressionHoldUntil = 0
  #handTracking = false

  constructor() {
    super()
    this.bus = new AudioBus()
    this.face = createFaceRenderer(config.face)
    this.machine = new ConversationMachine()
    this.#lipSync = new LipSync(this.bus, config.lipSync)
    this.#vision = createVisionSource(config.vision)
    this.#gazeController = new GazeController(config.gazeTuning)
    this.#presence = new PresenceTracker(config.presence)
    this.#wave = new WaveDetector(config.wave)
    this.#greeter = new Greeter(config.greeting)
    this.#scheduler = new GestureScheduler({
      leadSeconds: config.gesture.leadSeconds,
      charsPerSecond: config.gesture.charsPerSecond,
      jitterSeconds: config.gesture.jitterSeconds,
      optionalChance: config.gesture.optionalChance,
    })
    this.#driver = createDriver(config.driver, {
      audioContext: this.bus.ctx,
      proxyUrl: config.proxyUrl,
    })

    this.#wire()
  }

  /** Whether the camera pipeline came up. False means the idle scan, never a failure. */
  get visionAvailable(): boolean {
    return this.#vision.available
  }

  get visionStatus(): string {
    return this.#vision.available ? this.#vision.id : this.#vision.unavailableReason
  }

  /** True while a visitor is standing at the booth. */
  get visitorPresent(): boolean {
    return this.#presence.present
  }

  /** How much of the voice is downloaded and decoded. Boot waits on this. */
  get voice(): VoiceReadiness {
    return this.#voice
  }

  /**
   * Bring everything up, in parallel, and never behind the visitor.
   *
   * The order here was the whole of the cold-start problem. It used to be
   * `await unlock()` → `await vision.start()` → `connect()`, which is three
   * serial waits with the one thing a visitor actually notices at the end of
   * them. Worse, the first of the three does not resolve at all until the
   * browser has seen a user gesture, so on any machine without the kiosk's
   * autoplay flag the answer cache did not begin downloading until the first
   * press — and that press then waited for the manifest, a fetch and a decode
   * before it made a sound.
   *
   * Now: unlock is fire-and-forget, vision and voice start together, and the
   * driver is the one that gets awaited, because it is the one boot is waiting
   * for. Vision coming up late costs eye contact for a second; voice coming up
   * late costs the answer.
   */
  async start(): Promise<void> {
    void this.bus.unlock()
    this.#unlockOff = this.bus.unlockOnFirstGesture()

    // Vision never rejects — every failure path inside it degrades to the idle
    // scan — but it is started rather than awaited regardless: on the booth build
    // it is a worker, ~10MB of wasm and models, and a camera permission prompt,
    // none of which the answer cache should be queued behind.
    const vision = this.#vision.start().catch((error: unknown) => {
      console.warn('[enubot] Vision failed to start; falling back to the idle scan.', error)
    })

    try {
      await this.#driver.connect()
      // A driver with nothing to warm — the mock, a live socket — is ready as
      // soon as it is connected.
      if (this.#voice.total === 0) this.#setVoice({ done: 0, total: 0, ready: true })
    } catch (error) {
      // A driver that can't connect must not take the scene down with it: the
      // attract loop, tracking and canned answers all still work without it.
      console.error('[enubot] Driver failed to connect.', error)
      this.emit('health', false)
      // And it must not hold boot behind a warm that is never coming.
      this.#setVoice({ ...this.#voice, ready: true })
    }

    this.#healthTimer = setInterval(() => void this.#checkHealth(), 10_000)
    void this.#checkHealth()
    await vision
  }

  /** Push-to-talk pressed. Also the barge-in path. */
  pttDown(): void {
    void this.bus.unlock()
    if (this.machine.state === 'speaking' || this.machine.state === 'thinking') this.#abandonTurn()
    this.#resetTurn()
    this.machine.send({ type: 'ptt_down' })
    this.#driver.pttDown()
  }

  pttUp(): void {
    if (this.machine.state !== 'listening') return
    this.machine.send({ type: 'ptt_up' })
    this.#driver.pttUp()
  }

  /**
   * Pre-rendered answers this driver can speak with no network at all.
   *
   * Empty for a driver with no bank, which is the honest answer — the staff
   * hotkeys are then bound to nothing rather than to ten ids that may or may not
   * have audio behind them.
   */
  get cannedAnswers(): readonly CannedAnswer[] {
    return hasCannedAnswers(this.#driver) ? this.#driver.bank : []
  }

  /**
   * Play a pre-rendered answer by its `content/qa.json` id. The staff hotkeys.
   *
   * Routed through the driver when it has a bank, so this path emits captions and
   * gestures like any other turn. Playing the file straight at the bus — which is
   * what this used to do, and still does for a driver with no bank — gets you
   * audio with a still body, because nothing ever parsed the answer text.
   */
  async playCanned(id: string): Promise<void> {
    void this.bus.unlock()
    this.#abandonTurn()
    this.#resetTurn()
    this.machine.send({ type: 'ptt_down' })
    this.machine.send({ type: 'ptt_up' })

    if (hasCannedAnswers(this.#driver)) {
      this.#driver.speak(id)
      return
    }

    try {
      await this.bus.playUrl(`/fallback/${id}.mp3`)
      this.machine.send({ type: 'audio_start' })
    } catch (error) {
      console.error('[enubot] Canned audio failed to play.', error)
      this.machine.send({ type: 'error', recoverable: true })
    }
  }

  /** Called once per rendered frame. The per-frame clock. */
  frame(dt: number): void {
    const now = performance.now() / 1000

    const { mouthOpen, viseme } = this.#lipSync.update(dt)
    this.face.setMouth(mouthOpen, viseme)

    // Gaze runs every frame off the newest sample, so head motion stays smooth
    // between detections rather than stepping at the detector's rate.
    const sample = this.#vision.read()
    this.gaze = this.#gazeController.update(dt, sample?.face ?? null)
    this.face.setGaze(this.gaze.gazeX, this.gaze.gazeY)

    // Presence and wave run once per *detection*. Feeding them the same sample
    // four times would fill the wave window with duplicates and evict the real
    // motion before it could be measured.
    if (sample !== null && sample.t !== this.#lastSampleT) {
      this.#lastSampleT = sample.t
      this.#onVisionSample(sample)
    }

    if (this.#expressionHoldUntil !== 0 && now >= this.#expressionHoldUntil) {
      this.#expressionHoldUntil = 0
      this.face.setExpression(STATE_EXPRESSIONS[this.machine.state])
    }

    this.face.update(dt)

    // The gesture clock reads audio playback position, not wall time, so a late
    // buffer delays the gesture with the speech instead of orphaning it.
    if (this.bus.isPlaying) this.#scheduler.update(this.bus.playbackSeconds)
  }

  dispose(): void {
    if (this.#healthTimer !== null) clearInterval(this.#healthTimer)
    this.#unlockOff?.()
    this.#unlockOff = null
    for (const off of this.#unsubscribers) off()
    this.#unsubscribers = []
    this.#driver.disconnect()
    this.#vision.stop()
    this.face.dispose()
    void this.bus.dispose()
    this.clear()
  }

  /**
   * The per-detection clock: who is here, are they waving, do we say hello.
   *
   * Timestamps come from the sample rather than from `performance.now()`, so
   * every window here is measured against when the camera actually saw
   * something — not when a frame happened to be rendered.
   */
  #onVisionSample(sample: VisionSample): void {
    const event = this.#presence.update(sample.t, sample.face)
    const waved = this.#wave.update(sample.t, sample)

    if (event !== null) {
      this.emit('presence', event === 'arrived')
      // A blink on noticing someone. One frame of "oh, hello" before anything
      // else moves, which is what stops the wave reading as a canned loop.
      if (event === 'arrived') this.face.blink()
    }

    const greeting = this.#greeter.consider(sample.t, {
      event,
      waved,
      visitorId: this.#presence.visitorId,
      idle: this.machine.state === 'idle',
    })
    if (greeting !== null) this.#greet(greeting, sample.t)

    // The hand pipeline costs several times what face detection does, so it only
    // runs where a wave could actually change anything: someone in frame, no
    // turn under way, and not still inside the last greeting's cooldown.
    const wanted =
      sample.face !== null && this.machine.state === 'idle' && !this.#greeter.inCooldown(sample.t)
    if (wanted !== this.#handTracking) {
      this.#handTracking = wanted
      this.#vision.setHandTracking(wanted)
      if (!wanted) this.#wave.reset()
    }
  }

  #greet(trigger: GreetTrigger, now: number): void {
    // Through the same event the scheduler uses, so the body crossfades into the
    // wave and back out exactly as it does mid-answer.
    this.emit('gesture', 'wave')
    this.face.setExpression('happy')
    this.#expressionHoldUntil = now + config.greeting.expressionHoldSeconds
    this.emit('greeting', trigger)
  }

  #wire(): void {
    this.#unsubscribers.push(
      this.machine.on('state', ({ to }) => {
        // A turn starting outranks a greeting that hasn't finished holding its
        // happy face — otherwise the expression snaps back a beat into listening.
        this.#expressionHoldUntil = 0
        this.face.setExpression(STATE_EXPRESSIONS[to])
        this.emit('state', to)
      }),

      this.machine.on('turn', (turn) => {
        const ms = pressToVoiceMs(turn)
        if (ms !== null) this.latency.add(ms)
        this.emit('latency', {
          last: this.latency.last,
          p50: this.latency.p(50),
          p95: this.latency.p(95),
        })
      }),

      this.#scheduler.on('fire', (name) => this.emit('gesture', name)),

      // A tagged expression holds until the state machine next changes state,
      // which at end of utterance puts the face back to the idle pose on its
      // own. No timer needed, and none that can outlive the answer.
      this.#scheduler.on('express', (name) => this.face.setExpression(TAG_EXPRESSIONS[name])),

      this.bus.onEnded(() => {
        this.machine.send({ type: 'audio_end' })
        this.#scheduler.flush()
        // The next utterance restarts the playback clock at zero, so spans left
        // over from this one would land on unrelated syllables.
        this.#lipSync.alignment.clear()
      }),

      this.#driver.on((event) => {
        switch (event.type) {
          case 'user_transcript':
            this.#userText = event.text
            this.emit('captions', { user: this.#userText, agent: this.#agentText })
            if (event.final) this.machine.send({ type: 'transcript_final', text: event.text })
            break

          case 'agent_text': {
            // Tags are stripped here and nowhere else — nothing downstream should
            // ever see a `[wave]` in text destined for TTS or captions.
            const parsed = parseGestureTags(event.text)
            this.#agentText = parsed.clean
            this.emit('captions', { user: this.#userText, agent: this.#agentText })
            this.machine.send({ type: 'agent_text', text: parsed.clean, done: event.done })
            if (event.done && !this.#turnHasCues) {
              this.#reseed(parsed.clean)
              this.#scheduler.schedule(parsed)
            }
            break
          }

          case 'cues': {
            // Measured beats replace estimated ones outright. Flushing first
            // rather than merging is deliberate: the two describe the same
            // gestures, so keeping both would fire every one of them twice.
            this.#turnHasCues = true
            this.#scheduler.flush()
            this.#reseed(this.#agentText)
            this.#scheduler.scheduleBaked(event.track)
            break
          }

          case 'audio': {
            if (!this.#turnHasAudio) {
              this.#turnHasAudio = true
              this.machine.send({ type: 'audio_start' })
            }
            // The offset comes back from the bus rather than being tracked here,
            // so the closure track cannot drift out of step with the schedule it
            // is describing.
            const offsetSeconds = this.bus.enqueue(event.buffer)
            if (event.alignment) this.#lipSync.alignment.append(event.alignment, offsetSeconds)
            // Re-time the queue against real duration; the char-rate estimate can
            // be a few hundred ms out on a long answer.
            const duration = this.bus.durationSeconds
            if (duration !== null) this.#scheduler.calibrate(duration)
            break
          }

          case 'warming':
            this.#setVoice({
              done: event.done,
              total: event.total,
              ready: event.done >= event.total,
            })
            break

          case 'error':
            console.error('[enubot] Driver error:', event.message)
            this.machine.send({ type: 'error', recoverable: event.recoverable })
            break
        }
      }),
    )
  }

  #setVoice(next: VoiceReadiness): void {
    this.#voice = next
    this.emit('voice', next)
  }

  /** Clear last turn's captions so the new one doesn't start with stale text. */
  #resetTurn(): void {
    this.#userText = ''
    this.#agentText = ''
    this.#turnHasAudio = false
    this.#turnHasCues = false
    this.#turnCounter += 1
    this.emit('captions', { user: '', agent: '' })
  }

  /**
   * Seed this utterance's variation.
   *
   * Text and turn number together: the same answer varies between plays, and a
   * given (answer, turn) pair reproduces exactly — which is the only way a
   * "it shrugged in the wrong place" report is chaseable.
   */
  #reseed(text: string): void {
    this.#scheduler.reseed(hashString(text) ^ Math.imul(this.#turnCounter, 0x9e3779b1))
  }

  /** Barge-in: silence audio, drop queued gestures, abandon the driver turn. */
  #abandonTurn(): void {
    this.bus.stop()
    this.#scheduler.flush()
    this.#lipSync.alignment.clear()
    this.#driver.interrupt()
    this.machine.send({ type: 'interrupt' })
    this.#turnHasAudio = false
  }

  async #checkHealth(): Promise<void> {
    try {
      const response = await fetch(`${config.proxyUrl}/health`, { signal: AbortSignal.timeout(3000) })
      this.emit('health', response.ok)
    } catch {
      // Proxy unreachable. The UI drops to canned mode; tracking and the attract
      // loop keep running, so the booth still looks alive with no network at all.
      this.emit('health', false)
    }
  }
}
