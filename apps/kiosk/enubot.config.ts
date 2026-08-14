/**
 * The single place tech choices and tuning constants live.
 *
 * Swapping a vendor means writing one adapter and changing one line here — the
 * state machine, gesture scheduler and scene never learn which vendor is behind
 * the port. See ENGINEERING-PLAN.md §1.
 */

import type { VisemeBands } from './src/audio/lipsync.ts'
import type { ArticulationDetail } from './src/audio/alignment.ts'

export type DriverId = 'cached' | 'mock' | 'elevenlabs-agents' | 'assembled'
export type FaceId = 'procedural' | 'sprite'
export type VisionId = 'mediapipe' | 'none'

export interface EnubotConfig {
  /** Which ConversationDriver adapter to instantiate. */
  driver: DriverId
  /** Which FaceRenderer adapter to instantiate. */
  face: FaceId
  /** Which VisionSource adapter to instantiate. */
  vision: VisionId

  /** Loopback proxy that holds every API key. Never call a vendor directly. */
  proxyUrl: string

  gesture: {
    /** Fire a gesture this many seconds *before* the clause it belongs to. */
    leadSeconds: number
    /** Crossfade duration between body clips. */
    crossFadeSeconds: number
    /** Fallback speech rate used to place tags before real audio timing exists. */
    charsPerSecond: number
    /**
     * ± wobble applied to every gesture time.
     *
     * The booth plays the same dozen answers all day. A little timing variation
     * is what stops the second viewing of an answer from being visibly identical
     * to the first. Small on purpose — this is texture, not choreography.
     */
    jitterSeconds: number
    /** Chance a `[nod?]` beat plays at all. Rolled once per utterance. */
    optionalChance: number
  }

  face_: {
    /** Canvas resolution. Drop to 256 if per-frame texture upload costs too much. */
    canvasSize: number
    /** Randomised blink interval, seconds. */
    blinkIntervalRange: [number, number]
    /** Chance a blink is a double-blink. */
    doubleBlinkChance: number
  }

  /** Camera and detector settings. Everything here is a cost/quality dial. */
  visionTuning: {
    /** Requested capture size. The hand needs more pixels than the face does. */
    captureWidth: number
    captureHeight: number
    /** Detection rate. The render loop still runs at 60fps; this is decoupled. */
    detectHz: number
    /** Detector confidence floors. */
    minFaceConfidence: number
    minHandConfidence: number
    /** Treat the newest sample as absent once it is this many detect ticks old. */
    staleTicks: number
  }

  gazeTuning: {
    /** Seconds for the head spring to settle. Higher reads as attention, not lock-on. */
    dampingSeconds: number
    /** Cap on head speed, normalised units/sec. Stops a target jump becoming a whip. */
    maxSpeed: number
    /** Max head rotation, radians. */
    maxYaw: number
    maxPitch: number
    /** Ignore target switches faster than this, so a crowd doesn't cause flicker. */
    switchHysteresisSeconds: number
    /** How long a face must be gone before attention starts releasing. */
    absenceGraceSeconds: number
    /** Attention crossfade: quick to notice someone, slow to let them go. */
    acquireSeconds: number
    releaseSeconds: number
    /** Detections below this confidence never move the head. */
    minConfidence: number
    /** The nobody-here drift. */
    scan: { amplitudeX: number; amplitudeY: number; speed: number }
    /** Eye-only flicks. Heads glide, eyes dart — this is the eye half. */
    saccade: { intervalRange: [number, number]; magnitude: number }
  }

  /** When a face in frame counts as a visitor arriving, and when they've left. */
  presence: {
    /** Continuous detection needed before it counts as an arrival. */
    arrivalSeconds: number
    /** Absence needed before it counts as a departure. */
    departureSeconds: number
    /** A dropped detection shorter than this doesn't interrupt anything. */
    dropoutToleranceSeconds: number
    /** Fraction of frame area the face box must cover — ignores passers-by. */
    minFaceSize: number
    /** Reacquiring this far from the last position counts as a different person. */
    newVisitorJump: number
  }

  /** Wave detection: open palm, raised, oscillating laterally. */
  wave: {
    /** Analysis window. Long enough for ~3 swings, short enough to feel prompt. */
    windowSeconds: number
    /** Direction changes required within the window. */
    minReversals: number
    /** Peak-to-peak lateral travel required, normalised units. */
    minAmplitude: number
    /** Movement below this is noise, not a swing. */
    minSegment: number
    /** Mean open-palm score across the window. Motion blur costs us frames. */
    minOpenness: number
    /** Hand must sit no lower than this below the face centre (y is +down). */
    maxYBelowFace: number
    /** Ceiling used when no face is detected. */
    maxY: number
    /** Ignore further waves this long after one fires. */
    refractorySeconds: number
  }

  /** When Enubot waves back. */
  greeting: {
    /** Wave at someone who walks up, before they do anything. */
    onArrival: boolean
    /** Minimum gap between any two greetings — a queue can't cause a wave loop. */
    cooldownSeconds: number
    /** How long the happy expression holds after a wave. */
    expressionHoldSeconds: number
  }

  lipSync: {
    attackSeconds: number
    releaseSeconds: number
    /** Below this normalised level the mouth is treated as closed. */
    noiseFloor: number
    /**
     * How far ahead of playback position articulations are read from the
     * alignment track, compensating the face's own blend and one frame of
     * render lag.
     */
    articulationLeadSeconds: number
    /** Floor on articulation length, so a brief /p/ can't fall between two frames. */
    minArticulationSeconds: number
    /** How much of the spelling to trust. See ArticulationDetail. */
    articulationDetail: ArticulationDetail
    /** Floor on how long a mouth shape is shown. See LipSyncOptions. */
    minVisemeSeconds: number
    /** Where the analyser draws its lines. See VisemeBands. */
    bands: VisemeBands
  }

