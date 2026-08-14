#!/usr/bin/env node
/**
 * Asserts the GLB contains every animation clip the code plays, by exact name.
 *
 * Clip names are the contract between the 3D artist and the app. Without this
 * check a re-export that renames `talk_a` to `Talk A` fails silently at runtime
 * — a gesture that just never fires, discovered on event day.
 *
 * Zero dependencies: a GLB is a 12-byte header followed by a JSON chunk, so the
 * clip list is readable without a glTF library.
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_MODEL = path.resolve(HERE, '../apps/kiosk/public/models/enubot.glb')

/**
 * Must match `REQUIRED_CLIPS` in apps/kiosk/src/core/types.ts. The app cannot
 * stand up without these, so a missing one fails the export.
 */
const REQUIRED_CLIPS = [
  'idle',
  'breathe',
  'greeting_wave',
  'talk_a',
  'talk_b',
  'talk_c',
  'thinking',
  'nod',
]

/**
 * `OPTIONAL_CLIPS` from the same file: the variants that make repetition
 * invisible. Absent, the rig animates correctly and simply repeats itself more,
 * so these are reported rather than enforced — which is what lets them arrive
 * one export at a time instead of holding up a delivery.
 */
const OPTIONAL_CLIPS = [
  'idle_look_around',
  'goodbye_wave',
  'point_front',
  'point_side',
  'present',
  'shrug',
  'shake',
  'nod_slow',
  'thinking_chin',
  'celebrate',
]

const BUDGETS = {
  maxTriangles: 60_000,
  maxTextureSize: 2048,
  maxBones: 60,
}

const modelPath = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_MODEL

if (!existsSync(modelPath)) {
  console.error(`✗ No GLB at ${modelPath}`)
  console.error('  Export from Blender, then: npx gltfjsx model.glb --transform')
  process.exit(1)
}

const buffer = await readFile(modelPath)

const magic = buffer.readUInt32LE(0)
if (magic !== 0x46546c67) {
  console.error('✗ Not a GLB (bad magic). Is this a .gltf rather than a .glb?')
  process.exit(1)
}

const chunkLength = buffer.readUInt32LE(12)
const chunkType = buffer.readUInt32LE(16)
if (chunkType !== 0x4e4f534a) {
  console.error('✗ First chunk is not JSON — file is malformed.')
  process.exit(1)
}

const gltf = JSON.parse(buffer.subarray(20, 20 + chunkLength).toString('utf8'))

const found = (gltf.animations ?? []).map((animation) => animation.name)
const missing = REQUIRED_CLIPS.filter((clip) => !found.includes(clip))
const present = OPTIONAL_CLIPS.filter((clip) => found.includes(clip))
const extra = found.filter(
  (name) => !REQUIRED_CLIPS.includes(name) && !OPTIONAL_CLIPS.includes(name),
)

console.log(`\nGLB: ${path.relative(process.cwd(), modelPath)}`)
console.log(`Size: ${(buffer.length / 1024 / 1024).toFixed(2)} MB\n`)

console.log('Clips — required')
for (const clip of REQUIRED_CLIPS) {
  console.log(`  ${found.includes(clip) ? '✓' : '✗'} ${clip}`)
}

console.log(`\nClips — optional variants (${present.length}/${OPTIONAL_CLIPS.length})`)
for (const clip of OPTIONAL_CLIPS) {
  console.log(`  ${found.includes(clip) ? '✓' : '·'} ${clip}`)
}
if (extra.length) console.log(`\n  · unrecognised (harmless, never played): ${extra.join(', ')}`)

// Triangle count: every primitive's index count divided by three.
let triangles = 0
for (const mesh of gltf.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    const accessor = gltf.accessors?.[primitive.indices]
    if (accessor) triangles += accessor.count / 3
  }
}

const bones = (gltf.skins ?? []).reduce((total, skin) => total + (skin.joints?.length ?? 0), 0)
const oversizedTextures = (gltf.images ?? []).length

console.log('\nBudgets')
report('triangles', Math.round(triangles), BUDGETS.maxTriangles)
report('bones', bones, BUDGETS.maxBones)
console.log(`  · images: ${oversizedTextures} (check each is ≤ ${BUDGETS.maxTextureSize}px by eye)`)

function report(label, value, limit) {
  const ok = value <= limit
  console.log(`  ${ok ? '✓' : '⚠'} ${label}: ${value.toLocaleString()} / ${limit.toLocaleString()}`)
}

if (missing.length) {
  console.error(`\n✗ FAIL — ${missing.length} clip(s) missing: ${missing.join(', ')}`)
  console.error('  Clip names must match exactly, including case and underscores.')
  process.exit(1)
}

console.log(
  `\n✓ PASS — every required clip present, ${present.length} of ` +
    `${OPTIONAL_CLIPS.length} optional variants.\n`,
)
