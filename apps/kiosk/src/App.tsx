import { useCallback, useEffect, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Scene } from './scene/Scene.tsx'
import { MODEL_URL } from './scene/model.ts'
import { PushToTalk } from './ui/PushToTalk.tsx'
import { Captions } from './ui/Captions.tsx'
import { DebugHud } from './ui/DebugHud.tsx'
import { AttractOverlay } from './ui/AttractOverlay.tsx'
import { useEnubot } from './runtime/useEnubot.ts'
import { DEBUG } from './debug.ts'

export default function App() {
  const { runtime, ui } = useEnubot()
  const [hasModel, setHasModel] = useState(false)

  // Probe rather than letting the GLTF loader throw: until the rig lands in
  // Week 1 the placeholder has to carry the scene, and a failed load inside
  // Suspense is a blank screen, not a graceful fallback.
  //
  // `response.ok` alone is not enough. A dev server's SPA fallback answers a
  // missing asset with index.html and a 200, so the content type is what
  // actually distinguishes "model is here" from "model is not here".
  useEffect(() => {
    let cancelled = false
    fetch(MODEL_URL, { method: 'HEAD' })
      .then((response) => {
        const contentType = response.headers.get('content-type') ?? ''
        if (!cancelled) setHasModel(response.ok && !contentType.includes('text/html'))
      })
      .catch(() => {
        if (!cancelled) setHasModel(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Pre-rendered answers, on staff hotkeys.
  //
  // This began as the offline fallback and the route decision promoted it: it is
  // the fastest answer path there is — no network, no transcript, no vendor. It
  // goes through the driver, so the mouth syncs and gestures fire exactly as on a
  // live turn. The visitor sees a working robot; the operator knows it's on rails.
  //
  // The key→id mapping comes from the driver's bank, which is read from the same
  // manifest that records which audio exists. It used to be a list maintained by
  // hand here, in step with `content/qa.json` and with nothing enforcing it — so
  // renaming an id pointed a key at a 404 and nothing said so until the booth.
  useEffect(() => {
    if (!runtime) return
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat) return
      // Looked up at press time rather than captured at mount: the bank arrives
      // with the manifest, which is fetched after the runtime reaches React.
      const entry = runtime.cannedAnswers.find((answer) => answer.hotkey === event.key)
      if (!entry) return
      void runtime.playCanned(entry.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [runtime])

  const onDown = useCallback(() => runtime?.pttDown(), [runtime])
  const onUp = useCallback(() => runtime?.pttUp(), [runtime])

  return (
    <div className="app">
      <Canvas
        shadows
        // Capped DPR: a 4K booth display at full device pixel ratio spends the
        // whole frame budget on pixels nobody can see from two metres away.
        dpr={[1, 2]}
        // preserveDrawingBuffer lets us grab stills off the canvas for client
        // review. Debug-only: it forces the driver to keep the back buffer around,
        // which is a real cost to pay on the event machine for nothing.
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          preserveDrawingBuffer: DEBUG,
        }}
        // Framed for the full character head to toe. three.js fov is vertical, so
        // this framing holds on the portrait booth display as well as in landscape.
        camera={{ position: [0, 0.15, 3.4], fov: 36 }}
      >
        {runtime ? <Scene runtime={runtime} hasModel={hasModel} /> : null}
      </Canvas>

      <AttractOverlay state={ui.state} />
      <Captions user={ui.captions.user} agent={ui.captions.agent} />

      <div className="controls">
        <PushToTalk state={ui.state} onDown={onDown} onUp={onUp} disabled={!runtime} />
      </div>

      {!ui.healthy ? (
        <div className="banner" role="status">
          Offline — canned answers only
        </div>
      ) : null}

      {DEBUG && runtime ? <DebugHud runtime={runtime} ui={ui} /> : null}
    </div>
  )
}
