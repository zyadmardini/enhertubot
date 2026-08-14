#!/usr/bin/env node
/**
 * Starts the proxy and the kiosk together and keeps them together.
 *
 * This is also the event-day launcher: Task Scheduler runs this on boot, and if
 * either process dies the other is torn down rather than left half-running — a
 * kiosk showing a scene with no voice is worse than a kiosk that visibly
 * restarts.
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const children = []
let shuttingDown = false

function run(name, args) {
  const child = spawn(npm, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
  child.on('exit', (code) => {
    if (shuttingDown) return
    console.error(`\n[start-all] ${name} exited (${code}). Stopping everything.`)
    shutdown(code ?? 1)
  })
  children.push(child)
  return child
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) child.kill()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

console.log('[start-all] proxy → http://127.0.0.1:8787')
run('proxy', ['run', 'dev:proxy'])

console.log('[start-all] kiosk → http://127.0.0.1:5173')
run('kiosk', ['run', 'dev'])
