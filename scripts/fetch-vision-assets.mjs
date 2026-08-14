#!/usr/bin/env node
/**
 * Puts the MediaPipe runtime where the kiosk can serve it.
 *
 * Two jobs: copy the wasm bundle out of node_modules, and download the two
 * models. Both land in apps/kiosk/public/, which is the only place the browser
 * can reach them.
 *
 * Vendored deliberately rather than loaded from Google's CDN. The booth runs on
 * venue wifi that will drop mid-day, and a kiosk that stops seeing people when
 * the network goes down is a kiosk that fails in exactly the conditions it was
 * built to survive. Same reason the scene doesn't use drei's <Environment>.
 *
 * Idempotent — existing files are left alone. Pass --force to re-download.
 */

import { createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(root, 'apps', 'kiosk', 'public')
const wasmSource = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const wasmTarget = join(publicDir, 'mediapipe', 'wasm')
const modelsTarget = join(publicDir, 'models')

/**
 * Official MediaPipe model releases. float16 rather than float32: half the
 * download, no accuracy difference that survives a 640×480 webcam frame.
 */
const MODELS = [
  {
    file: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    note: 'face detector — presence and gaze target',
  },
  {
    file: 'gesture_recognizer.task',
    url: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
    note: 'hand landmarks + canned gesture classifier — wave detection',
  },
]

const force = process.argv.includes('--force')

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function copyWasm() {
  if (!(await exists(wasmSource))) {
    throw new Error(
      `@mediapipe/tasks-vision is not installed (looked in ${wasmSource}). Run npm install first.`,
    )
  }
  await mkdir(wasmTarget, { recursive: true })

  const entries = await readdir(wasmSource)
  let copied = 0
  for (const entry of entries) {
    const target = join(wasmTarget, entry)
    if (!force && (await exists(target))) continue
    await copyFile(join(wasmSource, entry), target)
    copied += 1
  }
  console.log(`wasm      ${entries.length} files in public/mediapipe/wasm (${copied} copied)`)
}

async function fetchModel({ file, url, note }) {
  const target = join(modelsTarget, file)
  if (!force && (await exists(target))) {
    const { size } = await stat(target)
    console.log(`model     ${file} present (${mb(size)}) — ${note}`)
    return
  }

  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status} ${response.statusText})\n  ${url}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target))

  const { size } = await stat(target)
  console.log(`model     ${file} downloaded (${mb(size)}) — ${note}`)
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

try {
  await mkdir(modelsTarget, { recursive: true })
  await copyWasm()
  for (const model of MODELS) await fetchModel(model)
  console.log('\nVision assets ready. Set VITE_ENUBOT_VISION=mediapipe (or flip the default')
  console.log('in apps/kiosk/enubot.config.ts) and the camera pipeline will come up.')
} catch (error) {
  console.error(`\nVision assets not installed: ${error.message}`)
  console.error('Head tracking stays off and Enubot falls back to the idle scan.')
  process.exit(1)
}
