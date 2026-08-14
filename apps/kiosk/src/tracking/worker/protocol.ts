/**
 * Messages between the vision adapter and its worker.
 *
 * Deliberately tiny and vendor-neutral in both directions: frames go in as
 * transferable ImageBitmaps, observations come back as plain objects. Nothing
 * MediaPipe-shaped crosses this boundary, which is what keeps the worker
 * replaceable without touching the adapter.
 */

import type { VisionSample } from '../types.ts'

export interface VisionWorkerConfig {
  /** Directory holding the MediaPipe wasm bundle. */
  wasmPath: string
  /** BlazeFace short-range model. */
  faceModelPath: string
  /** Gesture recognizer task bundle — hand landmarks plus the canned classifier. */
  gestureModelPath: string
  minFaceConfidence: number
  minHandConfidence: number
}

export type ToVisionWorker =
  | { type: 'init'; config: VisionWorkerConfig }
  | { type: 'frame'; bitmap: ImageBitmap; t: number; hands: boolean }
  | { type: 'close' }

export type FromVisionWorker =
  | { type: 'ready' }
  | { type: 'failed'; reason: string }
  | { type: 'sample'; sample: VisionSample }
