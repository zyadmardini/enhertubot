import type { Expression } from '../../core/types.ts'
import type { Viseme } from '../../audio/lipsync.ts'
import type { FaceRenderer } from '../types.ts'

export interface ProceduralFaceOptions {
  size: number
  blinkIntervalRange: [number, number]
  doubleBlinkChance: number
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
  /** How far the upper teeth hang below the top lip, 0..1. */
  teethUpper: number
  /** How far the lower teeth rise above the bottom lip, 0..1. */
  teethLower: number
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
  /** Lip weight. Pursed shapes carry a heavier line, as real lips do when rounded. */
  lip: number
  /** How much of the resting smile survives. See the note at `dip`. */
  curveScale: number
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
 * 20–26px of aperture at a 512px canvas: below about 16px the upper teeth alone
 * fill the opening and every tongue consonant collapses into the same slot,
 * which is precisely the failure the viseme sheet exists to catch.
 *
 * Teeth and tongue follow the one rule worth taking from Preston Blair: the
 * upper teeth are pinned to the top lip and never move relative to it, which
 * locks the upper jaw to the skull. Everything that opens, opens downward.
 */
const MOUTH_SHAPES: Record<Viseme, MouthShape> = {
  // Rest. Nothing shows, so only width and corner matter — but they still have
  // to be the neutral the other fourteen blend out of.
  sil: { width: 1, height: 1, corner: 0.12, teethUpper: 0, teethLower: 0, tongue: 0, tongueDepth: 0.6, tongueFront: 0, lip: 1, curveScale: 1 },
  // Pressed, not merely closed. Slightly wider and a heavier line than `sil`,
  // which is the whole visible difference between a rest and a /p/.
  PP: { width: 1.12, height: 0, corner: 0.12, teethUpper: 0, teethLower: 0, tongue: 0, tongueDepth: 0.6, tongueFront: 0, lip: 1.18, curveScale: 0.55 },
  // Upper teeth on the lower lip. The teeth fill the aperture almost completely;
  // that near-blocked slot is the read, not the gap.
  FF: { width: 0.86, height: 1.05, corner: 0.14, teethUpper: 1, teethLower: 0, tongue: 0, tongueDepth: 0.8, tongueFront: 0, lip: 1.05, curveScale: 0.85 },
  TH: { width: 0.9, height: 1.5, corner: 0.16, teethUpper: 0.75, teethLower: 0.25, tongue: 1, tongueDepth: 0.16, tongueFront: 1, lip: 1, curveScale: 0.9 },
  // Tongue tip up behind the upper teeth — the same gesture as `nn`, held harder.
  DD: { width: 0.95, height: 1.55, corner: 0.14, teethUpper: 0.6, teethLower: 0.35, tongue: 0.9, tongueDepth: 0.22, tongueFront: 0, lip: 1, curveScale: 0.9 },
  // A velar drops the jaw and humps the tongue at the back, which from the front
  // reads as an open mouth with a low floor rather than as a tongue at all.
  kk: { width: 0.98, height: 1.4, corner: 0.13, teethUpper: 0.4, teethLower: 0.3, tongue: 0.75, tongueDepth: 0.6, tongueFront: 0, lip: 1, curveScale: 0.95 },
  // Rounded and protruded, teeth close together. Sits deliberately between `SS`
  // and `ou`: that is where /ʃ/ is articulated and where it has to look.
  CH: { width: 0.7, height: 1.4, corner: 0.3, teethUpper: 0.8, teethLower: 0.6, tongue: 0.5, tongueDepth: 0.5, tongueFront: 0, lip: 1.12, curveScale: 0.9 },
  // Wide and barely open, teeth clenched. The clench is the sibilant.
  SS: { width: 1.22, height: 1.15, corner: 0.12, teethUpper: 1, teethLower: 1, tongue: 0, tongueDepth: 0.7, tongueFront: 0, lip: 1, curveScale: 0.85 },
  nn: { width: 0.95, height: 1.55, corner: 0.14, teethUpper: 0.55, teethLower: 0.35, tongue: 0.95, tongueDepth: 0.18, tongueFront: 0, lip: 1, curveScale: 0.9 },
  // Bunched mid-tongue, lips slightly rounded. Little teeth: an /r/ hides them.
  RR: { width: 0.82, height: 1.25, corner: 0.2, teethUpper: 0.35, teethLower: 0.25, tongue: 0.75, tongueDepth: 0.42, tongueFront: 0, lip: 1.06, curveScale: 0.95 },
  aa: { width: 1, height: 1, corner: 0.12, teethUpper: 0.45, teethLower: 0.3, tongue: 0.65, tongueDepth: 0.62, tongueFront: 0, lip: 1, curveScale: 1 },
  E: { width: 1.12, height: 0.66, corner: 0.12, teethUpper: 0.55, teethLower: 0.4, tongue: 0.65, tongueDepth: 0.58, tongueFront: 0, lip: 1, curveScale: 1 },
  ih: { width: 1.34, height: 0.62, corner: 0.12, teethUpper: 0.8, teethLower: 0.55, tongue: 0.7, tongueDepth: 0.45, tongueFront: 0, lip: 1, curveScale: 1 },
  // Large corner radius, not a different primitive — see `corner`.
  oh: { width: 0.52, height: 1.5, corner: 0.55, teethUpper: 0.2, teethLower: 0.15, tongue: 0.45, tongueDepth: 0.72, tongueFront: 0, lip: 1.1, curveScale: 1 },
  // Tighter and taller than `oh`, or the two rounded vowels are the same drawing
  // and the classifier's extra band did nothing visible.
  ou: { width: 0.34, height: 1.28, corner: 0.8, teethUpper: 0, teethLower: 0, tongue: 0.15, tongueDepth: 0.9, tongueFront: 0, lip: 1.22, curveScale: 1 },
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
const CLOSED_EPSILON = 0.006

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
    // in over ~40ms hides the frame or two where the classifier changes its mind.
    const shapeBlend = 1 - Math.exp(-dt / 0.04)
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
   */
  #drawMouth(ctx: CanvasRenderingContext2D, s: number, curve: number, gx: number): void {
    const open = this.#mouthOpenCurrent
    const shape = this.#shape
    const y = s * 0.15
    const x = gx * 0.35

    const halfWidth = s * 0.145 * shape.width
    const height = s * 0.185 * open * shape.height
    // A smile lifts the corners, so in canvas space the centre of the lip dips down.
    // Generous by default: the reference character's resting face is a real smile,
    // and a timid one reads as a robot that would rather you didn't approach.
    //
    // A press straightens it, but only partly. Flattening all the way would drop
    // the smile on every /p/ — at syllable rate that reads as a twitch, not a
    // consonant, and the character is the thing being protected here.
    const dip = curve * s * 0.105 * shape.curveScale

    if (height < s * CLOSED_EPSILON) {
      ctx.strokeStyle = INK
      ctx.lineWidth = s * LIP_WIDTH * shape.lip
      ctx.beginPath()
      ctx.moveTo(x - halfWidth, y)
      ctx.quadraticCurveTo(x, y + dip, x + halfWidth, y)
      ctx.stroke()
      return
    }

    this.#aperturePath(ctx, x, y, halfWidth, height, dip, shape.corner * halfWidth)

    // The cavity darkens toward the middle. One gradient is the whole difference
    // between a mouth with depth and a navy sticker.
    const throat = ctx.createRadialGradient(
      x,
      y + (dip + height) * 0.4,
      0,
      x,
      y + (dip + height) * 0.4,
      Math.max(halfWidth, height * 0.6),
    )
    throat.addColorStop(0, CAVITY_DEEP)
    throat.addColorStop(1, CAVITY)
    ctx.fillStyle = throat
    ctx.fill()

    // The curve extremes, not the control points: a quadratic reaches half way to
    // its control, so the visible opening is half of `height`. Every interior
    // feature is placed against these, or the teeth float outside the lips.
    const innerTop = y + dip * 0.5
    const innerBottom = y + (dip + height) * 0.5
    const innerHeight = innerBottom - innerTop

    ctx.save()
    ctx.clip()

    this.#drawTongue(ctx, x, innerTop, innerHeight, halfWidth, shape)
    this.#drawTeeth(ctx, s, x, innerTop, innerBottom, halfWidth, shape)
    // /θ/ only: the tongue tip crosses in front of the teeth it is touching.
    if (shape.tongueFront > 0.02) {
      ctx.globalAlpha = Math.min(1, shape.tongueFront)
      this.#drawTongue(ctx, x, innerTop, innerHeight, halfWidth, shape)
      ctx.globalAlpha = 1
    }

    ctx.restore()

    // Rebuilt, not reused. save/restore covers the clip but *not* the current
    // path, and the interior left the tongue ellipse as the current path — so
    // stroking here without this outlined the tongue instead of the lips, in ink,
    // wiping out the very sliver of tongue the low-crowned visemes had to show.
    this.#aperturePath(ctx, x, y, halfWidth, height, dip, shape.corner * halfWidth)

    // Lip line last, over the interior, so teeth and tongue are contained by it.
    // The lip reads because the cavity behind it is darker than it is, not
    // because the line is thick — see LIP_WIDTH.
    ctx.strokeStyle = INK
    ctx.lineWidth = s * LIP_WIDTH * shape.lip
    ctx.stroke()
  }

