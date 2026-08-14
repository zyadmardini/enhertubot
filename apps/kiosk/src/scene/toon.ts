import * as THREE from 'three'

/**
 * Stepped gradient ramp for MeshToonMaterial.
 *
 * The body has to be toon-shaded to sit against a flat drawn face. A smoothly
 * lit body next to a flat face doesn't read as a style choice, it reads as a
 * rendering bug.
 */
export function createToonGradient(steps = 4): THREE.DataTexture {
  const data = new Uint8Array(steps)
  for (let i = 0; i < steps; i++) {
    data[i] = Math.round((i / (steps - 1)) * 255)
  }
  const texture = new THREE.DataTexture(data, steps, 1, THREE.RedFormat)
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}
