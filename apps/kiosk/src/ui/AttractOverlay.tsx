import { useEffect, useState } from 'react'
import type { ConversationState } from '../core/types.ts'

interface AttractOverlayProps {
  state: ConversationState
  /** Seconds of idle before the prompts appear. */
  delaySeconds?: number
}

/**
 * Example questions, shown after a stretch of idle.
 *
 * Signage that names a few real questions dramatically raises the hit rate on
 * the ten scripted answers — visitors who are told what to ask stay on-script,
 * and on-script questions are the ones Enubot answers best.
 */
const PROMPTS = [
  'Ask me where the keynote is',
  'Ask me what I am',
  'Ask me what to see first',
  'Ask me who built me',
]

export function AttractOverlay({ state, delaySeconds = 8 }: AttractOverlayProps) {
  const [visible, setVisible] = useState(false)
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (state !== 'idle') {
      setVisible(false)
      return
    }
    const timer = setTimeout(() => setVisible(true), delaySeconds * 1000)
    return () => clearTimeout(timer)
  }, [state, delaySeconds])

  useEffect(() => {
    if (!visible) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % PROMPTS.length), 4500)
    return () => clearInterval(timer)
  }, [visible])

  if (!visible) return null
  return (
    <div className="attract">
      <span className="attract__prompt">{PROMPTS[index]}</span>
    </div>
  )
}
