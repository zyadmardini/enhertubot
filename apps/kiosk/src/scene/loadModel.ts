import type * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export const MODEL_URL = '/models/enubot.glb'

/** Only what the scene reads off the GLTF. Keeps the loader out of every prop type. */
export interface CharacterModel {
  scene: THREE.Group
  animations: THREE.AnimationClip[]
}

/**
 * Shown-progress size, used only when the response carries no Content-Length.
 * A bar that sits at zero and then jumps to done reads as a hang.
 */
const NOMINAL_BYTES = 1_350_000

const listeners = new Set<(ratio: number) => void>()
let ratio = 0
let pending: Promise<CharacterModel | null> | null = null

/**
 * Download and parse the character rig, once, at boot.
 *
 * This replaces the HEAD probe App used to run. The probe cost a full round trip
 * to answer a question the load answers by itself, and nothing could start until
 * it came back — so a cold boot spent the probe, then a lazy chunk fetch, then
 * the 1.3MB download, in series, with the placeholder robot on screen for all
 * three. That series is the flash. Started here, the model downloads beside the
 * answer cache from the first moment the app has any code running at all, and
 * "is there a model?" falls out of the result.
 *
 * `null` is a real answer rather than a failure: no model means the placeholder
 * carries the scene, which is exactly what the probe existed to protect. It
 * covers the case the probe was written for, too — a dev server's SPA fallback
 * answers a missing asset with index.html and a 200, and GLTFLoader throws on
 * parse rather than on fetch, so the HTML lands here as a caught error.
 *
 * Memoised at module scope: React StrictMode mounts every effect twice in dev,
 * and two 1.3MB downloads of the same rig is not a thing to do on a booth wifi.
 */
export function loadCharacterModel(): Promise<CharacterModel | null> {
  pending ??= load()
  return pending
}

/** Byte progress of the model download, 0..1. Returns an unsubscribe. */
export function onModelProgress(listener: (ratio: number) => void): () => void {
  listeners.add(listener)
  listener(ratio)
  return () => listeners.delete(listener)
}

async function load(): Promise<CharacterModel | null> {
  try {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL, (event) => {
      // Content-Length is the compressed length while `loaded` counts decoded
      // bytes, so a gzipped response can report more than all of it.
      const total = event.total > 0 ? event.total : NOMINAL_BYTES
      report(Math.min(1, event.loaded / total))
    })
    report(1)
    return { scene: gltf.scene, animations: gltf.animations }
  } catch (error) {
    console.warn(
      `[enubot] No usable character model at ${MODEL_URL} — using the placeholder. ` +
        'Run npm run validate:glb.',
      error,
    )
    report(1)
    return null
  }
}

function report(next: number): void {
  ratio = next
  for (const listener of [...listeners]) listener(next)
}
