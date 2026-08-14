#!/usr/bin/env node
/**
 * Turn the Blender export into the GLB the kiosk actually ships.
 *
 *   node scripts/optimize-robot-glb.mjs <in.glb> <out.glb>
 *
 * Three things happen here, and only the first is cosmetic:
 *
 *   1. Scale. Meshy's rig comes out of the FBX chain at 1/100 scale — the robot
 *      measures 1.7cm, so a camera framed in metres sees nothing at all. The fix
 *      belongs on the scene root rather than in the app, because a magic 100 in
 *      the scene code is the kind of thing that survives long after the asset is
 *      re-exported correctly.
 *   2. Texture. One 4096² base colour is 12MB down the wire and ~90MB of VRAM.
 *      Half the resolution and WebP puts that at roughly a megabyte with no
 *      visible loss at kiosk viewing distance. `gltf-transform optimize` cannot
 *      do it here: Blender re-encodes the PNG with a colourspace tag libvips
 *      rejects, so the pixels go through sharp directly.
 *   3. Draco, only behind --draco, and off by default. drei's `useGLTF` pulls
 *      its Draco decoder from a Google CDN, which a kiosk on venue wifi cannot
 *      rely on and should not need. At 16.8k triangles the compression saves a
 *      few hundred KB against a texture that dominates the file anyway, so the
 *      dependency is not worth it. Turn it on only if the decoder is also
 *      self-hosted and passed to `useGLTF`.
 */

import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import {
  dedup,
  prune,
  resample,
  draco,
  textureCompress,
  getBounds,
} from '@gltf-transform/functions'
import draco3d from 'draco3dgltf'
import sharp from 'sharp'

const args = process.argv.slice(2)
const USE_DRACO = args.includes('--draco')
const [IN, OUT] = args.filter((a) => !a.startsWith('--'))
if (!IN || !OUT) {
  console.error('usage: optimize-robot-glb.mjs <in.glb> <out.glb> [--draco]')
  process.exit(1)
}

/** Metres. The brief puts Enubot at roughly human height on its plinth. */
const TARGET_HEIGHT = 1.7

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'draco3d.decoder': await draco3d.createDecoderModule(),
  })

const doc = await io.read(IN)
const root = doc.getRoot()

// --- 1. scale ---------------------------------------------------------------
// Measure the *world* bounds, not the POSITION accessor. The vertex data here is
// already at human scale; it is the armature node that carries a 0.01, so
// reading the raw attribute reports a correct-looking 1.7 for a robot that
// renders 1.7cm tall. Scaling to measured bounds rather than hardcoding 100 also
// means this becomes a no-op if the asset is later exported at the right size.
const scene = root.getDefaultScene() ?? root.listScenes()[0]
const bounds = getBounds(scene)
const worldHeight = bounds.max[1] - bounds.min[1]

const factor = worldHeight > 0 ? TARGET_HEIGHT / worldHeight : 1
if (Math.abs(factor - 1) > 0.01) {
  for (const scene of root.listScenes()) {
    for (const node of scene.listChildren()) {
      const s = node.getScale()
      node.setScale([s[0] * factor, s[1] * factor, s[2] * factor])
    }
  }
}

// --- 2. texture -------------------------------------------------------------
await doc.transform(
  dedup(),
  prune(),
  resample(),
  textureCompress({
    encoder: sharp,
    targetFormat: 'webp',
    resize: [2048, 2048],
    quality: 90,
  }),
  ...(USE_DRACO ? [draco({ method: 'edgebreaker' })] : []),
)

await io.write(OUT, doc)

const { statSync } = await import('node:fs')
console.log(
  JSON.stringify(
    {
      measuredWorldHeight: +worldHeight.toFixed(5),
      scaleApplied: +factor.toFixed(2),
      finalHeight: +(worldHeight * factor).toFixed(3),
      draco: USE_DRACO,
      clips: root.listAnimations().map((a) => a.getName()),
      inBytes: statSync(IN).size,
      outBytes: statSync(OUT).size,
    },
    null,
    2,
  ),
)
