import type { VisionId } from '../../enubot.config.ts'
import type { VisionSource } from './types.ts'
import { NoneVisionSource } from './adapters/none.ts'
import { MediaPipeVisionSource } from './adapters/mediapipe.ts'

export function createVisionSource(id: VisionId): VisionSource {
  switch (id) {
    case 'mediapipe':
      return new MediaPipeVisionSource()
    case 'none':
      return new NoneVisionSource()
  }
}

export type { FaceObservation, HandObservation, VisionSample, VisionSource } from './types.ts'
