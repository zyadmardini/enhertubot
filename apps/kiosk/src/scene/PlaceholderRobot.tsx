import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { FaceSurface } from './FaceSurface.tsx'
import { createToonGradient } from './toon.ts'
import type { EnubotRuntime } from '../runtime/EnubotRuntime.ts'
import type { GestureName } from '../core/types.ts'
import { seededRng } from '../core/random.ts'

/** Palette sampled from the client's character. */
const WHITE = '#f4f6fb'
const WHITE_WARM = '#ffffff'
const PURPLE = '#5a4fcf'
const ORANGE = '#f47b20'
const NAVY = '#232f63'

const HEAD_RADIUS = 0.44

const GESTURE_DURATIONS: Record<GestureName, number> = {
  wave: 1.6,
  bye: 1.8,
  point: 1.2,
  present: 1.3,
  shrug: 1.0,
  nod: 0.9,
  shake: 1.0,
  think: 1.4,
}

/** Gestures that read equally well on either arm, so mirroring them is free variety. */
const MIRRORABLE: ReadonlySet<GestureName> = new Set<GestureName>(['point', 'present'])

interface PlaceholderRobotProps {
  runtime: EnubotRuntime
}

/**
 * Stand-in robot built from primitives, in the client character's colours and
 * proportions, so the face can be judged in context before the rigged GLB lands.
 *
 * It is not the deliverable — GltfRobot replaces it the moment `enubot.glb`
 * appears. Its job is to keep face and gesture work unblocked by asset work, and
 * to make client reviews meaningful in the meantime.
 */
