/**
 * Critically damped smoothing.
 *
 * Why this and not `x += (target - x) * alpha`: exponential smoothing is
 * first-order, so its velocity is a direct function of the distance remaining.
 * The instant the target jumps, velocity jumps with it — the head lurches, then
 * eases. That reads as a snap no matter how long the time constant is.
 *
 * This is second-order: velocity is state, and it can only *change* smoothly.
 * A target that teleports produces an S-curve rather than a lurch, which is what
 * lets gaze hand off between a tracked visitor and the idle scan without a
 * visible seam.
 *
 * The formulation is the standard implicit-Euler critically damped spring (the
 * one behind Unity's SmoothDamp): unconditionally stable at any frame time, no
 * overshoot, and parameterised by settle time rather than by stiffness — which
 * means the tuning number in the config file is one a person can reason about.
 */
export class Spring {
  #value: number
  #velocity = 0

  constructor(initial = 0) {
    this.#value = initial
  }

  get value(): number {
    return this.#value
  }

  get velocity(): number {
    return this.#velocity
  }

  /** Teleport. Only for init and reset — using it mid-motion is the snap this class exists to avoid. */
  reset(value: number): void {
    this.#value = value
    this.#velocity = 0
  }

  /**
   * @param smoothTime Roughly how long it takes to reach the target.
   * @param maxSpeed Cap on units/sec, so a large jump glides instead of whipping.
   */
  step(target: number, dt: number, smoothTime: number, maxSpeed = Infinity): number {
    if (dt <= 0) return this.#value

    const settle = Math.max(1e-4, smoothTime)
    const omega = 2 / settle
    const x = omega * dt
    // Padé approximation of exp(-x) — the standard cheap stand-in for Math.exp
    // here, accurate well past the frame times this ever sees.
    const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)

    const start = this.#value
    const maxChange = maxSpeed * settle
    let change = start - target
    change = change < -maxChange ? -maxChange : change > maxChange ? maxChange : change

    const goal = start - change
    const temp = (this.#velocity + omega * change) * dt
    this.#velocity = (this.#velocity - omega * temp) * decay
    let next = goal + (change + temp) * decay

    // Numerical guard: with maxSpeed clamping, or a very large dt, the step can
    // land past the target. Settle there rather than oscillating around it.
    if (target - start > 0 === next > target) {
      next = target
      this.#velocity = 0
    }

    this.#value = next
    return next
  }
}

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

/** Ease with zero slope at both ends — no corner where a ramp starts or finishes. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
}

/** Linear step toward a target, capped by `maxDelta`. */
export function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current
  if (Math.abs(delta) <= maxDelta) return target
  return current + Math.sign(delta) * maxDelta
}
