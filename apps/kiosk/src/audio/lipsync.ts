import type { AudioBus } from './AudioBus.ts'
import { AlignmentTrack } from './alignment.ts'
import type { ArticulationDetail } from './alignment.ts'
import { VisemeTrack } from './visemes.ts'

export interface LipSyncOptions {
  attackSeconds: number
  releaseSeconds: number
  noiseFloor: number
  /**
   * Query the timed tracks this far ahead of playback position.
   *
   * Both timed sources are predictive where the analyser is reactive, and the
   * face adds its own lag on top: the mouth blends over ~30ms and the frame it is
   * drawn on is already up to 16ms old. Leading by roughly that sum lands the
   * gesture on the sound rather than just after it.
   *
   * The bus's own output latency is subtracted from this at query time, because
   * it pulls the other way — what a visitor is hearing at this instant left the
   * mixer some milliseconds ago, so part of the lead is already spent. See
   * `AudioBus.outputLatencySeconds`.
   */
  articulationLeadSeconds: number
  /** Shortest an articulation may render for. See AlignmentTrackOptions. */
  minArticulationSeconds: number
  /** How much of the spelling to trust. See ArticulationDetail. */
  articulationDetail: ArticulationDetail
  /**
   * Shortest a viseme may be shown for before another may replace it.
   *
   * A jaw has mass. Real speech changes mouth shape roughly 5 to 8 times a
   * second; both of this class's sources can ask for changes far faster than
   * that — the analyser flickers between neighbouring vowels when the band ratio
   * sits on a threshold, and estimated character timings fire at a flat ~14 per
   * second regardless of what the speaker did. Neither is a real articulation,
   * and the result reads as a twitch.
   *
   * This is a floor on shape duration, not a smoothing filter: the shapes stay
   * crisp, there are just fewer of them. `PP` is exempt — see `#hold`.
   *
   * Does not apply to the measured track. See `minMeasuredSeconds`.
   */
  minVisemeSeconds: number
  /**
   * Floor on a *measured* shape's duration. See VisemeTrackOptions.
   *
   * Separate from `minVisemeSeconds`, and much smaller, because the two solve
   * opposite problems. That one suppresses flicker from sources that change
   * shape faster than a jaw can; this one only guarantees a shape that really
   * did happen survives long enough to be drawn on a frame.
   */
  minMeasuredSeconds: number
  /** Vowel and fricative classifier thresholds. See `VisemeBands`. */
  bands: VisemeBands
}

/**
 * Where the analyser draws its lines.
 *
 * Exposed as config because these are the numbers that want tuning against a
 * real voice — a bright voice or an aggressive TTS compressor moves them, and
 * the failure mode ("the mouth is mushy") is a judgement call, not a test.
 */
export interface VisemeBands {
  /** First formant window, Hz. High energy here means an open jaw. */
  f1: [number, number]
  /** Second formant window, Hz. High relative to F1 means a front vowel. */
  f2: [number, number]
  /**
   * Postalveolar window, Hz. /ʃ/ and /tʃ/ dump their noise here — roughly an
   * octave below /s/, which is the entire acoustic difference between "sip" and
   * "ship" and the reason the two can be told apart without help from spelling.
   */
  postalveolar: [number, number]
  /** Sibilant window, Hz. Broadband noise up here and nowhere else is /s/. */
  sibilant: [number, number]
  /** Fricative energy above this multiple of the voiced bands reads as noise. */
  sibilantRatio: number
  /**
   * F2:F1 thresholds, descending. Above `ih` is close and spread, below `oh` is
   * fully rounded, and the three in between step through the vowel space in the
   * order a jaw actually travels it.
   */
  ih: number
  E: number
  aa: number
  oh: number
}

/**
 * The Meta OVR viseme set, verbatim.
 *
 * Chosen over a bespoke list because it is the one vocabulary every downstream
 * thing already speaks: it maps 1:1 onto `XR_META_face_tracking_visemes`, onto
 * ARKit-style blendshape rigs, and onto the Rhubarb A–H sheet a 2D illustrator
 * would draw from. If the face ever becomes a sprite sheet or a 3D rig — both of
 * which the FaceRenderer seam exists to allow — the shape names survive the swap.
 *
 * Fifteen is more than this pipeline can fill from audio alone, and that is the
 * point: the analyser supplies the vowels and sibilants, character alignment
 * supplies the tongue and lips, and the set is sized for both together rather
 * than for whichever source happens to be present.
 */
export type Viseme =
  | 'sil'
  | 'PP'
  | 'FF'
  | 'TH'
  | 'DD'
  | 'kk'
  | 'CH'
  | 'SS'
  | 'nn'
  | 'RR'
  | 'aa'
  | 'E'
  | 'ih'
  | 'oh'
  | 'ou'

export interface LipSyncFrame {
  /** 0..1, drives FaceRenderer.setMouth. */
  mouthOpen: number
  viseme: Viseme
}

