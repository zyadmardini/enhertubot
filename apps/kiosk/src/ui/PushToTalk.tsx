import { useEffect, useRef, useState } from 'react'
import type { ConversationState } from '../core/types.ts'

interface PushToTalkProps {
  state: ConversationState
  onDown: () => void
  onUp: () => void
  disabled?: boolean
}

/** Keys the physical arcade button may present as. It enumerates as a USB HID keyboard. */
const TRIGGER_KEYS = new Set([' ', 'Space', 'Enter'])

const LABELS: Record<ConversationState, string> = {
  idle: 'Hold to talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Tap to interrupt',
}

/**
 * Hold-to-talk, never always-listening.
 *
 * This is the mitigation for crowd noise: the microphone is closed unless a
 * visitor is physically holding the control, so a loud hall can't trigger a turn.
 */
export function PushToTalk({ state, onDown, onUp, disabled = false }: PushToTalkProps) {
  const [held, setHeld] = useState(false)
  const heldRef = useRef(false)

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      // Guard auto-repeat: holding a key fires keydown continuously, which would
      // restart the turn dozens of times a second.
      if (event.repeat || !TRIGGER_KEYS.has(event.key) || heldRef.current || disabled) return
      event.preventDefault()
      heldRef.current = true
      setHeld(true)
      onDown()
    }
    const up = (event: KeyboardEvent) => {
      if (!TRIGGER_KEYS.has(event.key) || !heldRef.current) return
      event.preventDefault()
      heldRef.current = false
      setHeld(false)
      onUp()
    }
    // Releasing while the window is unfocused would otherwise leave the mic open.
    const blur = () => {
      if (!heldRef.current) return
      heldRef.current = false
      setHeld(false)
      onUp()
    }

    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [onDown, onUp, disabled])

  const press = () => {
    if (disabled || heldRef.current) return
    heldRef.current = true
    setHeld(true)
    onDown()
  }
  const release = () => {
    if (!heldRef.current) return
    heldRef.current = false
    setHeld(false)
    onUp()
  }

  return (
    <button
      type="button"
      className={`ptt ptt--${state}${held ? ' ptt--held' : ''}`}
      onPointerDown={press}
      onPointerUp={release}
      onPointerLeave={release}
      onPointerCancel={release}
      disabled={disabled}
      aria-label={LABELS[state]}
    >
      <span className="ptt__dot" aria-hidden="true" />
      {LABELS[state]}
    </button>
  )
}
