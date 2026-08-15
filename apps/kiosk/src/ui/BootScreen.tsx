import { useEffect, useState } from 'react'

interface BootScreenProps {
  /** 0..1 across everything boot is waiting for. */
  ratio: number
  label: string
  /** True once the kiosk is ready — the screen fades out rather than cutting. */
  done: boolean
}

/** Matches the CSS fade, after which the overlay leaves the tree entirely. */
const FADE_MS = 420

/**
 * The screen a visitor sees for the first second, and the reason nothing else
 * has to be shown before it's ready.
 *
 * It earns its place twice. It hides the swap from stand-in robot to rigged one,
 * which used to happen in front of whoever was standing there. And it hides the
 * first frame's shader compile: the real scene mounts *underneath* this overlay
 * and gets a frame or two to warm up before the fade starts, so the reveal is a
 * robot already breathing rather than one that hitches into life.
 */
export function BootScreen({ ratio, label, done }: BootScreenProps) {
  const [gone, setGone] = useState(false)

  useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setGone(true), FADE_MS)
    return () => clearTimeout(timer)
  }, [done])

  if (gone) return null

  return (
    <div className={`boot${done ? ' boot--done' : ''}`} role="status" aria-live="polite">
      <p className="boot__mark">Enubot</p>
      <div className="boot__track">
        {/* scaleX rather than width: boot is the busiest the main thread ever
            gets — a 1.3MB GLB is being parsed behind this — and a transform is
            the one animation the compositor can keep smooth through it. */}
        <div className="boot__bar" style={{ transform: `scaleX(${Math.min(1, ratio)})` }} />
      </div>
      <p className="boot__label">{label}</p>
    </div>
  )
}
