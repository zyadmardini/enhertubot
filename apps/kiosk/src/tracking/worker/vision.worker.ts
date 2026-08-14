/// <reference lib="webworker" />

/**
 * Face and hand inference, off the main thread.
 *
 * MediaPipe's `detectForVideo` / `recognizeForVideo` run *synchronously* on the
 * calling thread. On the main thread that is a multi-millisecond stall several
 * times a second, landing inside a 16.6ms frame budget — visible as a hitch in
 * head motion, which is precisely the thing head tracking exists to make smooth.
 * So it runs here instead, and the main thread only pays for grabbing a frame.
 *
 * Privacy: inference is entirely on-device. No frame leaves the machine, nothing
 * is recorded, nothing is uploaded. Worth saying out loud on a booth sign — it's
 * a design property, not a disclaimer.
 */

import { FaceDetector, FilesetResolver, GestureRecognizer } from '@mediapipe/tasks-vision'
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import type { FromVisionWorker, ToVisionWorker, VisionWorkerConfig } from './protocol.ts'
import type { FaceObservation, HandObservation } from '../types.ts'

/** Palm plane: wrist, index knuckle, pinky knuckle. Stable while the fingers move. */
const PALM_LANDMARKS = [0, 5, 17] as const

const scope = self as unknown as DedicatedWorkerGlobalScope

let faceDetector: FaceDetector | null = null
let gestureRecognizer: GestureRecognizer | null = null

/** MediaPipe requires strictly increasing timestamps per graph. */
let lastFaceTs = 0
let lastHandTs = 0

const post = (message: FromVisionWorker): void => scope.postMessage(message)

scope.onmessage = (event: MessageEvent<ToVisionWorker>): void => {
  const message = event.data
  switch (message.type) {
    case 'init':
      void init(message.config)
      break
    case 'frame':
      onFrame(message.bitmap, message.t, message.hands)
      break
    case 'close':
      faceDetector?.close()
      gestureRecognizer?.close()
      faceDetector = null
      gestureRecognizer = null
      scope.close()
      break
  }
}

async function init(config: VisionWorkerConfig): Promise<void> {
  try {
    const fileset = await FilesetResolver.forVisionTasks(config.wasmPath)

    // Sequential rather than concurrent: both compile wasm and fight for the
    // same GPU context during setup, and this runs once at boot where a hundred
    // milliseconds costs nothing.
    faceDetector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: config.faceModelPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      minDetectionConfidence: config.minFaceConfidence,
    })

    gestureRecognizer = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: config.gestureModelPath, delegate: 'GPU' },
      runningMode: 'VIDEO',
      // One hand. A second doubles the landmark cost to tell us something we
      // already know — that somebody is waving.
      numHands: 1,
      minHandDetectionConfidence: config.minHandConfidence,
      minTrackingConfidence: config.minHandConfidence,
    })

    post({ type: 'ready' })
  } catch (error) {
    post({ type: 'failed', reason: error instanceof Error ? error.message : String(error) })
  }
}

function onFrame(bitmap: ImageBitmap, t: number, hands: boolean): void {
  let face: FaceObservation | null = null
  let hand: HandObservation | null = null

  try {
    if (faceDetector) {
      const { width, height } = bitmap
      lastFaceTs = Math.max(lastFaceTs + 1, Math.round(t * 1000))
      face = nearestFace(faceDetector.detectForVideo(bitmap, lastFaceTs).detections, width, height)

      // The expensive half, skipped entirely unless the runtime asked for it.
      if (hands && gestureRecognizer) {
        lastHandTs = Math.max(lastHandTs + 1, Math.round(t * 1000))
        hand = readHand(gestureRecognizer.recognizeForVideo(bitmap, lastHandTs))
      }
    }
  } catch {
    // A dropped frame is not worth a console line fifteen times a second. It
    // reports as "nobody there", which the presence tracker's dropout tolerance
    // absorbs; only a sustained failure reaches behaviour, and that reads
    // correctly as an empty booth.
  } finally {
    // Answer every frame, even a failed one, so the adapter's in-flight slot
    // always clears — otherwise one GPU hiccup stalls the pump permanently.
    post({ type: 'sample', sample: { t, face, hand } })
    // A leaked ImageBitmap holds GPU memory, and this runs ~54,000 times an hour
    // on the booth machine.
    bitmap.close()
  }
}

interface DetectionLike {
  boundingBox?: { originX: number; originY: number; width: number; height: number }
  categories: Array<{ score: number }>
}

/**
 * Nearest visitor = largest box. Simple, and it survives a crowd better than
 * anything cleverer, because the person closest to the kiosk is almost always
 * the one about to talk to it.
 */
function nearestFace(detections: DetectionLike[], width: number, height: number): FaceObservation | null {
  let best: DetectionLike | null = null
  let bestArea = 0
  for (const detection of detections) {
    const box = detection.boundingBox
    if (!box) continue
    const area = box.width * box.height
    if (area > bestArea) {
      bestArea = area
      best = detection
    }
  }

  const box = best?.boundingBox
  if (!box || width === 0 || height === 0) return null

  return {
    x: -(((box.originX + box.width / 2) / width) * 2 - 1),
    y: ((box.originY + box.height / 2) / height) * 2 - 1,
    size: bestArea / (width * height),
    confidence: best?.categories[0]?.score ?? 1,
  }
}

interface GestureResultLike {
  landmarks: NormalizedLandmark[][]
  gestures: Array<Array<{ categoryName: string; score: number }>>
}

function readHand(result: GestureResultLike): HandObservation | null {
  const landmarks = result.landmarks[0]
  if (!landmarks || landmarks.length === 0) return null

  let sumX = 0
  let sumY = 0
  for (const index of PALM_LANDMARKS) {
    const point = landmarks[index]
    if (!point) return null
    sumX += point.x
    sumY += point.y
  }
  const cx = sumX / PALM_LANDMARKS.length
  const cy = sumY / PALM_LANDMARKS.length

  // Openness comes from the canned classifier rather than landmark geometry —
  // it's already computed on this frame, and it's tuned for exactly this.
  const top = result.gestures[0]?.[0]
  const openness = top?.categoryName === 'Open_Palm' ? top.score : 0

  return {
    x: -(cx * 2 - 1),
    y: cy * 2 - 1,
    openness,
    confidence: top?.score ?? 0,
  }
}
