import config from '../../enubot.config.ts'
import type { FaceId } from '../../enubot.config.ts'
import type { FaceRenderer } from './types.ts'
import { ProceduralFace } from './adapters/procedural.ts'

export function createFaceRenderer(id: FaceId): FaceRenderer {
  switch (id) {
    case 'procedural':
      return new ProceduralFace({
        size: config.face_.canvasSize,
        blinkIntervalRange: config.face_.blinkIntervalRange,
        doubleBlinkChance: config.face_.doubleBlinkChance,
      })
    case 'sprite':
      // The illustrated-face add-on lands here: same interface, different draw
      // calls, zero changes anywhere else. See ENGINEERING-PLAN.md §3.2.
      throw new Error('Sprite-sheet face adapter not built yet (optional add-on).')
  }
}

export type { FaceRenderer } from './types.ts'
