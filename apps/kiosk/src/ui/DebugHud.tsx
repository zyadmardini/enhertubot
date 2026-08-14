import { useEffect, useRef, useState } from 'react'
import config from '../../enubot.config.ts'
import type { EnubotRuntime } from '../runtime/EnubotRuntime.ts'
import type { EnubotUiState } from '../runtime/useEnubot.ts'

interface DebugHudProps {
  runtime: EnubotRuntime
  ui: EnubotUiState
}

/**
 * Behind `?debug=1`. Doubles as the client-review tool and the tuning surface.
 *
 * The latency figures are the point: press-to-first-audio p95 is the number that
 * decides whether a turn reads as alive, and it has to be visible from the first
 * day of voice work, not discovered during rehearsal.
 */
export function DebugHud({ runtime, ui }: DebugHudProps) {
  const [fps, setFps] = useState(0)
  const [vision, setVision] = useState({ attention: 0, present: false })
  const [lastGesture, setLastGesture] = useState('—')
  const [lastGreeting, setLastGreeting] = useState('—')
  const frames = useRef(0)
  const since = useRef(performance.now())

  // Attention and presence are sampled on the same 2Hz cadence as fps rather
  // than subscribed to. They change at detector rate, and a HUD that re-rendered
  // the tree fifteen times a second would be measuring its own overhead.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      frames.current += 1
      const now = performance.now()
      if (now - since.current >= 500) {
        setFps(Math.round((frames.current * 1000) / (now - since.current)))
        setVision({ attention: runtime.gaze.attention, present: runtime.visitorPresent })
        frames.current = 0
        since.current = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [runtime])

  useEffect(() => runtime.on('gesture', setLastGesture), [runtime])
  useEffect(() => runtime.on('greeting', setLastGreeting), [runtime])

  const overBudget = (ui.latency.p95 ?? 0) > config.latencyBudgetMs

  return (
    <div className="hud">
      <Row label="fps" value={String(fps)} warn={fps < 55} />
      <Row label="state" value={ui.state} />
      <Row label="driver" value={config.driver} />
      <Row
        label="vision"
        value={runtime.visionStatus}
        warn={config.vision !== 'none' && !runtime.visionAvailable}
      />
      <Row label="visitor" value={vision.present ? 'present' : '—'} />
      <Row label="attention" value={vision.attention.toFixed(2)} />
      <Row label="proxy" value={ui.healthy ? 'ok' : 'DOWN — canned mode'} warn={!ui.healthy} />
      <Row label="gesture" value={lastGesture} />
      <Row label="greeting" value={lastGreeting} />
      <hr />
      <Row label="press→voice" value={ms(ui.latency.last)} />
      <Row label="p50" value={ms(ui.latency.p50)} />
      <Row label="p95" value={ms(ui.latency.p95)} warn={overBudget} />
      <Row label="budget" value={`${config.latencyBudgetMs} ms`} />
    </div>
  )
}

function Row({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className={`hud__row${warn ? ' hud__row--warn' : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function ms(value: number | null): string {
  return value === null ? '—' : `${Math.round(value)} ms`
}