/**
 * Ceiling on how far each shape may open the jaw.
 *
 * The envelope still drives the mouth underneath; these only cap it. Without the
 * cap a consonant inherits the aperture of the vowel beside it, which is how
 * "yes" used to end with the jaw hanging open — the /s/ carries real energy, and
 * a slow release leaves the mouth wide through it.
 *
 * `PP` at zero is what makes it worth detecting at all: pressed lips are the one
 * shape an analyser cannot tell apart from silence.
 *
 * Keyed by viseme rather than by source, so a /s/ is a narrow tense slot whether
 * the analyser heard the sibilance, the spelling implied it, or an aligner
 * measured it. The vowels are deliberately absent: their aperture is the
 * envelope's to decide, which is what makes a shouted "aa" bigger than a
 * muttered one.
 */
const APERTURE: Partial<Record<Viseme, number>> = {
  PP: 0,
  /** Not zero — /f/ shows a slot between the teeth and the lower lip. */
  FF: 0.28,
  /** Wide enough for the tongue tip to be visible between the teeth. */
  TH: 0.34,
  DD: 0.3,
  nn: 0.3,
  /** A velar drops the jaw more than a coronal does; /k/ is a visibly open sound. */
  kk: 0.4,
  /** The postalveolar pair are rounded and slightly more open than /s/. */
  CH: 0.3,
  RR: 0.38,
  /** /w/ is a pucker, and a pucker needs depth or it reads as a pressed lip. */
  ou: 0.5,
  /** A sibilant is a narrow tense slot, near enough closed. */
  SS: 0.22,
}

/**
 * Drives the mouth from Enubot's own speech.
 *
 * Reads the shared bus, so it neither knows nor cares which TTS produced the
 * audio — that indifference is the whole point of the AudioBus rule.
 *
 * The envelope is deliberately asymmetric: fast attack so the mouth opens on
 * the consonant, slow release so it doesn't flutter shut between syllables.
 *
 * Two sources, layered. The analyser is the baseline and runs for every audio
 * source including pre-rendered cache answers, which carry no timing data at
 * all. When a vendor does supply character alignment it is overlaid on top, and
 * only for the consonants — see alignment.ts for why that split is where it is.
 */
export class LipSync {
  /** Alignment sink. Empty means pure DSP, which is the cached-answer path. */
  readonly alignment: AlignmentTrack
  /**
   * Measured phone sink, filled from a `<id>.phones.json` sidecar when the bake
   * has produced one. Outranks both other sources wherever it has something to
   * say — see visemes.ts.
   */
  readonly visemes: VisemeTrack

  #bus: AudioBus
  #opts: LipSyncOptions
  #time: Uint8Array<ArrayBuffer>
  #freq: Uint8Array<ArrayBuffer>
  #level = 0
  /** The viseme actually being shown, and how long it has been shown for. */
  #held: Viseme = 'sil'
  #heldSeconds = 0
  /** Bin windows resolved once from the sample rate — never per frame. */
  #f1: [number, number]
  #f2: [number, number]
  #postalveolar: [number, number]
  #sibilant: [number, number]

