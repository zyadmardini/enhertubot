import { useEffect, useRef, useState } from 'react'
import { EnubotRuntime } from './EnubotRuntime.ts'
import type { VoiceReadiness } from './EnubotRuntime.ts'
import type { ConversationState } from '../core/types.ts'

export interface EnubotUiState {
  state: ConversationState
  captions: { user: string; agent: string }
  latency: { last: number | null; p50: number | null; p95: number | null }
  /** False when the proxy is unreachable — the UI drops to canned mode. */
  healthy: boolean
  /** How much of the answer cache is decoded. The boot screen waits on it. */
  voice: VoiceReadiness
}

/**
 * Bridges the runtime into React.
 *
 * Only low-frequency events cross this boundary. Mouth, gaze and gestures never
 * touch React state — they're read from the runtime inside useFrame, so the
 * component tree re-renders a handful of times per turn rather than 60 times a
 * second.
 */
export function useEnubot(): { runtime: EnubotRuntime | null; ui: EnubotUiState } {
  const runtimeRef = useRef<EnubotRuntime | null>(null)
  const [runtime, setRuntime] = useState<EnubotRuntime | null>(null)
  const [ui, setUi] = useState<EnubotUiState>({
    state: 'idle',
    captions: { user: '', agent: '' },
    latency: { last: null, p50: null, p95: null },
    healthy: true,
    voice: { done: 0, total: 0, ready: false },
  })

  useEffect(() => {
    const instance = new EnubotRuntime()
    runtimeRef.current = instance
    setRuntime(instance)

    const offs = [
      instance.on('state', (state) => setUi((prev) => ({ ...prev, state }))),
      instance.on('captions', (captions) => setUi((prev) => ({ ...prev, captions }))),
      instance.on('latency', (latency) => setUi((prev) => ({ ...prev, latency }))),
      instance.on('health', (healthy) => setUi((prev) => ({ ...prev, healthy }))),
      instance.on('voice', (voice) => setUi((prev) => ({ ...prev, voice }))),
    ]

    void instance.start()

    return () => {
      for (const off of offs) off()
      instance.dispose()
      runtimeRef.current = null
    }
  }, [])

  return { runtime, ui }
}