  /**
   * The aperture, as two lip curves joined by two corner fillets.
   *
   * A quadratic's control leg *is* its tangent at the endpoint, so trimming each
   * curve back by `radius` along that leg and bridging the gap with one more
   * quadratic through the corner point gives an exact, cheap fillet. That is the
   * whole trick: one radius dial, no special cases, and no viseme that is secretly
   * a different shape.
   */
  #aperturePath(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    halfWidth: number,
    height: number,
    dip: number,
    radius: number,
  ): void {
    const left = x - halfWidth
    const right = x + halfWidth
    const topCtrl = { x, y: y + dip }
    const bottomCtrl = { x, y: y + dip + height }

    // Control legs at each corner, as unit vectors.
    const upperRun = Math.hypot(halfWidth, dip)
    const lowerRun = Math.hypot(halfWidth, dip + height)
    // Never trim more than a curve has to give, or the fillet turns inside out on
    // the flattest shapes — which is exactly where a bad corner is most visible.
    const r = Math.min(radius, upperRun * 0.42, lowerRun * 0.42)

    const upper = { x: (halfWidth / upperRun) * r, y: (dip / upperRun) * r }
    const lower = { x: (halfWidth / lowerRun) * r, y: ((dip + height) / lowerRun) * r }

    ctx.beginPath()
    ctx.moveTo(left + upper.x, y + upper.y)
    ctx.quadraticCurveTo(topCtrl.x, topCtrl.y, right - upper.x, y + upper.y)
    ctx.quadraticCurveTo(right, y, right - lower.x, y + lower.y)
    ctx.quadraticCurveTo(bottomCtrl.x, bottomCtrl.y, left + lower.x, y + lower.y)
    ctx.quadraticCurveTo(left, y, left + upper.x, y + upper.y)
    ctx.closePath()
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
