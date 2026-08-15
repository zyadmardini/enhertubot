import { useFrame } from '@react-three/fiber'
import { ContactShadows } from '@react-three/drei'
import { PlaceholderRobot } from './PlaceholderRobot.tsx'
import { GltfRobot } from './GltfRobot.tsx'
import { ModelBoundary } from './ModelBoundary.tsx'
import { DiagnosticsHandle } from './DiagnosticsHandle.tsx'
import { DEBUG } from '../debug.ts'
import type { CharacterModel } from './loadModel.ts'
import type { EnubotRuntime } from '../runtime/EnubotRuntime.ts'

interface SceneProps {
  runtime: EnubotRuntime
  /**
   * The parsed rig; `null` once we know there is not one to be had — a fresh
   * clone with no GLB, or a model that failed to parse — and `undefined` while
   * boot is still finding out.
   *
   * Undefined draws no character at all, and that is the point. Mounting the
   * stand-in during boot builds twenty primitives, five materials and a texture
   * upload, animates them, and throws the lot away a second later — all on the
   * same thread that is parsing a 1.3MB GLB, and all behind a boot screen where
   * nobody can see it. The placeholder is a fallback for a rig that never
   * arrives, not a thing to look at while one does.
   */
  model: CharacterModel | null | undefined
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

export function Scene({ runtime, model }: SceneProps) {
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

      {/* No Suspense and no lazy import any more. Both existed to cover a load
          that happened here, during render; the rig now arrives already parsed,
          so the only fallback left is the one that matters — a rig that mounts
          and then throws. ModelBoundary stays for exactly that. */}
      {model === undefined ? null : model ? (
        <ModelBoundary fallback={<PlaceholderRobot runtime={runtime} />}>
          <GltfRobot runtime={runtime} model={model} />
        </ModelBoundary>
      ) : (
        <PlaceholderRobot runtime={runtime} />
      )}

      <ContactShadows position={[0, -0.96, 0]} opacity={0.28} scale={3.4} blur={2.8} far={1.6} />
    </>
  )
}
