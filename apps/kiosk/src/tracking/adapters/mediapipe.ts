import config from '../../../enubot.config.ts'
import type { FromVisionWorker, ToVisionWorker } from '../worker/protocol.ts'
import type { VisionSample, VisionSource } from '../types.ts'

const WASM_PATH = '/mediapipe/wasm'
const FACE_MODEL_PATH = '/models/blaze_face_short_range.tflite'
const GESTURE_MODEL_PATH = '/models/gesture_recognizer.task'

/** Cold wasm compile on a slow machine is a few seconds; this is only a backstop. */
const INIT_TIMEOUT_MS = 20_000

/**
 * How long a frame may be in flight before the slot is reclaimed. Deliberately
 * far longer than any real inference: the worker answers every frame including
 * failed ones, so this only ever fires for a worker that has genuinely died, and
 * a tighter value would start double-sending to one that was merely slow.
 */
const FRAME_TIMEOUT_SECONDS = 2

/**
 * Camera vision via MediaPipe, with inference in a worker.
 *
 * This side owns the camera and the pump, and nothing else: grab a frame, hand
 * it over, publish whatever comes back. Per detect tick the main thread spends
 * roughly a `createImageBitmap` call — the decode and the resize happen on the
 * browser's own image thread, and the inference happens in the worker, so the
 * render loop keeps its whole frame budget.
 *
 * Every failure path degrades to `available = false` rather than throwing.
 * Losing eye contact is a downgrade; a black screen on event day is not.
 */
export class MediaPipeVisionSource implements VisionSource {
  readonly id = 'mediapipe'

  #available = false
  #reason = 'not started'
  #worker: Worker | null = null
  #video: HTMLVideoElement | null = null
  #stream: MediaStream | null = null
  #sample: VisionSample | null = null

  #timer: ReturnType<typeof setTimeout> | null = null
  #stopped = false
  /** One frame in flight at a time — backpressure, so a slow machine lags rather than queues. */
  #inFlight = false
  #inFlightSince = 0
  #hands = false

  readonly #intervalMs = 1000 / config.visionTuning.detectHz
  readonly #staleSeconds = config.visionTuning.staleTicks / config.visionTuning.detectHz

  get available(): boolean {
    return this.#available
  }

  get unavailableReason(): string {
    return this.#available ? '' : this.#reason
  }

  async start(): Promise<void> {
    this.#stopped = false
    try {
      await this.#startWorker()
      await this.#startCamera()
      this.#available = true
      this.#reason = ''
      this.#pump()
    } catch (error) {
      // Missing wasm/model assets, no camera, or permission denied — all the same
      // outcome: fall back to the idle scan and say so once.
      this.#reason = error instanceof Error ? error.message : String(error)
      this.#available = false
      console.warn(
        '[enubot] Vision unavailable, falling back to the idle scan. ' +
          'Run `npm run vision:assets` if the wasm or models are missing, and check camera permission.',
        error,
      )
      this.stop()
    }
  }

  stop(): void {
    this.#stopped = true
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null

    this.#worker?.postMessage({ type: 'close' } satisfies ToVisionWorker)
    // The worker calls close() on itself; terminate is the belt-and-braces path
    // for one that failed before it could install its message handler.
    this.#worker?.terminate()
    this.#worker = null

    this.#stream?.getTracks().forEach((track) => track.stop())
    this.#stream = null
    this.#video?.pause()
    this.#video = null
    this.#sample = null
    this.#inFlight = false
    this.#available = false
  }

  read(): VisionSample | null {
    return this.#sample
  }

  setHandTracking(enabled: boolean): void {
    this.#hands = enabled
  }

  #startWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('../worker/vision.worker.ts', import.meta.url), {
        type: 'module',
        name: 'enubot-vision',
      })
      this.#worker = worker

      const timeout = setTimeout(() => {
        settle(new Error(`Vision worker did not start within ${INIT_TIMEOUT_MS}ms`))
      }, INIT_TIMEOUT_MS)

      let settled = false
      const settle = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        if (error) reject(error)
        else resolve()
      }

      worker.onerror = (event) => settle(new Error(event.message || 'Vision worker crashed'))
      worker.onmessage = (event: MessageEvent<FromVisionWorker>) => {
        const message = event.data
        switch (message.type) {
          case 'ready':
            settle()
            break
          case 'failed':
            settle(new Error(message.reason))
            break
          case 'sample':
            this.#inFlight = false
            this.#sample = message.sample
            break
        }
      }

      worker.postMessage({
        type: 'init',
        config: {
          wasmPath: WASM_PATH,
          faceModelPath: FACE_MODEL_PATH,
          gestureModelPath: GESTURE_MODEL_PATH,
          minFaceConfidence: config.visionTuning.minFaceConfidence,
          minHandConfidence: config.visionTuning.minHandConfidence,
        },
      } satisfies ToVisionWorker)
    })
  }

  async #startCamera(): Promise<void> {
    const { captureWidth, captureHeight } = config.visionTuning
    this.#stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: captureWidth },
        height: { ideal: captureHeight },
        frameRate: { ideal: 30 },
        facingMode: 'user',
      },
      audio: false,
    })

    const video = document.createElement('video')
    video.srcObject = this.#stream
    video.playsInline = true
    video.muted = true
    await video.play()
    this.#video = video
  }

  /**
   * Self-scheduling rather than an interval, so a slow tick delays the next one
   * instead of stacking up behind it. Deliberately not rAF: detection is decoupled
   * from rendering, and rAF would wake 60 times a second to do work 15 times.
   */
  #pump = (): void => {
    if (this.#stopped) return
    this.#timer = setTimeout(this.#pump, this.#intervalMs)

    const t = performance.now() / 1000

    // A tick that can't produce a frame still has to say something, because
    // downstream reads a missing sample as "nothing has changed" rather than as
    // "nothing is known". Without this, a camera unplugged mid-visit leaves the
    // last detection as the newest thing anyone ever sees, and the booth stays
    // convinced a visitor is standing there for the rest of the day.
    if (this.#sample !== null && t - this.#sample.t > this.#staleSeconds) {
      this.#sample = { t, face: null, hand: null }
    }

    // The frame is gone — transferred, so we don't even own the bitmap. Free the
    // slot rather than stalling the pump forever behind a worker that died.
    if (this.#inFlight && t - this.#inFlightSince > FRAME_TIMEOUT_SECONDS) this.#inFlight = false

    // Nothing on screen means nothing to look at. Chrome throttles a hidden
    // kiosk tab anyway; this makes the saving explicit and stops the camera
    // pipeline burning GPU behind a screensaver.
    if (document.hidden || this.#inFlight) return

    const video = this.#video
    const worker = this.#worker
    if (!video || !worker || video.readyState < 2) return

    this.#inFlight = true
    this.#inFlightSince = t
    const hands = this.#hands

    createImageBitmap(video)
      .then((bitmap) => {
        if (this.#stopped || this.#worker !== worker) {
          bitmap.close()
          this.#inFlight = false
          return
        }
        worker.postMessage({ type: 'frame', bitmap, t, hands } satisfies ToVisionWorker, [bitmap])
      })
      .catch(() => {
        // Camera unplugged mid-run, or a frame arrived while the track was
        // ending. Free the slot and try again on the next tick.
        this.#inFlight = false
      })
  }
}