export function PlaceholderRobot({ runtime }: PlaceholderRobotProps) {
  const rootRef = useRef<THREE.Group>(null)
  const headRef = useRef<THREE.Group>(null)
  const leftArmRef = useRef<THREE.Group>(null)
  const rightArmRef = useRef<THREE.Group>(null)

  const gestureRef = useRef<{
    name: GestureName
    elapsed: number
    /** Scales throw and speed. The rig gets clip variants; this gets a dial. */
    amp: number
    mirror: boolean
  } | null>(null)
  const clock = useRef(0)

  const gradientMap = useMemo(() => createToonGradient(5), [])
  useEffect(() => () => gradientMap.dispose(), [gradientMap])

  const rng = useMemo(() => seededRng((Math.random() * 0xffffffff) >>> 0), [])

  useEffect(
    () =>
      runtime.on('gesture', (name) => {
        // Rolled once per fire rather than per frame — a gesture whose amplitude
        // changed mid-swing would judder rather than vary.
        gestureRef.current = {
          name,
          elapsed: 0,
          amp: 0.85 + rng() * 0.3,
          mirror: MIRRORABLE.has(name) && rng() < 0.35,
        }
      }),
    [runtime, rng],
  )

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05)
    clock.current += dt

    const root = rootRef.current
    const head = headRef.current
    const leftArm = leftArmRef.current
    const rightArm = rightArmRef.current
    if (!root || !head || !leftArm || !rightArm) return

    // Breathing never stops — not during a gesture, not while thinking, not
    // between visitors. A character that holds perfectly still reads as frozen.
    const breath = Math.sin(clock.current * 1.6)
    root.position.y = -0.95 + breath * 0.014
    root.scale.y = 1 + breath * 0.007

    const { yaw, pitch } = runtime.gaze
    head.rotation.y = yaw
    head.rotation.x = pitch
    head.rotation.z = 0

    const speaking = runtime.machine.state === 'speaking'
    const sway = speaking ? Math.sin(clock.current * 3.1) * 0.09 : 0
    let leftZ = 0.16 + sway * 0.5
    let rightZ = -0.16 - sway * 0.5
    let leftX = 0
    let rightX = 0

    const gesture = gestureRef.current
    if (gesture) {
      gesture.elapsed += dt
      const duration = GESTURE_DURATIONS[gesture.name]
      const progress = gesture.elapsed / duration

      if (progress >= 1) {
        gestureRef.current = null
      } else {
        // Ease in and out so the gesture blends with the rest pose rather than popping.
        const blend = Math.sin(Math.min(1, progress) * Math.PI) * gesture.amp
        const t = gesture.elapsed
        // The left arm rests at +z and the right at −z, so a mirrored gesture
        // needs the sign flipped as well as the limb swapped.
        const left = gesture.mirror

        switch (gesture.name) {
          case 'wave':
            rightZ -= blend * (2.0 + Math.sin(t * 13) * 0.28)
            break
          // Higher and slower than a hello, and held rather than shaken — the
          // difference between "over here" and "off you go".
          case 'bye':
            rightZ -= blend * (2.3 + Math.sin(t * 7) * 0.34)
            rightX -= blend * 0.2
            break
          case 'point':
            if (left) {
              leftX -= blend * 1.25
              leftZ += blend * 0.35
            } else {
              rightX -= blend * 1.25
              rightZ -= blend * 0.35
            }
            break
          // Open palm swept outward: offering the room rather than singling out
          // one thing in it.
          case 'present':
            if (left) {
              leftX -= blend * 0.85
              leftZ += blend * 0.7
            } else {
              rightX -= blend * 0.85
              rightZ -= blend * 0.7
            }
            break
          case 'shrug':
            leftZ += blend * 0.85
            rightZ -= blend * 0.85
            root.position.y += blend * 0.05
            break
          case 'nod':
            head.rotation.x += Math.sin(t * 9) * 0.2 * blend
            break
          case 'shake':
            head.rotation.y += Math.sin(t * 8) * 0.28 * blend
            break
          case 'think':
            head.rotation.z += blend * 0.22
            head.rotation.x -= blend * 0.12
            leftX -= blend * 0.5
            break
        }
      }
    }

    leftArm.rotation.z = leftZ
    leftArm.rotation.x = leftX
    rightArm.rotation.z = rightZ
    rightArm.rotation.x = rightX
  })

  const white = <meshToonMaterial color={WHITE} gradientMap={gradientMap} />
  const purple = <meshToonMaterial color={PURPLE} gradientMap={gradientMap} />
  const orange = <meshToonMaterial color={ORANGE} gradientMap={gradientMap} />

  return (
    <group ref={rootRef} position={[0, -0.95, 0]}>
      {/* legs + feet */}
      {[-1, 1].map((side) => (
        <group key={`leg-${side}`} position={[side * 0.15, 0, 0]}>
          <mesh position={[0, 0.28, 0]} castShadow>
            <capsuleGeometry args={[0.085, 0.26, 6, 16]} />
            {white}
          </mesh>
          <mesh position={[0, 0.3, 0.05]}>
            <sphereGeometry args={[0.062, 16, 12]} />
            {orange}
          </mesh>
          <mesh position={[0, 0.06, 0.03]} castShadow>
            <sphereGeometry args={[0.105, 20, 14]} />
            {white}
          </mesh>
        </group>
      ))}

      {/* navy shorts */}
      <mesh position={[0, 0.6, 0]} castShadow>
        <capsuleGeometry args={[0.235, 0.1, 6, 20]} />
        <meshToonMaterial color={NAVY} gradientMap={gradientMap} />
      </mesh>
      <mesh position={[0, 0.68, 0.16]}>
        <sphereGeometry args={[0.1, 18, 12]} />
        {orange}
      </mesh>

      {/* torso */}
      <mesh position={[0, 0.95, 0]} castShadow>
        <capsuleGeometry args={[0.28, 0.34, 8, 24]} />
        <meshToonMaterial color={WHITE_WARM} gradientMap={gradientMap} />
      </mesh>

      {/* chest badge */}
      <mesh position={[0, 1.0, 0.265]} rotation={[0, 0, 0]}>
        <circleGeometry args={[0.105, 32]} />
        <meshBasicMaterial color={ORANGE} toneMapped={false} />
      </mesh>
      <mesh position={[0, 1.0, 0.272]}>
        <ringGeometry args={[0.048, 0.062, 32]} />
        <meshBasicMaterial color={WHITE_WARM} toneMapped={false} />
      </mesh>

      {/* arms — pivot at the shoulder so rotation reads correctly */}
      {[-1, 1].map((side) => (
        <group
          key={`arm-${side}`}
          ref={side === -1 ? leftArmRef : rightArmRef}
          position={[side * 0.33, 1.09, 0]}
        >
          <mesh>
            <sphereGeometry args={[0.095, 20, 14]} />
            {purple}
          </mesh>
          <mesh position={[0, -0.2, 0]} castShadow>
            <capsuleGeometry args={[0.072, 0.2, 6, 16]} />
            {white}
          </mesh>
          <mesh position={[0, -0.33, 0]}>
            <cylinderGeometry args={[0.078, 0.078, 0.05, 20]} />
            {orange}
          </mesh>
          <mesh position={[0, -0.41, 0]} castShadow>
            <sphereGeometry args={[0.088, 20, 14]} />
            <meshToonMaterial color={WHITE_WARM} gradientMap={gradientMap} />
          </mesh>
        </group>
      ))}

      {/* head — the gaze target, and the face's parent */}
      <group ref={headRef} position={[0, 1.5, 0]}>
        <mesh castShadow>
          <sphereGeometry args={[HEAD_RADIUS, 40, 28]} />
          <meshToonMaterial color={WHITE_WARM} gradientMap={gradientMap} />
        </mesh>

        <FaceSurface face={runtime.face} headRadius={HEAD_RADIUS} />

        {/* Headband, arcing ear to ear over the top. Its radius is slightly under
            the head's so the band is partly embedded — standing proud of the
            skull it reads as a halo hovering over the character. */}
        <mesh rotation={[-0.16, 0, 0]}>
          <torusGeometry args={[HEAD_RADIUS * 0.982, 0.038, 12, 48, Math.PI]} />
          {purple}
        </mesh>

        {/* ear pods */}
        {[-1, 1].map((side) => (
          <group key={`ear-${side}`} position={[side * 0.4, -0.02, 0]} rotation={[0, 0, Math.PI / 2]}>
            <mesh castShadow>
              <cylinderGeometry args={[0.145, 0.145, 0.12, 28]} />
              {purple}
            </mesh>
            <mesh position={[0, side * 0.065, 0]}>
              <cylinderGeometry args={[0.075, 0.075, 0.02, 24]} />
              {orange}
            </mesh>
          </group>
        ))}
      </group>
    </group>
  )
}
