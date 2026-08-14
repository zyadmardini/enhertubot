import type { Expression } from '../core/types.ts'
import type { Viseme } from '../audio/lipsync.ts'

/**
 * The swap seam for the face.
 *
 * The illustrated sprite-sheet face (the paid add-on) is a second adapter behind
 * this exact interface — buying it changes one config line, not the pipeline.
 * Same for SVG, Lottie or Rive if art direction moves.
 */
export interface FaceRenderer {
  /** The scene wraps this in a THREE.CanvasTexture. */
  readonly canvas: HTMLCanvasElement

  setExpression(expression: Expression): void
  /** open: 0..1 */
  setMouth(open: number, viseme?: Viseme): void
  /** Both axes -1..1. */
  setGaze(x: number, y: number): void
  blink(): void

  /** Advance animation and redraw. Called once per frame. */
  update(dt: number): void
  dispose(): void
}
