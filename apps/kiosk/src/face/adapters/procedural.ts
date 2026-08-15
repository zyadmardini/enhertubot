import type { Expression } from '../../core/types.ts'
import type { Viseme } from '../../audio/lipsync.ts'
import type { FaceRenderer } from '../types.ts'

export interface ProceduralFaceOptions {
  size: number
  blinkIntervalRange: [number, number]
  doubleBlinkChance: number
  /**
   * Time constant for the blend between mouth shapes, seconds.
   *
   * A ceiling on how crisp articulation can be, and worth knowing about: a shape
   * that is only shown for 40ms never fully arrives if the blend takes 40ms to
   * get there. It is deliberately slow when the source is guessing, because the
   * frame or two where a classifier changes its mind is hidden by exactly this
   * lag — and deliberately tunable now that a source exists which is not
   * guessing. See audio/visemes.ts.
   */
  shapeBlendSeconds: number
}

interface ExpressionPose {
  browRaise: number
  /** Positive lifts the inner ends (friendly, surprised); negative furrows them. */
  browAngle: number
  /** Brows are hidden at rest and fade in with expression, as in the reference art. */
  browAlpha: number
  /** Extra lift on one brow only. Asymmetry is what makes puzzlement read. */
  browSkew: number
  eyeOpen: number
  /** Above 0.5 the eyes become upward arcs — the classic delighted squint. */
  eyeArc: number
  /** Mouth curve at rest: positive smiles, negative frowns. */
  mouthCurve: number
  eyeSquash: number
}

const POSES: Record<Expression, ExpressionPose> = {
  idle: { browRaise: 0, browAngle: 0, browAlpha: 0, browSkew: 0, eyeOpen: 1, eyeArc: 0, mouthCurve: 0.8, eyeSquash: 1 },
  listening: { browRaise: 0.42, browAngle: 0.14, browAlpha: 1, browSkew: 0, eyeOpen: 1.12, eyeArc: 0, mouthCurve: 0.5, eyeSquash: 1 },
  // Only a hint of a furrow. This is the face a visitor stares at during every
  // wait for an answer, and a hard inward brow there reads as annoyed, not busy.
  thinking: { browRaise: 0.24, browAngle: -0.1, browAlpha: 1, browSkew: 0.62, eyeOpen: 0.92, eyeArc: 0, mouthCurve: 0.2, eyeSquash: 0.97 },
  talking: { browRaise: 0.14, browAngle: 0.08, browAlpha: 0.4, browSkew: 0, eyeOpen: 1, eyeArc: 0, mouthCurve: 0.72, eyeSquash: 1 },
  happy: { browRaise: 0.48, browAngle: 0.26, browAlpha: 0.75, browSkew: 0, eyeOpen: 1, eyeArc: 1, mouthCurve: 1, eyeSquash: 1 },
  confused: { browRaise: 0.3, browAngle: 0.22, browAlpha: 1, browSkew: 0.85, eyeOpen: 1.05, eyeArc: 0, mouthCurve: -0.2, eyeSquash: 1 },
  // Brows high and level, eyes wide. The lift does the work here, so the mouth
  // stays near neutral — a big brow and a big smile together reads as a cartoon
  // double-take rather than "oh, really?".
  surprised: { browRaise: 0.95, browAngle: 0.1, browAlpha: 1, browSkew: 0, eyeOpen: 1.32, eyeArc: 0, mouthCurve: 0.12, eyeSquash: 1.06 },
  // Inner ends up, symmetrically. That single shape is what separates apologetic
  // from sulky; the skewed version of it is `confused`, and mixing the two gets
  // you a robot that looks like it is blaming the visitor.
  sorry: { browRaise: 0.34, browAngle: 0.44, browAlpha: 1, browSkew: 0, eyeOpen: 0.88, eyeArc: 0, mouthCurve: -0.32, eyeSquash: 0.96 },
}

/**
 * One viseme, as a set of dials rather than a drawing.
 *
 * Every field is blended frame to frame, which is what lets fifteen shapes coexist
 * without the mouth looking like a flipbook — at syllable rate a hard cut between
 * two of these reads as a glitch, not as speech.
 */
