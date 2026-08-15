import config from '../enubot.config.ts'
import { ProceduralFace } from './face/adapters/procedural.ts'
import type { Expression } from './core/types.ts'
import type { Viseme } from './audio/lipsync.ts'

/**
 * Every face state, side by side and live. Dev-only page at /faces.html.
 *
 * The face is the part of this project with no automated test worth writing —
 * "does it look friendly" is a judgement call — so the substitute is making the
 * whole state space visible at once and animating, where a bad blend or a
 * mistimed blink is obvious. It reads the same ProceduralFace the kiosk runs, so
 * it can never drift from what actually ships.
 *
 * The viseme sheet below the expressions is the same idea aimed at the mouth.
 * Fifteen shapes is past the point where they can be held in mind one at a time:
 * what matters is whether any two collapse into the same drawing, and whether
 * they look like one mouth doing fifteen things rather than fifteen mouths. Both
 * of those are only visible with the whole set laid out at once.
 *
 * Not in the kiosk build, but in the cloud preview's: a build takes
 * `index.html` as its only entry unless `VITE_ENUBOT_DEBUG_PAGES=1` adds this
 * page and the face sheet, which `vercel.json` sets. The dev server serves it
 * either way. See vite.config.ts.
 */

interface Cell {
  label: string
  expression: Expression
  /** A number pins the mouth open; 'speech' animates it like talking. */
  mouth?: number | 'speech'
  viseme?: Viseme
  gaze?: [number, number]
}

const CELLS: Cell[] = [
  { label: 'idle', expression: 'idle' },
  { label: 'listening', expression: 'listening' },
  { label: 'thinking', expression: 'thinking' },
  { label: 'happy', expression: 'happy' },
  { label: 'confused', expression: 'confused' },
  { label: 'surprised', expression: 'surprised' },
  { label: 'sorry', expression: 'sorry' },
  { label: 'talking (live)', expression: 'talking', mouth: 'speech' },
  { label: 'gaze left', expression: 'idle', gaze: [-1, 0] },
  { label: 'gaze right', expression: 'idle', gaze: [1, 0] },
  { label: 'gaze down', expression: 'listening', gaze: [0, 0.9] },
]

interface VisemeCell {
  viseme: Viseme
  /** A word that puts the shape in the reader's mouth while they look at it. */
  word: string
  /**
   * Aperture this viseme actually reaches in the runtime.
   *
   * For the consonants that is the cap in APERTURE (audio/lipsync.ts); for the
   * vowels it is a plausible mid-loud syllable. Showing every shape at 1.0 would
   * be a prettier sheet and a lying one — several of these are never drawn more
   * than a third open, and that is where they have to read.
   */
  open: number
}

/**
 * The Meta OVR set, in articulation order rather than alphabetical: silence,
 * then the lips, then the tongue front to back, then the vowels open to rounded.
 *
 * Neighbours are the pairs most likely to collapse into one drawing — DD beside
 * nn, oh beside ou, SS beside CH — which is exactly why they are neighbours.
 */
const VISEMES: VisemeCell[] = [
  { viseme: 'sil', word: '(rest)', open: 0 },
  { viseme: 'PP', word: 'pop, bib, mom', open: 0 },
  { viseme: 'FF', word: 'fish, view', open: 0.28 },
  { viseme: 'TH', word: 'the, thing', open: 0.34 },
  { viseme: 'DD', word: 'dig, tap', open: 0.3 },
  { viseme: 'nn', word: 'new, look', open: 0.3 },
  { viseme: 'RR', word: 'red, hurry', open: 0.38 },
  { viseme: 'SS', word: 'sun, zoo', open: 0.22 },
  { viseme: 'CH', word: 'ship, chair, jam', open: 0.3 },
  { viseme: 'kk', word: 'cat, go', open: 0.4 },
  { viseme: 'aa', word: 'car, father', open: 0.95 },
  { viseme: 'E', word: 'bed, said', open: 0.8 },
  { viseme: 'ih', word: 'sit, easy', open: 0.7 },
  { viseme: 'oh', word: 'toe, more', open: 0.9 },
  { viseme: 'ou', word: 'too, way', open: 0.85 },
]

