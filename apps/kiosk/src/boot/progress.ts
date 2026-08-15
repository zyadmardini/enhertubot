import type { VoiceReadiness } from '../runtime/EnubotRuntime.ts'

/**
 * What the boot bar is measuring, and when the kiosk is worth showing anyone.
 *
 * Two downloads, and the kiosk needs both: 1.3MB of rigged character and 1.3MB
 * of pre-rendered answers. Either one arriving late is a visible failure of a
 * different kind — a stand-in robot that swaps out under the visitor, or a press
 * that stands there in silence — so boot waits for both rather than racing them
 * onto the screen as they land.
 *
 * Pure, and separate from the hook, because the interesting part is the
 * arithmetic and the arithmetic is what a test can hold still.
 */

/**
 * How the bar splits between the two.
 *
 * They are within a couple of hundred KB of each other, so an even split is close
 * to honest. Weighting by real byte counts would be more accurate and worse: the
 * totals aren't known until the response headers land, so the bar would jump
 * backwards on the first one to arrive.
 */
const MODEL_WEIGHT = 0.5

export interface BootInput {
  /** 0..1 of the character model's bytes. */
  modelRatio: number
  /**
   * Settled means the load finished *or* failed. A missing rig is an answer —
   * the placeholder stands in — and it must release boot exactly like a hit does.
   */
  modelSettled: boolean
  voice: VoiceReadiness
}

export interface BootStatus {
  /** 0..1 across everything boot is waiting for. */
  ratio: number
  /** What is being waited on, in the visitor's words. */
  label: string
  ready: boolean
}

export function bootStatus({ modelRatio, modelSettled, voice }: BootInput): BootStatus {
  const voiceRatio = voice.total > 0 ? voice.done / voice.total : voice.ready ? 1 : 0
  const ratio = clamp01(modelRatio) * MODEL_WEIGHT + clamp01(voiceRatio) * (1 - MODEL_WEIGHT)
  const ready = modelSettled && voice.ready

  return {
    ratio,
    ready,
    label: ready ? 'Ready' : !modelSettled ? 'Waking Enubot up' : 'Loading his voice',
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}