interface MouthShape {
  /** Lateral spread. 1 is neutral; above spreads, below purses. */
  width: number
  /** Aperture depth, multiplying the envelope. */
  height: number
  /**
   * Corner fillet radius, as a fraction of half-width.
   *
   * The single most important number in this table. Every viseme is drawn from
   * the same path with the same kind of corner, so the mouth never changes its
   * corner language mid-sentence — the previous version drew a cusped lens for
   * the spread shapes and a bare ellipse for the rounded ones, which is two
   * different mouths on one face. A rounded vowel is rounder here because its
   * radius is larger, not because it is a different primitive.
   */
  corner: number
  /**
   * How much of the resting smile the shape keeps. See the note at `dip`.
   *
   * Owns the shut end of the range, where there is no aperture for `hood` to be a
   * fraction of: `sil` and `PP` are nothing but this number.
   */
  smile: number
  /**
   * How far the middle of the upper lip arches *above* the mouth corners, as a
   * fraction of the aperture.
   *
   * The dial the reference sheet is really about, and the one this mouth had no
   * equivalent of. A lip line that only ever sags below its corners can draw a
   * smile and nothing else, so every shape came out a crescent of some size —
   * whereas almost everything on Blair's sheet that opens is *hooded*: a ∩ over the
   * aperture, corners pinched under it, and the mass hanging off the jaw below.
   *
   * A fraction of the aperture rather than a length, and that is the whole reason
   * it works. At 0.5 the lip rises exactly as far as the floor drops and the shape
   * is a symmetric ring — which is what `Ō` and `Ū/OO/Q/W` are, and what no fixed
   * offset could produce, since the same offset that rounds a small aperture leaves
   * a large one a teardrop. Near 0.2 it is the shallow hood over `Ē` and `C/D/S/T`.
   * At 0 the corners are the highest point and the shape is a plain crescent.
   *
   * It also costs nothing at rest: a closed mouth has no aperture, so the arch
   * scales itself out of the way and the shape relaxes into `smile` alone rather
   * than snapping between two regimes.
   */
  hood: number
  /**
   * How far the whole mouth hangs below its resting line, as a fraction of the
   * aperture.
   *
   * The other half of what `hood` starts. The arch lifts the top lip off the
   * corners, and without something carrying the mass back down the open vowels
   * climb the face instead of opening downward. A fraction again, so a jaw that has
   * not dropped cannot hang.
   */
  jawDrop: number
  /**
   * Length of the strokes that carry each corner past where the lips meet, as a
   * multiple of TICK_UNIT. 0 leaves the corner bare.
   *
   * Straight off the reference, where every spread shape has them and no rounded
   * one does — which is the tell that they are not decoration. They run along the
   * upper lip's own tangent, so they flick up and out of a smile and down and out
   * of an arch, and a lip line that overshoots its corner reads as drawn where one
   * that stops dead reads as machined.
   */
  cornerTick: number
  /** How far the upper teeth hang below the top lip, 0..1. */
  teethUpper: number
  /** How far the lower teeth rise above the bottom lip, 0..1. */
  teethLower: number
  /**
   * Separations between the upper teeth, 0..1.
   *
   * Only earns its place where the teeth *are* the viseme — /f/, /s/, /iː/ — and
   * there it is the difference between a clenched bite and a white bar across the
   * mouth. Left off everything else, where it would be grit in the aperture.
   */
  teethSplit: number
  /** Tongue prominence: 0 leaves it out of sight on the floor, 1 raises it fully. */
  tongue: number
  /** How high the raised tongue reaches: 0 at the upper lip, 1 at the floor. */
  tongueDepth: number
  /**
   * How much of the tongue reads in front of the teeth.
   *
   * Only /θ/ needs this, and /θ/ needs it completely: a tongue tip drawn behind
   * the upper teeth is a /d/, and "the" is too common a word to render as "de".
   */
  tongueFront: number
  /**
   * The short arc above the lip: the upper lip pushed up by a protrusion.
   *
   * The reference draws it on exactly the rounded four — `Ō`, `Ū/OO/Q/W`, `R`,
   * `CH/SH` — and nowhere else, because it is the only way a flat drawing can show
   * lips coming *toward* the viewer. Without it a pucker is just a small mouth, and
   * a small mouth at this scale is a mouth that is nearly shut.
   */
  philtrum: number
  /** The crease under the lower lip, 0..1. Tracks the jaw. See `#drawCreases`. */
  chin: number
  /** Lip weight. Pursed shapes carry a heavier line, as real lips do when rounded. */
  lip: number
}

/**
 * The fifteen OVR visemes, drawn.
 *
 * Vowel proportions come from the F2:F1 order the analyser already sorts them
 * into — spread and close at `ih`, open at `aa`, rounded at `oh` and `ou` — so
 * the drawing and the classifier describe the same axis rather than two.
 *
 * The consonants come from character alignment and are capped there (see
 * APERTURE in audio/lipsync.ts), so their `height` multiplies an already-small
 * number and has to be well above 1 to compensate. Tuned so each keeps roughly
 * 20–34px of aperture at a 512px canvas: below about 16px the upper teeth alone
 * fill the opening and every tongue consonant collapses into the same slot,
 * which is precisely the failure the viseme sheet exists to catch.
 *
 * They run larger than they used to for a structural reason, not a taste one. A
 * shape whose corners are its highest point gets some of its silhouette free from
 * the smile it is sitting on; a hooded one does not, because the arch is *inside*
 * the aperture. Once the top lip was allowed above the corners, the opening had to
 * carry the whole read on its own.
 *
 * Teeth and tongue follow the one rule worth taking from Preston Blair: the
 * upper teeth are pinned to the top lip and never move relative to it, which
 * locks the upper jaw to the skull. Everything that opens, opens downward.
 *
 * `smile`, `hood` and `jawDrop` are read off Blair's sheet together, and they only
 * make sense together. Almost every shape there that opens is hooded — a ∩ on
 * top, corners pinched below it, mass hanging low — and reproducing that took all
 * three: the arch alone lifts the mouth up the face, the drop alone deepens a
 * slot, and the smile alone is the crescent this set used to be made of. The two
 * shapes that stay shut, `sil` and `PP`, are the smile and nothing else, which is
 * exactly the resting face this character already had.
 */
