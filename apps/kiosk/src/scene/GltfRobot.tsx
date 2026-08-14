import { useEffect, useMemo, useRef } from 'react'
import { createPortal, useFrame, useGraph } from '@react-three/fiber'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import config from '../../enubot.config.ts'
import { FaceSurface } from './FaceSurface.tsx'
import { createToonGradient } from './toon.ts'
import type { EnubotRuntime } from '../runtime/EnubotRuntime.ts'
import { GESTURE_CLIPS, STATE_CLIPS } from '../core/types.ts'
import type { ClipName } from '../core/types.ts'
import { pick, seededRng } from '../core/random.ts'
import { MODEL_URL } from './model.ts'

interface GltfRobotProps {
  runtime: EnubotRuntime
  /** Name of the head bone the gaze controller drives. */
  headBoneName?: string
}

/**
 * The envelope `PlaceholderRobot` occupies: 1.4 units tall with its feet on
 * y = -0.95. The camera framing, the key light angle and `ContactShadows`'s
 * ground plane are all set against that stand-in, so the real rig is fitted to
 * it rather than the other way round.
 */
const STAGE_HEIGHT = 1.4
const STAGE_FLOOR_Y = -0.95

/**
 * The real character: rigged GLB, driven by whichever clips it actually contains.
 *
 * Three things carry the performance. Gestures crossfade rather than cut, so the
 * body never teleports between poses. Breathing is applied additively underneath
 * whatever clip is playing, so it keeps going during a wave — the single
 * cheapest thing that makes a rig look alive rather than driven. And each cue
 * picks among the variants the rig has for it, so the booth's tenth visitor
 * isn't watching a recording of its first.
 *
 * Clip availability is read from the GLB rather than assumed, which is what lets
 * `OPTIONAL_CLIPS` land one export at a time: a rig with only the eight required
 * clips animates correctly and simply repeats itself more.
 */