  constructor(bus: AudioBus, opts: LipSyncOptions) {
    this.#bus = bus
    this.#opts = opts
    this.#time = new Uint8Array(bus.analyser.fftSize)
    this.#freq = new Uint8Array(bus.analyser.frequencyBinCount)
    this.alignment = new AlignmentTrack({
      minArticulationSeconds: opts.minArticulationSeconds,
      detail: opts.articulationDetail,
    })
    this.visemes = new VisemeTrack({ minSpanSeconds: opts.minMeasuredSeconds })

    // Bands are declared in Hz and used as bin indices. Deriving them from the
    // real sample rate is the whole reason they're meaningful: the previous
    // "top third of the bins" split put the boundary at 8kHz, which is above
    // every speech formant there is, so it was measuring hiss against hiss.
    const binHz = bus.sampleRate / bus.analyser.fftSize
    const bins = (range: [number, number]): [number, number] => [
      Math.max(0, Math.floor(range[0] / binHz)),
      Math.min(this.#freq.length, Math.ceil(range[1] / binHz)),
    ]
    this.#f1 = bins(opts.bands.f1)
    this.#f2 = bins(opts.bands.f2)
    this.#postalveolar = bins(opts.bands.postalveolar)
    this.#sibilant = bins(opts.bands.sibilant)
  }

  update(dt: number): LipSyncFrame {
    this.#heldSeconds += dt

    if (!this.#bus.isPlaying) {
      // Decay to closed rather than snapping, or the mouth clacks shut on every pause.
      this.#level += (0 - this.#level) * releaseAlpha(dt, this.#opts.releaseSeconds)
      // Silence is not a shape the hold should argue with: when the audio stops
      // the mouth closes, whatever it was mid-way through showing.
      this.#held = 'sil'
      this.#heldSeconds = 0
      return { mouthOpen: this.#gate(), viseme: 'sil' }
    }

    this.#bus.getTimeDomainData(this.#time)
    let sumSquares = 0
    for (let i = 0; i < this.#time.length; i++) {
      const sample = ((this.#time[i] ?? 128) - 128) / 128
      sumSquares += sample * sample
    }
    // RMS of a normalised waveform rarely exceeds ~0.3 on speech; scale to fill 0..1.
    const rms = Math.sqrt(sumSquares / this.#time.length)
    const target = Math.min(1, rms * 3.2)

    const alpha =
      target > this.#level
        ? releaseAlpha(dt, this.#opts.attackSeconds)
        : releaseAlpha(dt, this.#opts.releaseSeconds)
    this.#level += (target - this.#level) * alpha

    // The envelope is advanced before any override, never inside the branch —
    // an articulation that froze the level would make the mouth lurch back open
    // the moment it released.
    const at = this.#bus.playbackSeconds + this.#lead()

    // Three sources, most-informed first. A measured phone outranks a spelling
    // because it is the same fact without the guess, and both outrank the
    // analyser because it cannot see a consonant at all.
    const measured = this.visemes.visemeAt(at)
    const viseme =
      measured === null ? this.#hold(this.alignment.articulationAt(at) ?? this.#viseme()) : this.#show(measured)

    // The aperture is read from whatever is actually being shown, not from what
    // was asked for: capping a held /s/ with the jaw of the vowel that replaced
    // it is how the mouth ends up open on a shape that is closed.
    const cap = APERTURE[viseme]
    return { mouthOpen: cap === undefined ? this.#gate() : Math.min(this.#gate(), cap), viseme }
  }

  /**
   * How far ahead of playback position the timed tracks are read.
   *
   * The configured lead compensates the face's own blend and one frame of render
   * lag. Output latency is the term that pulls the other way and was previously
   * missing: `playbackSeconds` is where the mixer is, and the speaker is behind
   * it by however long the device's buffer is — 10ms or so on a desktop, several
   * times that through Bluetooth or a display's audio return channel. Leading by
   * the full amount on top of that puts the mouth ahead of the sound.
   */
  #lead(): number {
    return Math.max(0, this.#opts.articulationLeadSeconds - this.#bus.outputLatencySeconds)
  }

  /**
   * Show a measured shape now, whatever is currently held.
   *
   * Deliberately not subject to `#hold`. That floor exists because the analyser
   * and the spelling both change shape faster than a mouth can, and neither
   * knows when it is wrong; a phone boundary is a measurement, and a 60ms /t/
   * that gets held back is exactly the articulation this path was added for.
   * The hold's timer is still reset, so handing back to the other sources at the
   * end of a clip starts from a clean slate rather than mid-count.
   */
  #show(viseme: Viseme): Viseme {
    if (viseme !== this.#held) {
      this.#held = viseme
      this.#heldSeconds = 0
    }
    return viseme
  }

  /**
   * Rate-limit shape changes to something a mouth could physically do.
   *
   * `PP` is the one exemption, and it earns it twice over: the lips meeting is
   * the single most visible event in speech, and it is brief enough that waiting
   * out a hold would drop it entirely. Everything else waits its turn — including
   * the shape that follows a /p/, since `#heldSeconds` resets on the way in.
   */
  #hold(requested: Viseme): Viseme {
    if (requested === this.#held) return this.#held
    if (requested !== 'PP' && this.#heldSeconds < this.#opts.minVisemeSeconds) return this.#held

    this.#held = requested
    this.#heldSeconds = 0
    return requested
  }

  #gate(): number {
    return this.#level < this.#opts.noiseFloor ? 0 : this.#level
  }

  /**
   * Mouth shape from where the energy sits, not how much of it there is.
   *
   * Two things are readable from a spectrum and worth taking. Fricative noise
   * sits well above any formant, which makes /s/ and /ʃ/ the one consonant class
   * an analyser can identify outright — and they are separable from each other
   * too, because /ʃ/ peaks about an octave lower. And the F2:F1 ratio orders the
   * vowels, because that ratio *is* what tongue position does to the spectrum.
   *
   * Everything else — the bilabials, the labiodentals, every tongue contact —
   * stays with alignment. See alignment.ts for why that split lands where it does.
   */
  #viseme(): Viseme {
    if (this.#gate() === 0) return 'sil'
    this.#bus.getFrequencyData(this.#freq)

    const f1 = this.#mean(this.#f1)
    const f2 = this.#mean(this.#f2)
    const voiced = f1 + f2
    if (voiced <= 0) return 'sil'

    const bands = this.#opts.bands
    const sibilant = this.#mean(this.#sibilant)
    const postalveolar = this.#mean(this.#postalveolar)
    if (Math.max(sibilant, postalveolar) > voiced * bands.sibilantRatio) {
      return sibilant >= postalveolar ? 'SS' : 'CH'
    }

    const ratio = f2 / Math.max(1e-6, f1)
    if (ratio > bands.ih) return 'ih'
    if (ratio > bands.E) return 'E'
    if (ratio > bands.aa) return 'aa'
    if (ratio > bands.oh) return 'oh'
    return 'ou'
  }

  #mean([lo, hi]: [number, number]): number {
    if (hi <= lo) return 0
    let sum = 0
    for (let i = lo; i < hi; i++) sum += this.#freq[i] ?? 0
    return sum / (hi - lo)
  }
}

/** Framerate-independent smoothing factor for a given time constant. */
function releaseAlpha(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / Math.max(0.001, tau))
}
