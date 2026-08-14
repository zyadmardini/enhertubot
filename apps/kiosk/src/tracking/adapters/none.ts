import type { VisionSample, VisionSource } from '../types.ts'

/**
 * No camera. Returning null makes GazeController fall through to its idle scan,
 * so Enubot still glances around and never freezes — it just isn't looking at
 * anyone in particular. Presence never fires, so it never greets either.
 */
export class NoneVisionSource implements VisionSource {
  readonly id = 'none'
  readonly available = true
  readonly unavailableReason = ''

  async start(): Promise<void> {}
  stop(): void {}
  read(): VisionSample | null {
    return null
  }
  setHandTracking(): void {}
}