const MOUTH_SHAPES: Record<Viseme, MouthShape> = {
  // Rest. Nothing shows, so only width and corner matter — but they still have
  // to be the neutral the other fourteen blend out of.
  sil: { width: 1, height: 1, corner: 0.12, smile: 1, hood: 0, jawDrop: 0, cornerTick: 0.3, teethUpper: 0, teethLower: 0, teethSplit: 0, tongue: 0, tongueDepth: 0.6, tongueFront: 0, philtrum: 0, chin: 0.85, lip: 1 },
  // Pressed, not merely closed. Slightly wider, a heavier line and a flatter bow
  // than `sil`, plus the corner ticks Blair gives `B, M, P` and not `Closed` —
  // which together are the whole visible difference between a rest and a /p/.
  PP: { width: 1.12, height: 0, corner: 0.12, smile: 0.55, hood: 0, jawDrop: 0, cornerTick: 0.75, teethUpper: 0, teethLower: 0, teethSplit: 0, tongue: 0, tongueDepth: 0.6, tongueFront: 0, philtrum: 0, chin: 1, lip: 1.18 },
  // Upper teeth on the lower lip. The teeth fill the aperture almost completely;
  // that near-blocked slot is the read, not the gap — and the splits are what
  // keep it reading as a bite rather than as a white bar.
  FF: { width: 0.86, height: 1.35, corner: 0.14, smile: 0.85, hood: 0.12, jawDrop: 0.2, cornerTick: 0.5, teethUpper: 1, teethLower: 0, teethSplit: 1, tongue: 0, tongueDepth: 0.8, tongueFront: 0, philtrum: 0, chin: 1, lip: 1.05 },
  TH: { width: 0.9, height: 1.7, corner: 0.16, smile: 0.55, hood: 0.2, jawDrop: 0.26, cornerTick: 0.5, teethUpper: 0.75, teethLower: 0.25, teethSplit: 0.35, tongue: 1, tongueDepth: 0.16, tongueFront: 1, philtrum: 0, chin: 1, lip: 1 },
  // Tongue tip up behind the upper teeth. The same gesture as `nn`, and separated
  // from it the way Blair separates `C, D, S, T` from `N` — by how much of the slot
  // the tongue blocks, not by the lips. A /d/ is a tap that clears; an /n/ is held,
  // and fills it. Drawn with one tongue between them the pair was one drawing.
  DD: { width: 0.9, height: 1.85, corner: 0.14, smile: 0.6, hood: 0.18, jawDrop: 0.24, cornerTick: 0.6, teethUpper: 0.6, teethLower: 0.35, teethSplit: 0.3, tongue: 0.75, tongueDepth: 0.3, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  // A velar drops the jaw and humps the tongue at the back, which from the front
  // reads as an open mouth with a low floor rather than as a tongue at all. The
  // deepest arch of the consonants, which is what Blair's `ĭ, EH, G, J, K` is.
  kk: { width: 0.98, height: 1.4, corner: 0.13, smile: 0.4, hood: 0.3, jawDrop: 0.34, cornerTick: 0.55, teethUpper: 0.4, teethLower: 0.3, teethSplit: 0, tongue: 0.75, tongueDepth: 0.6, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  // Rounded and protruded, teeth close together. Sits deliberately between `SS`
  // and `ou`: that is where /ʃ/ is articulated and where it has to look — which
  // is why it takes a philtrum and `SS` does not.
  CH: { width: 0.7, height: 1.7, corner: 0.3, smile: 0.5, hood: 0.3, jawDrop: 0.24, cornerTick: 0.15, teethUpper: 0.8, teethLower: 0.6, teethSplit: 0.5, tongue: 0.5, tongueDepth: 0.5, tongueFront: 0, philtrum: 0.55, chin: 1, lip: 1.12 },
  // Wide and barely open, teeth clenched. The clench is the sibilant.
  SS: { width: 1.1, height: 1.55, corner: 0.12, smile: 0.7, hood: 0.15, jawDrop: 0.2, cornerTick: 0.7, teethUpper: 1, teethLower: 1, teethSplit: 0.9, tongue: 0, tongueDepth: 0.7, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  nn: { width: 1.02, height: 1.85, corner: 0.14, smile: 0.5, hood: 0.24, jawDrop: 0.26, cornerTick: 0.5, teethUpper: 0.55, teethLower: 0.35, teethSplit: 0.3, tongue: 1, tongueDepth: 0.14, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  // Bunched mid-tongue, lips slightly rounded. Little teeth: an /r/ hides them.
  RR: { width: 0.82, height: 1.45, corner: 0.2, smile: 0.6, hood: 0.3, jawDrop: 0.24, cornerTick: 0.2, teethUpper: 0.35, teethLower: 0.25, teethSplit: 0, tongue: 0.75, tongueDepth: 0.42, tongueFront: 0, philtrum: 0.45, chin: 1, lip: 1.06 },
  // The open vowel, and the shape the whole arch exists for: hooded on top,
  // corners pinched to points below it, the mass hanging off the jaw.
  aa: { width: 1, height: 1.15, corner: 0.12, smile: 0.3, hood: 0.32, jawDrop: 0.4, cornerTick: 0.7, teethUpper: 0.45, teethLower: 0.3, teethSplit: 0, tongue: 0.65, tongueDepth: 0.62, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  E: { width: 1.12, height: 0.85, corner: 0.12, smile: 0.45, hood: 0.26, jawDrop: 0.32, cornerTick: 0.75, teethUpper: 0.55, teethLower: 0.4, teethSplit: 0.25, tongue: 0.65, tongueDepth: 0.58, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  // Blair's `Ē`: the widest and shallowest of the set, and the one that most
  // needs its corner ticks — at this aperture the lip lines nearly meet, and the
  // overshoot is what stops the two of them reading as a single drawn line.
  ih: { width: 1.34, height: 0.62, corner: 0.12, smile: 0.6, hood: 0.18, jawDrop: 0.26, cornerTick: 0.8, teethUpper: 0.8, teethLower: 0.55, teethSplit: 0.5, tongue: 0.7, tongueDepth: 0.45, tongueFront: 0, philtrum: 0, chin: 1, lip: 1 },
  // Large corner radius, not a different primitive — see `corner`. The hood near
  // 0.5 is what closes the top of the ring, and no fillet substitutes for it: a
  // rounded shape whose corners are its highest point is a letter D on its back.
  oh: { width: 0.52, height: 1.6, corner: 0.55, smile: 0.2, hood: 0.46, jawDrop: 0.24, cornerTick: 0, teethUpper: 0.2, teethLower: 0.15, teethSplit: 0, tongue: 0.45, tongueDepth: 0.72, tongueFront: 0, philtrum: 0.85, chin: 1, lip: 1.1 },
  // Tighter and taller than `oh`, or the two rounded vowels are the same drawing
  // and the classifier's extra band did nothing visible. Carries the strongest
  // philtrum in the set: /w/ and /uː/ are the most protruded sounds English has.
  ou: { width: 0.34, height: 1.15, corner: 0.8, smile: 0.15, hood: 0.5, jawDrop: 0.2, cornerTick: 0, teethUpper: 0, teethLower: 0, teethSplit: 0, tongue: 0.15, tongueDepth: 0.9, tongueFront: 0, philtrum: 1, chin: 0.85, lip: 1.22 },
}

/** Palette lifted from the client's character. */
const INK = '#1b2447'
const PLATE = '#ffffff'
/** Barely there — the faceplate should be sensed, not seen, against a white head. */
const PLATE_EDGE = '#f3f5fb'
const RIM = '#5a4fcf'
const HIGHLIGHT = '#ffffff'

/**
 * The inside of the mouth: three steps of the same blue-purple, darkest to lightest.
 *
 * Staying inside the existing two-colour palette is what keeps a mouth with teeth
 * and a tongue in it from turning the character into a different character. Pink
 * and white would be more literal and would read as a cut-out pasted onto a robot.
 */
const CAVITY = '#151c3d'
const CAVITY_DEEP = '#0b1029'
const TONGUE = '#6f63d6'
const TEETH = '#dfe2f6'

/** Below this the aperture is a line, and the fill has nothing to show. */
const CLOSED_EPSILON = 0.003

/** Corner-tick length at `cornerTick: 1`, as a fraction of canvas size. */
const TICK_UNIT = 0.027

/**
 * Lip weight, as a fraction of canvas size. One number for every mouth state.
 *
 * It has to be one number. A stroke straddles its path, so on an open mouth
 * every pixel of weight costs two pixels of aperture — which is why this is as
 * light as it is. But a closed mouth drawn heavier to compensate for having
 * nothing else in it makes the shut states read as a different, bolder character
 * than the talking ones, and the switch between them lands on every /p/.
 */
const LIP_WIDTH = 0.011

/**
 * Flat 2D face drawn to a canvas each frame and mapped onto the 3D head.
 *
 * Follows the client's character: solid dark-navy features on a light faceplate,
 * with a purple rim. Note the eyes have no visible sclera — so gaze shifts the
 * whole eye shape rather than sliding a pupil inside it, which is what keeps it
 * looking like their robot instead of a generic avatar.
 *
 * Everything is parametric rather than keyframed, so expressions blend into one
 * another instead of popping — the difference between a character and a slideshow.
 */
export class ProceduralFace implements FaceRenderer {
  readonly canvas: HTMLCanvasElement
  #ctx: CanvasRenderingContext2D
  #size: number
  #opts: ProceduralFaceOptions

  #target: ExpressionPose = POSES.idle
  #current: ExpressionPose = { ...POSES.idle }
  #mouthOpen = 0
  #mouthOpenCurrent = 0
  #viseme: Viseme = 'sil'
  /** Blended mouth dials. The viseme sets a target; this is what gets drawn. */
  #shape: MouthShape = { ...MOUTH_SHAPES.sil }
  #gazeX = 0
  #gazeY = 0
  #gazeXCurrent = 0
  #gazeYCurrent = 0

  #blinkTimer = 0
  #blinkPhase = 0
  #blinkQueued = 0

  constructor(opts: ProceduralFaceOptions) {
    this.#opts = opts
    this.#size = opts.size
    this.canvas = document.createElement('canvas')
    this.canvas.width = opts.size
    this.canvas.height = opts.size
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('ProceduralFace: 2D canvas context unavailable')
    this.#ctx = ctx
    this.#blinkTimer = this.#nextBlinkDelay()
  }

  setExpression(expression: Expression): void {
    this.#target = POSES[expression]
  }

  setMouth(open: number, viseme: Viseme = 'aa'): void {
    this.#mouthOpen = Math.max(0, Math.min(1, open))
    this.#viseme = viseme
  }

  setGaze(x: number, y: number): void {
    this.#gazeX = Math.max(-1, Math.min(1, x))
    this.#gazeY = Math.max(-1, Math.min(1, y))
  }

  blink(): void {
    this.#blinkPhase = 1
  }

  update(dt: number): void {
    this.#advance(dt)
    this.#draw()
  }

  dispose(): void {
    this.canvas.width = 0
    this.canvas.height = 0
  }

  #advance(dt: number): void {
    const blend = 1 - Math.exp(-dt / 0.12)
    const t = this.#target
    const c = this.#current
    c.browRaise += (t.browRaise - c.browRaise) * blend
    c.browAngle += (t.browAngle - c.browAngle) * blend
    c.browAlpha += (t.browAlpha - c.browAlpha) * blend
    c.browSkew += (t.browSkew - c.browSkew) * blend
    c.eyeOpen += (t.eyeOpen - c.eyeOpen) * blend
    c.eyeArc += (t.eyeArc - c.eyeArc) * blend
    c.mouthCurve += (t.mouthCurve - c.mouthCurve) * blend
    c.eyeSquash += (t.eyeSquash - c.eyeSquash) * blend

    // The mouth tracks far faster than expression — it has to keep up with syllables.
    const mouthBlend = 1 - Math.exp(-dt / 0.03)
    this.#mouthOpenCurrent += (this.#mouthOpen - this.#mouthOpenCurrent) * mouthBlend

    // Shape blends a touch slower than aperture. The envelope is a real signal and
    // should arrive on time; the viseme is a classification, and letting it slide
    // in hides the frame or two where the classifier changes its mind — at the
    // cost of blunting the shapes that were right. See `shapeBlendSeconds`.
    const shapeBlend = 1 - Math.exp(-dt / this.#opts.shapeBlendSeconds)
    const target = MOUTH_SHAPES[this.#viseme]
    const shape = this.#shape
    for (const key of Object.keys(shape) as Array<keyof MouthShape>) {
      shape[key] += (target[key] - shape[key]) * shapeBlend
    }

    const gazeBlend = 1 - Math.exp(-dt / 0.09)
    this.#gazeXCurrent += (this.#gazeX - this.#gazeXCurrent) * gazeBlend
    this.#gazeYCurrent += (this.#gazeY - this.#gazeYCurrent) * gazeBlend

    // Blink: a 180ms down-up cycle on a randomised timer, with occasional doubles.
    this.#blinkTimer -= dt
    if (this.#blinkTimer <= 0) {
      this.#blinkPhase = 1
      this.#blinkQueued = Math.random() < this.#opts.doubleBlinkChance ? 1 : 0
      this.#blinkTimer = this.#nextBlinkDelay()
    }
    if (this.#blinkPhase > 0) {
      this.#blinkPhase -= dt / 0.18
      if (this.#blinkPhase <= 0) {
        this.#blinkPhase = 0
        if (this.#blinkQueued > 0) {
          this.#blinkQueued -= 1
          this.#blinkPhase = 1
        }
      }
    }
  }

  #nextBlinkDelay(): number {
    const [lo, hi] = this.#opts.blinkIntervalRange
    return lo + Math.random() * (hi - lo)
  }

  #draw(): void {
    const ctx = this.#ctx
    const s = this.#size
    const c = this.#current

    ctx.clearRect(0, 0, s, s)
    ctx.save()
    ctx.translate(s / 2, s / 2)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'

    this.#drawPlate(ctx, s)

    // sin() eases both ends of the blink; 1 is open, 0 fully shut.
    const lid = 1 - Math.sin(this.#blinkPhase * Math.PI)
    const eyeOpenAmount = Math.max(0.05, c.eyeOpen * lid)

    const eyeDx = s * 0.155
    const eyeY = -s * 0.045
    // Gaze shifts the whole eye: these eyes are solid, so there is no pupil to slide.
    const gx = this.#gazeXCurrent * s * 0.024
    const gy = this.#gazeYCurrent * s * 0.018

    this.#drawBrows(ctx, s, c, eyeDx, eyeY, gx)

    for (const side of [-1, 1]) {
      const x = side * eyeDx + gx
      const y = eyeY + gy
      const rx = s * 0.078
      const ry = s * 0.098 * eyeOpenAmount * c.eyeSquash

      // Delighted squint: the eye becomes an upward arc. Blending the arc in over
      // the filled eye rather than switching between them keeps the change smooth.
      if (c.eyeArc > 0.5 && lid > 0.5) {
        ctx.strokeStyle = INK
        ctx.lineWidth = s * 0.032
        ctx.beginPath()
        ctx.arc(x, y + ry * 0.45, rx * 1.12, Math.PI * 1.14, Math.PI * 1.86)
        ctx.stroke()
        continue
      }

      ctx.fillStyle = INK
      ctx.beginPath()
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2)
      ctx.fill()

      // Highlight dot: the single cheapest thing that stops solid eyes reading as dead.
      if (eyeOpenAmount > 0.4) {
        ctx.fillStyle = HIGHLIGHT
        ctx.globalAlpha = 0.92
        ctx.beginPath()
        ctx.ellipse(x - rx * 0.3, y - ry * 0.36, rx * 0.29, rx * 0.29, 0, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
    }

    this.#drawMouth(ctx, s, c.mouthCurve, gx)
    ctx.restore()
  }

  /** Light faceplate with a purple rim, matching the character's visor. */
  #drawPlate(ctx: CanvasRenderingContext2D, s: number): void {
    const rx = s * 0.4
    const ry = s * 0.42

    const gradient = ctx.createRadialGradient(0, -s * 0.06, s * 0.05, 0, 0, ry)
    gradient.addColorStop(0, PLATE)
    gradient.addColorStop(1, PLATE_EDGE)
    ctx.fillStyle = gradient
    ctx.beginPath()
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()

    // Only a whisper of an edge. The saturated purple belongs to the 3D headband —
    // drawing a hard ring here as well doubles it up and reads as spectacles.
    ctx.strokeStyle = RIM
    ctx.lineWidth = s * 0.011
    ctx.globalAlpha = 0.28
    ctx.beginPath()
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  #drawBrows(
    ctx: CanvasRenderingContext2D,
    s: number,
    c: ExpressionPose,
    eyeDx: number,
    eyeY: number,
    gx: number,
  ): void {
    if (c.browAlpha < 0.02) return
    ctx.save()
    ctx.globalAlpha = Math.min(1, c.browAlpha)
    ctx.strokeStyle = INK
    ctx.lineWidth = s * 0.024

    for (const side of [-1, 1]) {
      const x = side * eyeDx + gx * 0.6
      // Skew lifts one brow only. Symmetrical brows read as an emotion; a single
      // raised brow reads as a question, which is what puzzlement needs.
      const skew = side === 1 ? c.browSkew * s * 0.05 : 0
      const y = eyeY - s * 0.12 - c.browRaise * s * 0.032 - skew
      const tilt = c.browAngle * s * 0.075
      const half = s * 0.066

      // Positive browAngle lifts the inner end, which is the friendly direction.
      // Which physical end is "inner" flips between the two brows.
      ctx.beginPath()
      ctx.moveTo(x - half, y - side * tilt)
      ctx.quadraticCurveTo(x, y - s * 0.022, x + half, y + side * tilt)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * One aperture path, one set of corners, fifteen shapes.
   *
   * The interior is layered back to front — cavity, tongue, teeth — and clipped
   * to the aperture, so the mouth is a hole with things inside it rather than a
   * stack of decals that drift apart when the shape changes.
   *
   * Three heights build the whole thing, and every part of the mouth is placed
   * against one of them: where the corners sit, where the upper lip bows to, and
   * where the lower lip bows to. Naming them that way rather than as "the line,
   * plus an opening" is what lets a shape hood itself — the top lip is free to
   * ride above the corners, which is the move the reference sheet is built on and
   * which a top-lip-follows-the-smile model can only ever approximate downward.
   */
  #drawMouth(ctx: CanvasRenderingContext2D, s: number, curve: number, gx: number): void {
    const open = this.#mouthOpenCurrent
    const shape = this.#shape
    const y = s * 0.15
    const x = gx * 0.35

    const halfWidth = s * 0.145 * shape.width
    const aperture = s * 0.115 * open * shape.height
    // A smile lifts the corners, so in canvas space the centre of the lip dips down.
    // Generous by default: the reference character's resting face is a real smile,
    // and a timid one reads as a robot that would rather you didn't approach.
    //
    // Each viseme takes a share of it — see `smile`. A press keeps only half:
    // flattening all the way would drop the smile on every /p/, and at syllable
    // rate that reads as a twitch, not a consonant.
    const dip = curve * s * 0.105

    const cornerY = y + aperture * shape.jawDrop
    const upperY = cornerY + dip * 0.5 * shape.smile - aperture * shape.hood
    const lowerY = upperY + aperture

    if (aperture < s * CLOSED_EPSILON) {
      ctx.strokeStyle = INK
      ctx.lineWidth = s * LIP_WIDTH * shape.lip
      ctx.beginPath()
      ctx.moveTo(x - halfWidth, cornerY)
      // The control is placed so the curve's midpoint lands on `upperY`; a
      // quadratic only reaches half way to it. See `#aperturePath`.
      ctx.quadraticCurveTo(x, 2 * upperY - cornerY, x + halfWidth, cornerY)
      ctx.stroke()
      this.#drawCornerTicks(ctx, s, x, cornerY, upperY, halfWidth, shape)
      this.#drawCreases(ctx, s, x, upperY, lowerY, halfWidth, shape)
      return
    }

    this.#aperturePath(ctx, x, cornerY, upperY, lowerY, halfWidth, shape.corner * halfWidth)

    // The cavity darkens toward the middle. One gradient is the whole difference
    // between a mouth with depth and a navy sticker.
    const throatY = upperY + aperture * 0.8
    const throat = ctx.createRadialGradient(
      x,
      throatY,
      0,
      x,
      throatY,
      Math.max(halfWidth, aperture * 1.2),
    )
    throat.addColorStop(0, CAVITY_DEEP)
    throat.addColorStop(1, CAVITY)
    ctx.fillStyle = throat
    ctx.fill()

    ctx.save()
    ctx.clip()

    this.#drawTongue(ctx, x, upperY, aperture, halfWidth, shape)
    this.#drawTeeth(ctx, s, x, upperY, lowerY, halfWidth, shape)
    // /θ/ only: the tongue tip crosses in front of the teeth it is touching.
    if (shape.tongueFront > 0.02) {
      ctx.globalAlpha = Math.min(1, shape.tongueFront)
      this.#drawTongue(ctx, x, upperY, aperture, halfWidth, shape)
      ctx.globalAlpha = 1
    }

    ctx.restore()

    // Rebuilt, not reused. save/restore covers the clip but *not* the current
    // path, and the interior left the tongue ellipse as the current path — so
    // stroking here without this outlined the tongue instead of the lips, in ink,
    // wiping out the very sliver of tongue the low-crowned visemes had to show.
    this.#aperturePath(ctx, x, cornerY, upperY, lowerY, halfWidth, shape.corner * halfWidth)

    // Lip line last, over the interior, so teeth and tongue are contained by it.
    // The lip reads because the cavity behind it is darker than it is, not
    // because the line is thick — see LIP_WIDTH.
    ctx.strokeStyle = INK
    ctx.lineWidth = s * LIP_WIDTH * shape.lip
    ctx.stroke()

    this.#drawCornerTicks(ctx, s, x, cornerY, upperY, halfWidth, shape)
    this.#drawCreases(ctx, s, x, upperY, lowerY, halfWidth, shape)
  }

  /**
   * The aperture, as two lip curves joined by two corner fillets.
   *
   * A quadratic's control leg *is* its tangent at the endpoint, so trimming each
   * curve back by `radius` along that leg and bridging the gap with one more
   * quadratic through the corner point gives an exact, cheap fillet. That is the
   * whole trick: one radius dial, no special cases, and no viseme that is secretly
   * a different shape.
   *
   * Both lips are given by where they *reach* rather than by a control point, and
   * the controls are solved for — a quadratic between two equal endpoints passes
   * through the midpoint of its control and that height, so doubling back from the
   * target is exact. Worth the two multiplies: `upperY` and `lowerY` are the two
   * numbers a viseme is actually reasoned about in, and a table written in control
   * points has to keep the corner height in mind on every row to predict either.
   */
  #aperturePath(
    ctx: CanvasRenderingContext2D,
    x: number,
    cornerY: number,
    upperY: number,
    lowerY: number,
    halfWidth: number,
    radius: number,
  ): void {
    const left = x - halfWidth
    const right = x + halfWidth
    const upperCtrl = 2 * upperY - cornerY
    const lowerCtrl = 2 * lowerY - cornerY

    // Control legs at each corner, as unit vectors. Signed: the upper leg points
    // up out of the corner on a hooded shape and down into it on a smiling one,
    // and the fillet has to follow it either way.
    const upperRun = Math.hypot(halfWidth, upperCtrl - cornerY)
    const lowerRun = Math.hypot(halfWidth, lowerCtrl - cornerY)
    // Never trim more than a curve has to give, or the fillet turns inside out on
    // the flattest shapes — which is exactly where a bad corner is most visible.
    const r = Math.min(radius, upperRun * 0.42, lowerRun * 0.42)

    const upper = { x: (halfWidth / upperRun) * r, y: ((upperCtrl - cornerY) / upperRun) * r }
    const lower = { x: (halfWidth / lowerRun) * r, y: ((lowerCtrl - cornerY) / lowerRun) * r }

    ctx.beginPath()
    ctx.moveTo(left + upper.x, cornerY + upper.y)
    ctx.quadraticCurveTo(x, upperCtrl, right - upper.x, cornerY + upper.y)
    ctx.quadraticCurveTo(right, cornerY, right - lower.x, cornerY + lower.y)
    ctx.quadraticCurveTo(x, lowerCtrl, left + lower.x, cornerY + lower.y)
    ctx.quadraticCurveTo(left, cornerY, left + upper.x, cornerY + upper.y)
    ctx.closePath()
  }

  /**
   * The strokes that carry each corner past where the lips meet.
   *
   * They run along the upper lip's own tangent, extended outward, so they are
   * never a stroke stuck onto the drawing at an angle someone chose — a smile
   * flicks them up and out, an arch drops them down and out, and both are what
   * the reference draws. See `cornerTick`.
   */
  #drawCornerTicks(
    ctx: CanvasRenderingContext2D,
    s: number,
    x: number,
    cornerY: number,
    upperY: number,
    halfWidth: number,
    shape: MouthShape,
  ): void {
    if (shape.cornerTick < 0.02) return

    // The upper lip's control leg, pointing from the corner *inward*; the tick is
    // its reflection, so the two read as one continuous line through the corner.
    const dy = 2 * (upperY - cornerY)
    const run = Math.hypot(halfWidth, dy)
    const len = s * TICK_UNIT * Math.min(1.2, shape.cornerTick)
    const dx = (halfWidth / run) * len
    const dyUnit = (dy / run) * len

    ctx.save()
    ctx.strokeStyle = INK
    ctx.lineWidth = s * LIP_WIDTH * 0.95
    ctx.globalAlpha = Math.min(1, shape.cornerTick)
    for (const side of [-1, 1]) {
      const cx = x + side * halfWidth
      ctx.beginPath()
      ctx.moveTo(cx, cornerY)
      ctx.lineTo(cx + side * dx, cornerY - dyUnit)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * The two creases that give the mouth a face to sit in: the philtrum above and
   * the chin below.
   *
   * The chin line is on for every shape, at a gap that grows with the aperture, so
   * it tracks the jaw rather than floating at a fixed height — which is the whole
   * reason to draw it. Without it an open mouth is a hole in a plate; with it the
   * plate has a lower lip that the hole was cut under.
   *
   * Both are lighter than the lip and neither ever closes a shape, so they add
   * information without competing with the aperture for the eye.
   */
  #drawCreases(
    ctx: CanvasRenderingContext2D,
    s: number,
    x: number,
    upperY: number,
    lowerY: number,
    halfWidth: number,
    shape: MouthShape,
  ): void {
    ctx.save()
    ctx.strokeStyle = INK
    ctx.lineWidth = s * LIP_WIDTH * 0.72

    if (shape.philtrum > 0.02) {
      const half = Math.max(halfWidth * 0.55, s * 0.052)
      const top = upperY - s * 0.042
      ctx.globalAlpha = 0.55 * Math.min(1, shape.philtrum)
      ctx.beginPath()
      ctx.moveTo(x - half, top)
      ctx.quadraticCurveTo(x, top - s * 0.018, x + half, top)
      ctx.stroke()
    }

    if (shape.chin > 0.02) {
      const half = halfWidth * 0.46
      const below = lowerY + s * 0.042 + (lowerY - upperY) * 0.18
      ctx.globalAlpha = 0.7 * Math.min(1, shape.chin)
      ctx.beginPath()
      ctx.moveTo(x - half, below)
      ctx.quadraticCurveTo(x, below + s * 0.03, x + half, below)
      ctx.stroke()
    }

    ctx.restore()
  }

  /**
   * Upper and lower teeth, as arcades rather than strips.
   *
   * The upper set hangs a fixed distance below the top lip whatever the jaw is
   * doing — Preston Blair's rule, and the reason a mouth full of teeth still
   * reads as one head rather than two halves sliding past each other.
   */
  #drawTeeth(
    ctx: CanvasRenderingContext2D,
    s: number,
    x: number,
    innerTop: number,
    innerBottom: number,
    halfWidth: number,
    shape: MouthShape,
  ): void {
    ctx.fillStyle = TEETH
    // Generous overhang: the clip is doing the shaping, so these only need to be
    // wide enough to reach past the corners.
    const reach = halfWidth * 1.4
    const innerHeight = innerBottom - innerTop
    // Teeth are a fixed length in a real head, but a fixed length here swallows
    // the small consonant apertures whole — and a mouth that is nothing but teeth
    // is the same drawing for /d/, /n/, /r/, /k/ and /tʃ/. The ceiling keeps a
    // share of every aperture for the cavity and the tongue behind them.
    const ceiling = innerHeight * 0.52

    if (shape.teethUpper > 0.02) {
      const depth = Math.min(s * 0.034, ceiling) * shape.teethUpper
      ctx.beginPath()
      ctx.moveTo(x - reach, innerTop - depth)
      ctx.lineTo(x + reach, innerTop - depth)
      ctx.lineTo(x + reach, innerTop + depth * 0.45)
      // The biting edge bows down at the centre, following the dental arch.
      ctx.quadraticCurveTo(x, innerTop + depth * 1.35, x - reach, innerTop + depth * 0.45)
      ctx.closePath()
      ctx.fill()

      // Individual teeth, where the teeth are the viseme. Drawn in the cavity's
      // own colour rather than in ink: a dark line inside a light shape inside a
      // dark shape is one contrast too many at this size, and reads as a crack.
      if (shape.teethSplit > 0.02) {
        ctx.save()
        ctx.strokeStyle = CAVITY
        ctx.globalAlpha = 0.45 * Math.min(1, shape.teethSplit)
        ctx.lineWidth = Math.max(1, s * 0.0035)
        for (const at of [-0.63, -0.21, 0.21, 0.63]) {
          const tx = x + halfWidth * at
          ctx.beginPath()
          ctx.moveTo(tx, innerTop - depth)
          ctx.lineTo(tx, innerTop + depth * 1.1)
          ctx.stroke()
        }
        ctx.restore()
      }
    }

    if (shape.teethLower > 0.02) {
      const depth = Math.min(s * 0.024, ceiling * 0.6) * shape.teethLower
      ctx.beginPath()
      ctx.moveTo(x - reach, innerBottom + depth)
      ctx.lineTo(x + reach, innerBottom + depth)
      ctx.lineTo(x + reach, innerBottom - depth * 0.35)
      ctx.quadraticCurveTo(x, innerBottom - depth * 1.2, x - reach, innerBottom - depth * 0.35)
      ctx.closePath()
      ctx.fill()
    }
  }

  /**
   * The tongue: the floor of the mouth, raised.
   *
   * Modelled as a body that always extends below the aperture and whose *crown*
   * is the only part that moves — which is what a tongue actually does. Two dials
   * drive it: `tongueDepth` is how high the crown reaches when fully raised, and
   * `tongue` is how much of that raise happens. At zero the crown sits on the
   * floor and nothing shows; at one it reaches `tongueDepth`, which is at the
   * upper teeth for the coronals and low and back for the velars.
   *
   * Drawing it as a body rather than a free-floating dome is what stops it
   * reading as a lozenge hovering in a dark hole.
   */
  #drawTongue(
    ctx: CanvasRenderingContext2D,
    x: number,
    innerTop: number,
    innerHeight: number,
    halfWidth: number,
    shape: MouthShape,
  ): void {
    if (shape.tongue < 0.02) return

    const raised = shape.tongueDepth + (1 - shape.tongueDepth) * (1 - shape.tongue)
    const crown = innerTop + innerHeight * raised
    const rx = halfWidth * 0.82
    // Tall enough to reach past the lower lip whatever the crown is doing; the
    // clip trims the overflow, so erring large is free.
    const ry = innerHeight * 0.95 + halfWidth * 0.2

    ctx.fillStyle = TONGUE
    ctx.beginPath()
    ctx.ellipse(x, crown + ry, rx, ry, 0, 0, Math.PI * 2)
    ctx.fill()
  }
}
