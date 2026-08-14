import { lazy, Suspense } from 'react'
import { useFrame } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import { PlaceholderRobot } from './PlaceholderRobot.tsx'
import { ModelBoundary } from './ModelBoundary.tsx'
import { DiagnosticsHandle } from './DiagnosticsHandle.tsx'
import { DEBUG } from '../debug.ts'
import type { EnubotRuntime } from '../runtime/EnubotRuntime.ts'

// Loaded only after App confirms the GLB exists, so the GLTF loader is never
// pulled in — let alone invoked — while the placeholder is standing in.
const GltfRobot = lazy(() =>
  import('./GltfRobot.tsx').then((module) => ({ default: module.GltfRobot })),
)

interface SceneProps {
  runtime: EnubotRuntime
  /** True once enubot.glb is present; until then the placeholder stands in. */
  hasModel: boolean
}

/**
 * Drives the per-frame clock from the render loop.
 *
 * Deliberately a component rather than a rAF loop of its own: sharing the
 * renderer's loop means face, gaze and gestures advance on exactly the frames
 * that get drawn, so nothing updates against a frame the visitor never sees.
 */
function RuntimeTicker({ runtime }: { runtime: EnubotRuntime }) {
  useFrame((_, delta) => {
    // Clamp: an alt-tab or a GC pause produces a huge delta that would teleport
    // every damped value it touches.
    runtime.frame(Math.min(delta, 0.05))
  })
  return null
}

export function Scene({ runtime, hasModel }: SceneProps) {
  return (
    <>
      <RuntimeTicker runtime={runtime} />
      {DEBUG ? <DiagnosticsHandle runtime={runtime} /> : null}

      {/* Studio setup to match the client's white backdrop: high ambient so the
          white body doesn't crush to grey, one key for form, one cool fill.
          Deliberately no <Environment preset> — drei fetches that HDRI from a CDN
          at runtime, which is a black scene on a kiosk with no venue wifi. */}
      <ambientLight intensity={1.5} />
      <directionalLight position={[2.5, 4.5, 3.5]} intensity={2.4} castShadow />
      <directionalLight position={[-3.5, 1.5, 2]} intensity={0.8} color="#cfd8ff" />
      <directionalLight position={[0, -2, 2]} intensity={0.35} color="#ffd9b8" />

      {hasModel ? (
        <ModelBoundary fallback={<PlaceholderRobot runtime={runtime} />}>
          <Suspense fallback={<PlaceholderRobot runtime={runtime} />}>
            <GltfRobot runtime={runtime} />
          </Suspense>
        </ModelBoundary>
      ) : (
        <PlaceholderRobot runtime={runtime} />
      )}

      <ContactShadows position={[0, -0.96, 0]} opacity={0.28} scale={3.4} blur={2.8} far={1.6} />
    </>
  )
}
