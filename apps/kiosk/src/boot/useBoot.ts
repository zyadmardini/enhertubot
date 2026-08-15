import { useEffect, useState } from 'react'
import { loadCharacterModel, onModelProgress } from '../scene/loadModel.ts'
import type { CharacterModel } from '../scene/loadModel.ts'
import { bootStatus } from './progress.ts'
import type { BootStatus } from './progress.ts'
import type { VoiceReadiness } from '../runtime/EnubotRuntime.ts'

/**
 * How long boot may hold the screen before the kiosk shows regardless.
 *
 * A loading bar that never finishes is worse than a robot whose voice is still
 * downloading: the press still works after this, it just waits on its own clip
 * the way it used to. This is the venue-wifi backstop, not a target — a booth on
 * a working connection is through in about a second.
 */
const BOOT_TIMEOUT_MS = 15_000

export interface BootState extends BootStatus {
  /**
   * The parsed rig, null once we know there isn't one, and undefined while the
   * download is still out. Scene draws no character for undefined — see there
   * for why the stand-in must not stand in during boot.
   */
  model: CharacterModel | null | undefined
}

/**
 * Downloads what the kiosk needs before a visitor sees it, and reports progress.
 *
 * The model half lives here; the voice half is warmed by the driver and arrives
 * through the runtime, so this only reads it. Both are in flight at once — the
 * point of a boot phase is that the two 1.3MB downloads overlap instead of
 * queueing behind a probe, a lazy chunk and each other.
 */
export function useBoot(voice: VoiceReadiness): BootState {
  const [model, setModel] = useState<CharacterModel | null | undefined>(undefined)
  const [modelRatio, setModelRatio] = useState(0)
  const [modelSettled, setModelSettled] = useState(false)
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    let cancelled = false

    const off = onModelProgress((ratio) => {
      if (!cancelled) setModelRatio(ratio)
    })
    // Memoised in the module, so StrictMode's second mount joins the same load
    // rather than starting a second 1.3MB download of the same rig.
    void loadCharacterModel().then((loaded) => {
      if (cancelled) return
      setModel(loaded)
      setModelSettled(true)
    })

    const timer = setTimeout(() => {
      if (cancelled) return
      console.warn(`[enubot] Boot still incomplete after ${BOOT_TIMEOUT_MS}ms — showing anyway.`)
      setExpired(true)
    }, BOOT_TIMEOUT_MS)

    return () => {
      cancelled = true
      off()
      clearTimeout(timer)
    }
  }, [])

  const status = bootStatus({ modelRatio, modelSettled, voice })
  return {
    ...status,
    ready: status.ready || expired,
    // Boot giving up with the rig still in flight has to leave *something* on
    // stage, and the stand-in is exactly what that is for. It does mean a swap
    // in front of the visitor if the rig lands afterwards — but by then we are
    // past fifteen seconds, and an empty white screen is the worse of the two.
    model: expired && model === undefined ? null : model,
  }
}
