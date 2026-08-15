import { useCallback, useEffect } from 'react'
import { Canvas } from '@react-three/fiber'
import { Scene } from './scene/Scene.tsx'
import { PushToTalk } from './ui/PushToTalk.tsx'
import { Captions } from './ui/Captions.tsx'
import { DebugHud } from './ui/DebugHud.tsx'
import { AttractOverlay } from './ui/AttractOverlay.tsx'
import { BootScreen } from './ui/BootScreen.tsx'
import { useEnubot } from './runtime/useEnubot.ts'
import { useBoot } from './boot/useBoot.ts'
import { DEBUG } from './debug.ts'

export default function App() {
  const { runtime, ui } = useEnubot()
  // The character rig and the answer cache download together behind the boot
  // screen. Nothing here probes for the model first — see scene/loadModel.ts for
  // what that round trip was costing.
  const boot = useBoot(ui.voice)

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
    // Not before the boot screen has lifted: a hotkey answer playing behind the
    // overlay is an answer nobody sees the robot give.
    if (!runtime || !boot.ready) return
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
  }, [runtime, boot.ready])

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
        {runtime ? <Scene runtime={runtime} model={boot.model} /> : null}
      </Canvas>

      <AttractOverlay state={ui.state} />
      <Captions user={ui.captions.user} agent={ui.captions.agent} />

      <div className="controls">
        {/* Disabled until the bank is decoded. A press that has to wait for a
            fetch is the one that reads as a broken robot, and the boot screen is
            there precisely so that press cannot happen. */}
        <PushToTalk
          state={ui.state}
          onDown={onDown}
          onUp={onUp}
          disabled={!runtime || !boot.ready}
        />
      </div>

      <BootScreen ratio={boot.ratio} label={boot.label} done={boot.ready} />

      {!ui.healthy ? (
        <div className="banner" role="status">
          Offline — canned answers only
        </div>
      ) : null}

      {DEBUG && runtime ? <DebugHud runtime={runtime} ui={ui} /> : null}
    </div>
  )
}