interface Live {
  cell: Cell
  face: ProceduralFace
  canvas: HTMLCanvasElement
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

document.head.insertAdjacentHTML(
  'beforeend',
  `<style>
    :root { --ink:#1b2447; --purple:#5a4fcf; }
    body { margin:0; padding:24px 28px 48px; font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
           color:var(--ink); background:#eef0f7; }
    h1 { font-size:1.15rem; margin:0 0 4px; }
    h2 { font-size:.95rem; margin:32px 0 4px; }
    p.sub { margin:0 0 20px; opacity:.6; font-size:.85rem; }
    .controls { display:flex; flex-wrap:wrap; gap:20px; align-items:center; margin-bottom:24px;
                padding:14px 18px; background:#fff; border-radius:12px; }
    .controls label { display:flex; align-items:center; gap:8px; font-size:.8rem; }
    button { font:inherit; font-size:.8rem; font-weight:600; padding:8px 16px; border:none;
             border-radius:999px; background:var(--purple); color:#fff; cursor:pointer; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:18px; }
    .cell { background:#fff; border-radius:14px; padding:14px 8px 10px; text-align:center; }
    .head { width:150px; height:150px; margin:0 auto; border-radius:50%; background:#fff;
            box-shadow:0 3px 14px rgba(27,36,71,.1); position:relative; }
    .head canvas { position:absolute; inset:6%; width:88%; height:88%; }
    .label { margin-top:10px; font-size:.78rem; font-weight:600; }
    .word { margin-top:2px; font-size:.7rem; opacity:.55; }
  </style>`,
)

root.innerHTML = `
  <h1>Enubot — face states</h1>
  <p class="sub">Live, from the same renderer the kiosk uses. Blinks and expression blends run in real time.</p>
  <div class="controls">
    <label>gaze X <input id="gx" type="range" min="-1" max="1" step="0.05" value="0"></label>
    <label>gaze Y <input id="gy" type="range" min="-1" max="1" step="0.05" value="0"></label>
    <label><input id="auto" type="checkbox" checked> viseme aperture from the runtime</label>
    <label>override <input id="open" type="range" min="0" max="1" step="0.02" value="0.6"></label>
    <button id="blink">blink all</button>
    <button id="save">save PNG</button>
  </div>
  <div class="grid" id="grid"></div>
  <h2>Visemes — Meta OVR set</h2>
  <p class="sub">Every shape from one filleted-corner path. Watch the neighbours: DD/nn, oh/ou and SS/CH are the pairs that collapse first.</p>
  <div class="grid" id="viseme-grid"></div>
`

const grid = document.getElementById('grid') as HTMLDivElement
const visemeGrid = document.getElementById('viseme-grid') as HTMLDivElement

function mount(cell: Cell, into: HTMLElement, word?: string): Live {
  const face = new ProceduralFace({
    size: config.face_.canvasSize,
    blinkIntervalRange: config.face_.blinkIntervalRange,
    doubleBlinkChance: config.face_.doubleBlinkChance,
    shapeBlendSeconds: config.face_.shapeBlendSeconds,
  })
  face.setExpression(cell.expression)

  const wrap = document.createElement('div')
  wrap.className = 'cell'
  const head = document.createElement('div')
  head.className = 'head'
  head.appendChild(face.canvas)
  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = cell.label
  wrap.append(head, label)
  if (word) {
    const hint = document.createElement('div')
    hint.className = 'word'
    hint.textContent = word
    wrap.appendChild(hint)
  }
  into.appendChild(wrap)

  return { cell, face, canvas: face.canvas }
}

const live: Live[] = [
  ...CELLS.map((cell) => mount(cell, grid)),
  ...VISEMES.map(({ viseme, word, open }) =>
    mount({ label: viseme, expression: 'talking', mouth: open, viseme }, visemeGrid, word),
  ),
]

const gxInput = document.getElementById('gx') as HTMLInputElement
const gyInput = document.getElementById('gy') as HTMLInputElement
const autoInput = document.getElementById('auto') as HTMLInputElement
const openInput = document.getElementById('open') as HTMLInputElement

document.getElementById('blink')?.addEventListener('click', () => {
  for (const { face } of live) face.blink()
})

document.getElementById('save')?.addEventListener('click', () => {
  const COLS = 5
  const CELL = 256
  const rows = Math.ceil(live.length / COLS)
  const sheet = document.createElement('canvas')
  sheet.width = CELL * COLS
  sheet.height = CELL * rows
  const ctx = sheet.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#eef0f7'
  ctx.fillRect(0, 0, sheet.width, sheet.height)

  live.forEach(({ cell, canvas }, i) => {
    const x = (i % COLS) * CELL
    const y = Math.floor(i / COLS) * CELL
    ctx.fillStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(x + CELL / 2, y + CELL / 2 - 8, CELL * 0.44, 0, Math.PI * 2)
    ctx.fill()
    ctx.drawImage(canvas, x + CELL * 0.06, y + CELL * 0.02, CELL * 0.88, CELL * 0.88)
    ctx.fillStyle = '#1b2447'
    ctx.font = '600 15px system-ui'
    ctx.textAlign = 'center'
    ctx.fillText(cell.label, x + CELL / 2, y + CELL - 12)
  })

  const link = document.createElement('a')
  link.download = 'enubot-face-states.png'
  link.href = sheet.toDataURL('image/png')
  link.click()
})

function stepAll(dt: number, nowMs: number): void {
  const gx = Number(gxInput.value)
  const gy = Number(gyInput.value)
  const override = autoInput.checked ? null : Number(openInput.value)
  // Syllable-rate envelope, the same ~4.5Hz cadence real speech drives the mouth at.
  const speech = Math.max(0, Math.sin((nowMs / 1000) * 2 * Math.PI * 4.5)) ** 0.7

  for (const { cell, face } of live) {
    const [cgx, cgy] = cell.gaze ?? [gx, gy]
    face.setGaze(cgx, cgy)
    if (cell.mouth === 'speech') face.setMouth(speech, 'aa')
    else if (typeof cell.mouth === 'number') {
      // The override drives every viseme from one slider, which is how a corner
      // that only misbehaves at a particular aperture gets found.
      face.setMouth(override ?? cell.mouth, cell.viseme ?? 'aa')
    } else face.setMouth(0, 'sil')
    face.update(dt)
  }
}

let last = performance.now()
function frame(now: number): void {
  stepAll(Math.min((now - last) / 1000, 0.05), now)
  last = now
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Handy from the console for tweaking values, and necessary to draw at all when
// the tab is in the background — browsers throttle rAF to nothing there.
;(window as unknown as Record<string, unknown>).__faces = { live, stepAll }