export function GltfRobot({ runtime, headBoneName = 'Head' }: GltfRobotProps) {
  const { scene, animations } = useGLTF(MODEL_URL)
  const { nodes } = useGraph(scene)
  const rootRef = useRef<THREE.Group>(null)

  const gradientMap = useMemo(() => createToonGradient(), [])
  const mixer = useMemo(() => new THREE.AnimationMixer(scene), [scene])
  const actions = useMemo(() => {
    const map = new Map<string, THREE.AnimationAction>()
    for (const clip of animations) map.set(clip.name, mixer.clipAction(clip))
    return map
  }, [animations, mixer])

  /**
   * Scale and lift the rig onto the stage, measured rather than hardcoded.
   *
   * Meshy's chain emits this rig at 1/100, `scripts/optimize-robot-glb.mjs`
   * corrects it to a real 1.7m, and a hand-exported test rig will be something
   * else again — deriving the fit from the bounding box means any of those drop
   * in without retouching the camera. Measured once per loaded scene, in bind
   * pose, before the mixer has posed anything.
   */
  const fit = useMemo(() => {
    const box = new THREE.Box3().setFromObject(scene)
    const height = box.max.y - box.min.y
    if (!Number.isFinite(height) || height <= 0) return { scale: 1, y: STAGE_FLOOR_Y }
    const scale = STAGE_HEIGHT / height
    return { scale, y: STAGE_FLOOR_Y - box.min.y * scale }
  }, [scene])

  const skinnedMesh = useMemo(() => {
    let found: THREE.SkinnedMesh | undefined
    scene.traverse((o) => {
      if (!found && (o as THREE.SkinnedMesh).isSkinnedMesh) found = o as THREE.SkinnedMesh
    })
    return found
  }, [scene])

  const headBone = nodes[headBoneName] as THREE.Object3D | undefined

  /**
   * Where the skull actually is, in head-bone local space.
   *
   * `FaceSurface` draws its patch around its own origin, which on the
   * placeholder was the middle of the head. On a real rig the head bone's origin
   * sits at the neck joint, so parenting the face straight to the bone buries it
   * in the throat — measured here, the skull centre is about 20 units up and 13
   * back from that origin, on a ~37 unit radius. The bone's +Z is forward, which
   * the `headfront` child bone confirms, so the patch's facing is already right.
   *
   * Derived from the vertices actually weighted to the bone rather than written
   * down, because those numbers are in bone-local units that mean nothing
   * outside this particular export.
   */
  const skull = useMemo(() => {
    if (!skinnedMesh || !headBone) return null
    const index = skinnedMesh.skeleton.bones.indexOf(headBone as THREE.Bone)
    if (index < 0) return null

    const inverse = skinnedMesh.skeleton.boneInverses[index]
    if (!inverse) return null
    const position = skinnedMesh.geometry.getAttribute('position')
    const skinIndex = skinnedMesh.geometry.getAttribute('skinIndex')
    const skinWeight = skinnedMesh.geometry.getAttribute('skinWeight')

    const box = new THREE.Box3()
    const vertex = new THREE.Vector3()
    for (let i = 0; i < position.count; i++) {
      let weight = 0
      for (let k = 0; k < 4; k++) {
        if (skinIndex.getComponent(i, k) === index) weight += skinWeight.getComponent(i, k)
      }
      // Half-weighted is enough to call a vertex part of the head; the rest
      // belong to the neck blend and would drag the centre down into it.
      if (weight < 0.5) continue
      box.expandByPoint(vertex.fromBufferAttribute(position, i).applyMatrix4(inverse))
    }
    if (box.isEmpty()) return null

    const size = box.getSize(new THREE.Vector3())
    return {
      centre: box.getCenter(new THREE.Vector3()),
      // Widest half-extent, so the patch clears the skull on its shallow axis
      // rather than sinking into it.
      radius: Math.max(size.x, size.y, size.z) / 2,
    }
  }, [skinnedMesh, headBone])

  const currentRef = useRef<THREE.AnimationAction | null>(null)
  /** The looping clip a one-shot gesture returns to when it finishes. */
  const restingClipRef = useRef<ClipName>('idle')

  // Which clip a cue picks is free-running rather than seeded per turn: the
  // scheduler's seed governs *when* things fire, and it has turn boundaries to
  // hang off. The scene has none — it only ever sees one cue at a time.
  const rng = useMemo(() => seededRng((Math.random() * 0xffffffff) >>> 0), [])
  /** Names already reported as unplayable, so a missing clip warns once, not per fire. */
  const warned = useMemo(() => new Set<string>(), [])

  // Toon-shade whatever the artist exported, so the body matches the flat face
  // without needing the material set up correctly in Blender.
  useEffect(() => {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      if (!mesh.isMesh) return
      const source = mesh.material as THREE.MeshStandardMaterial
      mesh.castShadow = true
      mesh.material = new THREE.MeshToonMaterial({
        color: source.color ?? new THREE.Color('#e9edf4'),
        map: source.map ?? null,
        gradientMap,
      })
    })
  }, [scene, gradientMap])

  // Additive breathing, layered under everything else and never stopped.
  useEffect(() => {
    const breathe = animations.find((clip) => clip.name === 'breathe')
    if (!breathe) return
    const additive = THREE.AnimationUtils.makeClipAdditive(breathe.clone())
    const action = mixer.clipAction(additive)
    action.blendMode = THREE.AdditiveAnimationBlendMode
    action.play()
    action.setEffectiveWeight(1)
    return () => {
      action.stop()
    }
  }, [animations, mixer])

  const play = useMemo(() => {
    return (clip: ClipName, { loop = false }: { loop?: boolean } = {}) => {
      const next = actions.get(clip)
      if (!next) {
        console.warn(`[enubot] Clip "${clip}" missing from the GLB. Run npm run validate:glb.`)
        return
      }
      next.reset()
      next.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, loop ? Infinity : 1)
      next.clampWhenFinished = !loop
      const previous = currentRef.current
      if (previous && previous !== next) {
        next.crossFadeFrom(previous, config.gesture.crossFadeSeconds, true)
      }
      next.play()
      currentRef.current = next
    }
  }, [actions])

  /**
   * Play one of `candidates` — whichever of them this rig actually has.
   *
   * Returns the clip chosen so the caller can remember it as the resting pose.
   * Null means the rig has none of them, which is a real answer rather than a
   * failure: `shake` deliberately lists no substitute, and standing still is the
   * correct behaviour until the artist delivers that clip.
   */
  const playFrom = useMemo(() => {
    return (
      key: string,
      candidates: readonly ClipName[],
      opts: { loop?: boolean } = {},
    ): ClipName | null => {
      const available = candidates.filter((clip) => actions.has(clip))
      const chosen = pick(rng, available)
      if (!chosen) {
        if (!warned.has(key)) {
          warned.add(key)
          console.warn(
            `[enubot] No clip for "${key}" in the GLB — tried ${candidates.join(', ')}. ` +
              'Run npm run validate:glb.',
          )
        }
        return null
      }
      play(chosen, opts)
      return chosen
    }
  }, [actions, play, rng, warned])

  useEffect(() => {
    restingClipRef.current = playFrom('idle', STATE_CLIPS.idle, { loop: true }) ?? 'idle'
  }, [playFrom])

  useEffect(
    () => runtime.on('gesture', (name) => playFrom(name, GESTURE_CLIPS[name])),
    [runtime, playFrom],
  )

  useEffect(
    () =>
      runtime.machine.on('state', ({ to }) => {
        // Remember the variant actually chosen, not the candidate list: a gesture
        // finishing has to return to the loop that was playing, and picking a
        // second time here would swap the base animation mid-answer.
        const chosen = playFrom(to, STATE_CLIPS[to], { loop: true })
        if (chosen) restingClipRef.current = chosen
      }),
    [runtime, playFrom],
  )

  // A one-shot gesture clamps on its last frame, so something has to bring the
  // body home. Mid-answer the next state transition does it by accident; an
  // idle-state wave — greeting a visitor — has no transition behind it, and
  // without this the robot holds its hand up until someone talks to it.
  useEffect(() => {
    const onFinished = (event: { action: THREE.AnimationAction }) => {
      if (event.action !== currentRef.current) return
      play(restingClipRef.current, { loop: true })
    }
    mixer.addEventListener('finished', onFinished)
    return () => mixer.removeEventListener('finished', onFinished)
  }, [mixer, play])

  useFrame((_, delta) => {
    mixer.update(Math.min(delta, 0.05))
    if (headBone) {
      const { yaw, pitch } = runtime.gaze
      headBone.rotation.y = yaw
      headBone.rotation.x = pitch
    }
  })

  return (
    <group ref={rootRef} position={[0, fit.y, 0]} scale={fit.scale}>
      <primitive object={scene} />
      {/* Portal, not <primitive object={headBone}>. Mounting the bone as an
          element re-parents it out of the skeleton and under this group —
          three.js `add()` detaches from the previous parent — so the head loses
          the neck/spine chain from its world matrix and the skinned vertices
          stretch away from the body. `createPortal` renders the face *into* the
          bone and leaves the hierarchy alone. */}
      {headBone && skull
        ? createPortal(
            <group position={skull.centre}>
              <FaceSurface face={runtime.face} headRadius={skull.radius} />
            </group>,
            headBone,
          )
        : null}
    </group>
  )
}

// Deliberately no useGLTF.preload() at module scope: it fires on import, which
// would start a fetch for a model that may not exist yet — and a dev server's
// SPA fallback answers that with HTML, producing an uncaught parse error that
// blanks the whole app. This module is only imported once the probe in App.tsx
// confirms the file is there.
