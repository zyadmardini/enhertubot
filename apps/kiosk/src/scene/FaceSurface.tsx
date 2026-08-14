import { useEffect, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { FaceRenderer } from '../face/types.ts'

interface FaceSurfaceProps {
  face: FaceRenderer
  /** Head radius. The face sits a hair proud of it. */
  headRadius?: number
  /** Half-angle of the face patch, radians. Wider = a bigger face on the skull. */
  halfArcX?: number
  halfArcY?: number
  /** Shift the patch up (negative) or down the skull, radians. */
  tilt?: number
}

/**
 * The drawn face, mapped onto a spherical cap that shares the head's curvature.
 *
 * A flat plane was the obvious thing and it was wrong twice over: parked inside
 * the head sphere the features are simply swallowed by the skull, and pushed out
 * far enough to clear it they visibly detach as soon as the head turns. A cap cut
 * from a marginally larger sphere sits on the surface at every angle, so the face
 * cannot sink in and cannot float off.
 *
 * Three.js gives a partial sphere a full 0..1 UV range across the segment, so the
 * canvas maps straight onto the patch with no UV maths.
 */
export function FaceSurface({
  face,
  headRadius = 0.44,
  halfArcX = 0.7,
  halfArcY = 0.74,
  tilt = -0.04,
}: FaceSurfaceProps) {
  const texture = useMemo(() => {
    const canvasTexture = new THREE.CanvasTexture(face.canvas)
    canvasTexture.colorSpace = THREE.SRGBColorSpace
    canvasTexture.minFilter = THREE.LinearFilter
    canvasTexture.generateMipmaps = false
    return canvasTexture
  }, [face])

  useEffect(() => () => texture.dispose(), [texture])

  useFrame(() => {
    // The runtime redraws the canvas every frame; without this the GPU keeps
    // showing whatever it uploaded first.
    texture.needsUpdate = true
  })

  // phi = π/2 faces +Z (the camera). theta = π/2 is the equator; `tilt` nudges
  // the patch up the skull so the face sits where a face belongs.
  const args = useMemo(
    () =>
      [
        // 2% proud of the skull. A hairline offset is inside depth-buffer
        // precision at booth viewing distance and z-fights on some GPUs — the
        // classic bug that only shows up on the event machine.
        headRadius * 1.02,
        48,
        32,
        Math.PI / 2 - halfArcX,
        halfArcX * 2,
        Math.PI / 2 + tilt - halfArcY,
        halfArcY * 2,
      ] as const,
    [headRadius, halfArcX, halfArcY, tilt],
  )

  return (
    // renderOrder pins the face after the opaque head, so the draw order never
    // depends on how the scene graph happens to be traversed.
    <mesh renderOrder={1}>
      <sphereGeometry args={args} />
      <meshBasicMaterial map={texture} transparent toneMapped={false} depthWrite={false} />
    </mesh>
  )
}