  /** Above this, a turn reads as broken to a visitor. Surfaced in the debug HUD. */
  latencyBudgetMs: number
}

const config: EnubotConfig = {
  // 'cached' is the shipping default until STT and the LLM are wired: real
  // pre-rendered speech, no network, no spend. 'mock' remains the driver with no
  // asset dependency at all — reach for it when the answer bank isn't rendered.
  driver: (import.meta.env.VITE_ENUBOT_DRIVER as DriverId) ?? 'cached',
  face: (import.meta.env.VITE_ENUBOT_FACE as FaceId) ?? 'procedural',
  // 'none' until `npm run vision:assets` has put the wasm and models in public/.
  // The adapter degrades on its own if they're missing, but defaulting to off
  // keeps a fresh clone from asking for camera permission it can't use.
  vision: (import.meta.env.VITE_ENUBOT_VISION as VisionId) ?? 'none',

  proxyUrl: import.meta.env.VITE_ENUBOT_PROXY ?? 'http://127.0.0.1:8787',

  gesture: {
    leadSeconds: 0.2,
    crossFadeSeconds: 0.25,
    charsPerSecond: 14,
    jitterSeconds: 0.06,
    optionalChance: 0.55,
  },

  face_: {
    canvasSize: 512,
    blinkIntervalRange: [3, 6],
    doubleBlinkChance: 0.1,
  },

  visionTuning: {
    captureWidth: 640,
    captureHeight: 480,
    detectHz: 15,
    minFaceConfidence: 0.5,
    minHandConfidence: 0.5,
    staleTicks: 3,
  },

  gazeTuning: {
    dampingSeconds: 0.35,
    maxSpeed: 3.5,
    maxYaw: (35 * Math.PI) / 180,
    maxPitch: (15 * Math.PI) / 180,
    switchHysteresisSeconds: 0.5,
    absenceGraceSeconds: 1.0,
    acquireSeconds: 0.25,
    releaseSeconds: 1.2,
    minConfidence: 0.4,
    scan: { amplitudeX: 0.45, amplitudeY: 0.12, speed: 0.25 },
    saccade: { intervalRange: [0.7, 2.2], magnitude: 0.05 },
  },

  presence: {
    arrivalSeconds: 0.4,
    departureSeconds: 1.5,
    dropoutToleranceSeconds: 0.5,
    // ~2.5% of frame area. A face fills roughly this much at 2m on a 60° lens;
    // anyone smaller is crossing the hall, not visiting the booth.
    minFaceSize: 0.012,
    newVisitorJump: 0.5,
  },

  wave: {
    windowSeconds: 1.3,
    minReversals: 3,
    minAmplitude: 0.1,
    minSegment: 0.025,
    minOpenness: 0.35,
    maxYBelowFace: 0.05,
    maxY: 0.15,
    refractorySeconds: 3,
  },

  greeting: {
    onArrival: true,
    cooldownSeconds: 5,
    expressionHoldSeconds: 2.5,
  },

  lipSync: {
    attackSeconds: 0.005,
    releaseSeconds: 0.07,
    noiseFloor: 0.04,
    articulationLeadSeconds: 0.045,
    minArticulationSeconds: 0.05,
    // 'full' reads the tongue out of the spelling as well as the lips. Drop to
    // 'closures' to get the conservative lips-only behaviour back — the inspector
    // page switches between them, which is the way to judge which one is better.
    articulationDetail: 'full',
    // Measured against the answer bank on 2026-08-14. Real speech changes mouth
    // shape 5–8 times a second; at 0.075 the estimated-alignment path ran at 10.2
    // and read as jittery, and at 0.13 it runs at 6.9 while still using eleven
    // distinct shapes — the rate comes down without the articulation going with
    // it. The analyser-only path drops from 8.1 to about 6 over the same change,
    // which costs nothing since its vowel flicker was never a real articulation.
    minVisemeSeconds: 0.13,
    // F1 moves with jaw opening, F2 with tongue position, and fricative noise
    // sits above both — /ʃ/ peaks around 3kHz, /s/ from roughly 4.5kHz up.
    //
    // Measured against the answer bank on 2026-08-14, not taken from a textbook.
    // Two things came out of that and both were wrong before:
    //
    //  - The /ʃ/ window ran to 4.8kHz, which swallowed the /s/ peak — the bank's
    //    /s/ tops out at 4–5kHz and stays strong to 10k, so a true /s/ was coming
    //    out as `CH`. The boundary belongs at ~4.2k, below the /s/ peak.
    //  - `sibilantRatio` was 1.05, which no frame in the bank ever reached: the
    //    analyser's bytes are dB-scaled, so a band 30dB down still reads ~130 and
    //    every ratio is compressed toward 1. Observed p90 is 0.49 and the loudest
    //    /s/ hits 1.41, so 0.62 sits in the gap. At 1.05 the /s/ in "what's" was
    //    being drawn as an open `aa` — the exact failure the band exists to stop.
    //
    // The bank is DUMMY audio (see fallback/manifest.json). Re-measure all three
    // when the real voice is rendered; `/lipsync.html` is the tool for it.
    bands: {
      f1: [200, 1000],
      f2: [1100, 2800],
      postalveolar: [2800, 4200],
      sibilant: [4500, 10000],
      sibilantRatio: 0.62,
      ih: 1.15,
      E: 0.72,
      aa: 0.42,
      oh: 0.22,
    },
  },

  latencyBudgetMs: 1500,
}

export default config
