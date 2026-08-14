/**
 * The swap seam for "it sees you".
 *
 * Adapters report *what the camera sees*, nothing more — no debouncing, no
 * gesture recognition, no decisions. Damping, the idle scan, arrival/departure
 * debouncing, wave detection and the greeting policy all live in core/, so
 * replacing the detector — or turning it off entirely — never changes how Enubot
 * behaves.
 *
 * Coordinates are mirrored throughout: the camera faces the visitor, so their
 * left is Enubot's right. x is -1 (Enubot's left) .. 1 (right), y is -1 (up) ..
 * 1 (down). Mirroring happens once, in the adapter, and nothing downstream ever
 * thinks about it again.
 */

export interface FaceObservation {
  /** Centre of the face box, mirrored, -1..1. */
  x: number
  y: number
  /**
   * Fraction of the frame the face box covers. A distance proxy — used to ignore
   * people crossing the hall behind whoever is actually at the booth.
   */
  size: number
  confidence: number
}

export interface HandObservation {
  /** Palm centre, same mirrored frame as the face. */
  x: number
  y: number
  /** 0..1 open-palm score. A closed fist swinging past is not a greeting. */
  openness: number
  confidence: number
}

export interface VisionSample {
  /** Seconds since page load (performance.now() / 1000) at frame capture. */
  t: number
  /** Nearest face, or null when nobody is in frame. */
  face: FaceObservation | null
  /** Null whenever hand tracking is off, as well as when no hand is visible. */
  hand: HandObservation | null
}

export interface VisionSource {
  readonly id: string
  /** Resolves even when the source can't run; check `available` afterwards. */
  start(): Promise<void>
  stop(): void
  /**
   * Newest sample, or null before the first one lands. A fresh sample arrives
   * every detect tick whether or not anything was found, so `face: null` is a
   * positive statement that nobody is there — not just missing data.
   */
  read(): VisionSample | null
  /**
   * Turn the hand pipeline on and off. It costs several times what face
   * detection does, so the runtime only asks for it in the window where a wave
   * could actually matter. Cheap to call every tick; implementations ignore
   * no-op changes.
   */
  setHandTracking(enabled: boolean): void
  /** False when the detector failed to initialise — the feature degrades, never blocks. */
  readonly available: boolean
  /** Why it isn't available, for the debug HUD. Empty when it is. */
  readonly unavailableReason: string
}
