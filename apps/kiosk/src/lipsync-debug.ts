import config from '../enubot.config.ts'
import { AudioBus } from './audio/AudioBus.ts'
import { LipSync } from './audio/lipsync.ts'
import type { ArticulationDetail, CharAlignment, Articulation } from './audio/alignment.ts'
import { estimateAlignment } from './audio/estimate.ts'
import type { PhoneTrack } from './audio/visemes.ts'
import { parseGestureTags } from './core/gestures.ts'
import { ProceduralFace } from './face/adapters/procedural.ts'
import type { Viseme } from './audio/lipsync.ts'
import { linearAlignment, synthesizeBabble } from './voice/adapters/mock.ts'
import type { CannedAnswer } from './voice/types.ts'

/**
 * Lip-sync inspector. Dev-only page at /lipsync.html.
 *
 * The mouth has three sources and each fails silently in its own direction: the
 * analyser flaps through a consonant it cannot hear, the spelling puts the tongue
 * in a place English orthography only implies, and a measured phone track lands
 * on the wrong syllable entirely if its offset is out. All three look like "the
 * mouth is a bit off" from across a room, so this shows them separately against
 * the audio that produced them.
 *
 * Everything here is the shipping code — the real AudioBus, the real LipSync with
 * its AlignmentTrack and VisemeTrack, the real ProceduralFace. The articulation
 * bars are sampled through `articulationAt`, the same query the runtime makes
 * every frame, so what is drawn is what the mouth actually sees rather than a
 * parallel reimplementation.
 *
 * The audio sources are the answer bank and local synthesis. The bank is the
 * point: those eleven MP3s are what a visitor actually hears on the shipping
 * `cached` driver. The timing dropdown switches between what they ship with —
 * phone boundaries from `npm run bake:visemes` — and the three lesser sources
 * they used to have, on the same clip, which is the only honest way to judge
 * whether the aligner was worth it.
 *
 * Not part of the production build: Vite only bundles index.html.
 */

const SAMPLE_TEXT =
  'Pop over to the main hall from four. My name is Enubot, and I mumble a bit if the phones buzz.'

const FALLBACK_BASE = '/fallback'

/** Sampling step for the articulation bars, seconds. Fine enough to show a 50ms /p/. */
const SCAN_STEP = 0.005

const INK = '#1b2447'
const PURPLE = '#5a4fcf'

/**
 * One colour per articulation, so a wrong tongue is identifiable from the bar
 * alone. The two lip gestures keep the colours they had — they are the pair
 * that has been trusted longest, and it helps to recognise them at a glance.
 */
const ARTICULATION_COLOUR: Record<Articulation, string> = {
  PP: '#5a4fcf',
  FF: '#17b8a6',
  TH: '#e4894f',
  DD: '#4f8fe4',
  kk: '#9b59b6',
  CH: '#e4c14f',
  nn: '#3fb27f',
  RR: '#d9576b',
  ou: '#7d6fe0',
}

/**
 * Every viseme, coloured. The nine articulations keep the colours above so a bar
 * and the band beneath it are recognisably the same event; the analyser's own
 * shapes get cooler, flatter tones so the two sources stay tellable apart.
 */
const VISEME_COLOUR: Record<Viseme, string> = {
  ...ARTICULATION_COLOUR,
  sil: '#c9cede',
  SS: '#2bb3c4',
  aa: '#33427a',
  E: '#4a5896',
  ih: '#6170ad',
  oh: '#8089c4',
}

/**
 * One span of the top row: what the timing source asked for, before the mouth
 * had its say. Compared against the band lower down, which is what was shown.
 */
interface Block {
  start: number
  end: number
  viseme: Viseme
}

/** What the face was actually showing at one instant, recorded during playback. */
interface Sample {
  t: number
  open: number
  viseme: Viseme
}

const root = document.getElementById('root')
if (!root) throw new Error('#root missing')

document.head.insertAdjacentHTML(
  'beforeend',
  `<style>
    :root { --ink:#1b2447; --purple:#5a4fcf; --teal:#17b8a6; }
    body { margin:0; padding:24px 28px 48px; font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
           color:var(--ink); background:#eef0f7; }
    h1 { font-size:1.15rem; margin:0 0 4px; }
    p.sub { margin:0 0 20px; opacity:.6; font-size:.85rem; }
    .row { display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap; }
    .panel { background:#fff; border-radius:14px; padding:16px 18px; }
    .head { width:190px; height:190px; border-radius:50%; background:#fff; position:relative;
            box-shadow:0 3px 14px rgba(27,36,71,.1); }
    .head canvas { position:absolute; inset:6%; width:88%; height:88%; }
    .controls { flex:1; min-width:340px; display:flex; flex-direction:column; gap:12px; }
    textarea { font:inherit; font-size:.85rem; width:100%; box-sizing:border-box; resize:vertical;
               min-height:70px; padding:10px 12px; border:1px solid #dfe3ef; border-radius:10px; color:inherit; }
    .buttons { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    button { font:inherit; font-size:.82rem; font-weight:600; padding:9px 18px; border:none;
             border-radius:999px; background:var(--purple); color:#fff; cursor:pointer; }
    button.ghost { background:#e7e9f4; color:var(--ink); }
    button:disabled { opacity:.45; cursor:default; }
    select { font:inherit; font-size:.82rem; padding:8px 10px; border-radius:8px;
             border:1px solid #dfe3ef; background:#fff; color:inherit; }
    .check { display:flex; align-items:center; gap:7px; font-size:.75rem; opacity:.7; }
    .status { font-size:.78rem; opacity:.75; min-height:1.2em; }
    .status.bad { color:#c0392b; opacity:1; }
    .readout { display:flex; gap:22px; flex-wrap:wrap; margin-top:14px; font-size:.78rem; }
    .readout div { display:flex; flex-direction:column; gap:3px; }
    .readout .k { opacity:.55; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; }
    .readout .v { font-weight:700; font-size:.95rem; font-variant-numeric:tabular-nums; }
    .ctx { margin-top:14px; font-family:ui-monospace,'Cascadia Code',Consolas,monospace; font-size:1rem;
           letter-spacing:.06em; white-space:pre; opacity:.85; }
    .ctx b { background:var(--purple); color:#fff; padding:2px 3px; border-radius:3px; }
    .timeline { margin-top:20px; }
    .timeline canvas { width:100%; height:232px; display:block; cursor:ew-resize; touch-action:none; }
    .legend { display:flex; gap:16px; font-size:.74rem; margin-top:10px; opacity:.75; align-items:center; }
    .swatch { display:inline-block; width:11px; height:11px; border-radius:3px; margin-right:5px;
              vertical-align:-1px; }
  </style>`,
)

root.innerHTML = `
  <h1>Enubot — lip-sync inspector</h1>
  <p class="sub">Measured phones drive the mouth where the bake produced them; the analyser and the spelling stand in where it did not. This shows all three against the audio.</p>
  <div class="row">
    <div class="panel"><div class="head" id="head"></div></div>
    <div class="panel controls">
      <textarea id="text">${SAMPLE_TEXT}</textarea>
      <div class="buttons">
        <select id="source">
          <option value="local">Local synthesis (babble, even timings)</option>
        </select>
        <select id="detail">
          <option value="full">Full articulation (lips + tongue)</option>
          <option value="closures">Closures only (lips)</option>
        </select>
        <button id="speak">Speak</button>
        <button id="stop" class="ghost">Stop</button>
      </div>
      <label class="check">timing source for cached clips
        <select id="estimate">
          <option value="phones" selected>measured — forced alignment, as it ships</option>
          <option value="none">none — analyser alone</option>
          <option value="energy">estimate, energy-anchored</option>
          <option value="even">estimate, even spacing</option>
        </select>
      </label>
      <div class="status" id="status">Space replays · drag the timeline to scrub · ←/→ steps a frame.</div>
      <div class="readout">
        <div><span class="k">time</span><span class="v" id="r-time">0.00s</span></div>
        <div><span class="k">viseme</span><span class="v" id="r-viseme">closed</span></div>
        <div><span class="k">mouth open</span><span class="v" id="r-open">0.00</span></div>
        <div><span class="k">source</span><span class="v" id="r-src">—</span></div>
        <div><span class="k">articulation spans</span><span class="v" id="r-spans">0</span></div>
      </div>
      <div class="ctx" id="ctx"></div>
    </div>
  </div>
  <div class="panel timeline">
    <canvas id="tl"></canvas>
    <div class="legend">
      ${Object.entries(ARTICULATION_COLOUR)
        .map(([name, colour]) => `<span><span class="swatch" style="background:${colour}"></span>${name}</span>`)
        .join('')}
      <span><span class="swatch" style="background:${INK};opacity:.25"></span>mouth open, from the analyser</span>
    </div>
    <div class="legend">Rows, top to bottom: what the timing source asked for · mouth aperture · the viseme actually shown · phones or characters. The top two rows differing is the mouth's own smoothing; play once, then drag to scrub what was recorded.</div>
  </div>
`

const bus = new AudioBus()
const lipSync = new LipSync(bus, config.lipSync)
const face = new ProceduralFace({
  size: config.face_.canvasSize,
  blinkIntervalRange: config.face_.blinkIntervalRange,
  doubleBlinkChance: config.face_.doubleBlinkChance,
  shapeBlendSeconds: config.face_.shapeBlendSeconds,
})
document.getElementById('head')?.appendChild(face.canvas)

const el = {
  text: document.getElementById('text') as HTMLTextAreaElement,
  source: document.getElementById('source') as HTMLSelectElement,
  detail: document.getElementById('detail') as HTMLSelectElement,
  estimate: document.getElementById('estimate') as HTMLSelectElement,
  speak: document.getElementById('speak') as HTMLButtonElement,
  stop: document.getElementById('stop') as HTMLButtonElement,
  status: document.getElementById('status') as HTMLDivElement,
  time: document.getElementById('r-time') as HTMLSpanElement,
  viseme: document.getElementById('r-viseme') as HTMLSpanElement,
  open: document.getElementById('r-open') as HTMLSpanElement,
  src: document.getElementById('r-src') as HTMLSpanElement,
  spans: document.getElementById('r-spans') as HTMLSpanElement,
  ctx: document.getElementById('ctx') as HTMLDivElement,
  tl: document.getElementById('tl') as HTMLCanvasElement,
}

let alignment: CharAlignment | null = null
let phones: PhoneTrack | null = null
let duration = 0
let blocks: Block[] = []
let trace: Sample[] = []
/** Answers from the shipping manifest, keyed by id. Empty until the fetch lands. */
const answers = new Map<string, CannedAnswer>()

async function speak(): Promise<void> {
  el.speak.disabled = true
  stop()
  try {
    await bus.unlock()
    const text = el.text.value.trim()
    if (!text) return

    // Set before the append below, since detail is read as spans are laid down.
    lipSync.alignment.detail = el.detail.value as ArticulationDetail

    const answer = answers.get(el.source.value)
    setStatus(answer ? 'Loading clip…' : 'Synthesising…')

    const result = answer ? await fromCache(answer, text) : await fromLocalSynthesis(text)

    alignment = result.alignment
    phones = result.phones
    duration = result.buffer.duration

    // Exactly the runtime's sequence: the bus reports where the chunk lands and
    // the timings are offset onto that, rather than assuming it starts at zero.
    const offsetSeconds = bus.enqueue(result.buffer)
    if (result.alignment) lipSync.alignment.append(result.alignment, offsetSeconds)
    if (result.phones) lipSync.visemes.append(result.phones, offsetSeconds)

    blocks = scanArticulations(duration)
    trace = []
    el.src.textContent = result.label
    el.spans.textContent = String(lipSync.visemes.spanCount || lipSync.alignment.spanCount)
    const detail = result.phones
      ? `${result.phones.phones.length} phones · ${lipSync.visemes.spanCount} shapes · `
      : result.alignment
        ? `${result.alignment.chars.length} chars · `
        : 'analyser only · '
    setStatus(`${duration.toFixed(2)}s · ${detail}${blocks.length} articulations`)
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true)
  } finally {
    el.speak.disabled = false
  }
}

function stop(): void {
  bus.stop()
  lipSync.alignment.clear()
  lipSync.visemes.clear()
  blocks = []
  trace = []
  duration = 0
  alignment = null
  phones = null
  scrubT = null
  el.spans.textContent = '0'
}

interface SpeechSource {
  buffer: AudioBuffer
  /** null means no character timings — the analyser or the phones carry it instead. */
  alignment: CharAlignment | null
  /** Measured phone boundaries, when the answer has been through the aligner. */
  phones: PhoneTrack | null
  label: string
}

/**
 * One of the pre-rendered answers, exactly as the `cached` driver serves it.
 *
 * This is the audio a visitor actually hears, so it is the audio the mouth has to
 * be right against — synthesised babble has a tidy envelope and real speech does
 * not.
 *
 * Four timing sources on the same clip, which is the whole reason for the
 * dropdown: they are not variations on a theme, they are four different degrees
 * of knowing when a sound happened, and the difference between them is exactly
 * what this page exists to make visible.
 *
 *   phones  What ships. Boundaries measured by a forced aligner offline, so the
 *           consonants are where they actually are.
 *   none    The analyser alone — vowels right, every consonant a guess. This is
 *           what the bank did before the aligner existed.
 *   energy  Characters warped onto the clip's energy curve. Plausible, not true.
 *   even    Characters spread flat. Right shapes, wrong places, drifting further
 *           with every word.
 */
async function fromCache(answer: CannedAnswer, text: string): Promise<SpeechSource> {
  const response = await fetch(`${FALLBACK_BASE}/${answer.file}`)
  if (!response.ok) throw new Error(`${answer.file} — ${response.status}`)

  const buffer = await bus.ctx.decodeAudioData(await response.arrayBuffer())
  const mode = el.estimate.value

  if (mode === 'phones') {
    const track = await loadPhones(answer)
    if (!track) {
      // Not an error: an answer that has not been through `npm run bake:visemes`
      // genuinely has no phones, and the honest thing to show is the fallback it
      // would actually get.
      setStatus(`${answer.id} has no phones file — showing the analyser instead.`)
      return { buffer, alignment: null, phones: null, label: `${answer.id} (analyser)` }
    }
    return { buffer, alignment: null, phones: track, label: `${answer.id} (${track.aligner})` }
  }

  if (mode === 'none') return { buffer, alignment: null, phones: null, label: answer.id }

  // Both estimates are offered so the difference is visible rather than asserted.
  const alignment =
    mode === 'energy'
      ? estimateAlignment(buffer, text)
      : linearAlignment(text, buffer.duration)
  return { buffer, alignment, phones: null, label: `${answer.id} (${mode})` }
}

/** One answer's measured phone track, or null if the bake never produced one. */
async function loadPhones(answer: CannedAnswer): Promise<PhoneTrack | null> {
  if (!answer.phonesFile) return null
  const response = await fetch(`${FALLBACK_BASE}/${answer.phonesFile}`)
  if (!response.ok) return null
  const track = (await response.json()) as PhoneTrack
  return Array.isArray(track.phones) && track.phones.length > 0 ? track : null
}

/**
 * The mock driver's babble and evenly spaced timings.
 *
 * Useful for checking the plumbing, and misleading for judging the result: even
 * spacing puts every articulation exactly where the analyser would have guessed
 * anyway. Real consonants are uneven, which is the case worth looking at.
 */
async function fromLocalSynthesis(text: string): Promise<SpeechSource> {
  const buffer = synthesizeBabble(bus.ctx, text)
  return {
    buffer,
    alignment: linearAlignment(text, buffer.duration),
    phones: null,
    label: 'Local (even)',
  }
}

/**
 * Fill the source list from the shipping manifest.
 *
 * Read straight from `/fallback/manifest.json` rather than through CachedDriver:
 * the driver wants a full DriverDeps and drives a whole turn, and all this page
 * needs is which files exist and what they say.
 */
async function loadAnswerBank(): Promise<void> {
  const response = await fetch(`${FALLBACK_BASE}/manifest.json`)
  if (!response.ok) throw new Error(`manifest — ${response.status}`)

  const manifest = (await response.json()) as {
    answers?: CannedAnswer[]
    refusalFallback?: CannedAnswer
  }
  const bank = [...(manifest.answers ?? []), ...(manifest.refusalFallback ? [manifest.refusalFallback] : [])]

  const group = document.createElement('optgroup')
  group.label = 'Answer bank (real speech, no timings)'
  for (const answer of bank) {
    answers.set(answer.id, answer)
    const option = document.createElement('option')
    option.value = answer.id
    // The refusal fallback answers no particular question, so its `question` is
    // empty and the id is the only label it has.
    option.textContent = answer.question || answer.id
    group.appendChild(option)
  }
  el.source.appendChild(group)
}

/** The spoken text of an answer: the tags never reach the TTS, so they are not in the audio. */
function spokenText(answer: CannedAnswer): string {
  return parseGestureTags(answer.answer).clean
}

/**
 * The top row, sampled through the tracks' own queries rather than read from
 * their internals — if `visemeAt` or `articulationAt` is wrong, these bars are
 * wrong in the same way, and a debug view that quietly disagrees with the
 * runtime is worse than none.
 *
 * Whichever source is driving is the one scanned, because the row answers "what
 * was this asked to show", and only one source is ever asked.
 */
function scanArticulations(totalSeconds: number): Block[] {
  const measured = lipSync.visemes.spanCount > 0
  const found: Block[] = []
  let previous: Viseme | null = null

  for (let t = 0; t <= totalSeconds; t += SCAN_STEP) {
    const viseme = measured ? lipSync.visemes.visemeAt(t) : lipSync.alignment.articulationAt(t)
    const last = found[found.length - 1]
    if (viseme && viseme === previous && last) last.end = t + SCAN_STEP
    else if (viseme) found.push({ start: t, end: t + SCAN_STEP, viseme })
    previous = viseme
  }
  return found
}

function charIndexAt(t: number): number {
  if (!alignment) return -1
  for (let i = 0; i < alignment.chars.length; i++) {
    const start = (alignment.charStartTimesMs[i] ?? 0) / 1000
    const end = start + (alignment.charDurationsMs[i] ?? 0) / 1000
    if (t >= start && t < end) return i
  }
  return -1
}

function setStatus(message: string, bad = false): void {
  el.status.textContent = message
  el.status.className = bad ? 'status bad' : 'status'
}

function drawTimeline(playhead: number): void {
  const canvas = el.tl
  const dpr = window.devicePixelRatio || 1
  const width = canvas.clientWidth
  const height = canvas.clientHeight
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr
    canvas.height = height * dpr
  }

  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  if (duration <= 0) {
    ctx.fillStyle = INK
    ctx.globalAlpha = 0.35
    ctx.font = '13px system-ui'
    ctx.fillText('Press Speak to load an utterance.', 12, height / 2)
    ctx.globalAlpha = 1
    return
  }

  const padL = 10
  const padR = 10
  const span = width - padL - padR
  const x = (t: number): number => padL + (t / duration) * span

  const barTop = 12
  const barHeight = 34
  const traceTop = barTop + barHeight + 16
  const traceHeight = 74
  // The band under the trace is what the face actually showed, as opposed to what
  // either source asked for. It is the only row here that is an output.
  const bandTop = traceTop + traceHeight + 6
  const bandHeight = 22
  const charY = bandTop + bandHeight + 22

  // Articulation bars, labelled wherever there is room for the name to fit.
  ctx.textAlign = 'center'
  ctx.font = '600 10px ui-monospace, Consolas, monospace'
  for (const block of blocks) {
    const left = x(block.start)
    const width = Math.max(1.5, x(block.end) - left)
    ctx.fillStyle = VISEME_COLOUR[block.viseme]
    ctx.fillRect(left, barTop, width, barHeight)
    if (width >= 16) {
      ctx.fillStyle = block.viseme === 'sil' ? INK : '#ffffff'
      ctx.fillText(block.viseme, left + width / 2, barTop + barHeight / 2 + 4)
    }
  }
  ctx.textAlign = 'left'

  ctx.strokeStyle = INK
  ctx.globalAlpha = 0.12
  ctx.lineWidth = 1
  ctx.strokeRect(padL, barTop, span, barHeight)
  ctx.strokeRect(padL, traceTop, span, traceHeight)
  ctx.globalAlpha = 1

  // Mouth-open trace, filled under the curve.
  if (trace.length > 1) {
    ctx.beginPath()
    ctx.moveTo(x(trace[0]!.t), traceTop + traceHeight)
    for (const sample of trace) {
      ctx.lineTo(x(sample.t), traceTop + traceHeight - sample.open * traceHeight)
    }
    ctx.lineTo(x(trace[trace.length - 1]!.t), traceTop + traceHeight)
    ctx.closePath()
    ctx.fillStyle = INK
    ctx.globalAlpha = 0.25
    ctx.fill()
    ctx.globalAlpha = 1
  }

  // The viseme band: one stripe per recorded frame, merged into runs. This is the
  // row that answers "what shape was it showing there", and reading it left to
  // right is how a stutter shows up as a stripe too narrow to name.
  for (let i = 0; i < trace.length; i++) {
    const sample = trace[i]
    if (!sample) continue
    let j = i
    while (j + 1 < trace.length && trace[j + 1]?.viseme === sample.viseme) j++
    const from = x(sample.t)
    const to = j + 1 < trace.length ? x(trace[j + 1]!.t) : x(sample.t) + 2
    ctx.fillStyle = VISEME_COLOUR[sample.viseme]
    ctx.fillRect(from, bandTop, Math.max(1, to - from), bandHeight)
    if (to - from >= 16) {
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.font = '600 10px ui-monospace, Consolas, monospace'
      ctx.fillText(sample.viseme, (from + to) / 2, bandTop + bandHeight / 2 + 4)
      ctx.textAlign = 'left'
    }
    i = j
  }
  ctx.strokeStyle = INK
  ctx.globalAlpha = 0.12
  ctx.strokeRect(padL, bandTop, span, bandHeight)
  ctx.globalAlpha = 1

  // Phones, where there are measured ones: the row that turns "that shape is
  // wrong" into "that shape is wrong on the /k/ of `walk`", which is the only
  // form of that observation anybody can act on.
  if (phones) {
    ctx.font = '600 10px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'center'
    for (const phone of phones.phones) {
      if (phone.p === 'SIL') continue
      const left = x(phone.start)
      const right = x(phone.end)
      ctx.fillStyle = INK
      ctx.globalAlpha = 0.08
      ctx.fillRect(left, charY - 11, Math.max(1, right - left - 1), 14)
      ctx.globalAlpha = 0.75
      if (right - left >= 13) ctx.fillText(phone.p.replace(/\d/g, ''), (left + right) / 2, charY)
    }
    ctx.globalAlpha = 1
    ctx.textAlign = 'left'
  }

  // Characters, thinned to whatever fits so they stay readable on a long answer.
  if (alignment) {
    const step = Math.max(1, Math.ceil(alignment.chars.length / (span / 9)))
    ctx.fillStyle = INK
    ctx.globalAlpha = 0.55
    ctx.font = '11px ui-monospace, Consolas, monospace'
    ctx.textAlign = 'center'
    for (let i = 0; i < alignment.chars.length; i += step) {
      const char = alignment.chars[i]
      if (!char || char === ' ') continue
      ctx.fillText(char, x((alignment.charStartTimesMs[i] ?? 0) / 1000), charY)
    }
    ctx.textAlign = 'left'
    ctx.globalAlpha = 1
  }

  // Playhead, plus the lead window the closure query actually reads from.
  const head = x(Math.max(0, playhead))
  ctx.fillStyle = PURPLE
  ctx.globalAlpha = 0.18
  ctx.fillRect(head, barTop, x(config.lipSync.articulationLeadSeconds) - padL, barHeight)
  ctx.globalAlpha = 1
  ctx.strokeStyle = scrubT === null ? INK : PURPLE
  ctx.lineWidth = scrubT === null ? 1.5 : 2.5
  ctx.beginPath()
  ctx.moveTo(head, barTop - 6)
  ctx.lineTo(head, bandTop + bandHeight + 6)
  ctx.stroke()
}

/**
 * Scrubbing.
 *
 * The face is driven from the recorded trace rather than from `LipSync`, because
 * LipSync reads a live analyser: there is nothing to analyse when the audio is
 * not playing, and seeking the audio to re-analyse would mean hearing the clip
 * scrubbed. So the rule is play once, then scrub what was recorded — and what was
 * recorded is exactly what the mouth did, frame for frame, which is the thing
 * worth stepping through.
 */
let scrubT: number | null = null

function timeAtPixel(clientX: number): number {
  const rect = el.tl.getBoundingClientRect()
  const padL = 10
  const span = rect.width - padL * 2
  const fraction = (clientX - rect.left - padL) / Math.max(1, span)
  return Math.max(0, Math.min(duration, fraction * duration))
}

/** The recorded frame nearest a time, by binary search over the trace. */
function sampleAt(t: number): Sample | null {
  if (trace.length === 0) return null
  let lo = 0
  let hi = trace.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((trace[mid]?.t ?? 0) < t) lo = mid + 1
    else hi = mid
  }
  const at = trace[lo]
  const before = trace[Math.max(0, lo - 1)]
  if (!at || !before) return at ?? before ?? null
  return Math.abs(at.t - t) < Math.abs(before.t - t) ? at : before
}

function scrubTo(t: number): void {
  if (trace.length === 0) return
  bus.stop()
  scrubT = t
}

el.tl.addEventListener('pointerdown', (event) => {
  if (trace.length === 0) return
  el.tl.setPointerCapture(event.pointerId)
  scrubTo(timeAtPixel(event.clientX))
})
el.tl.addEventListener('pointermove', (event) => {
  if (scrubT === null || !el.tl.hasPointerCapture(event.pointerId)) return
  scrubTo(timeAtPixel(event.clientX))
})
el.tl.addEventListener('pointerup', (event) => {
  el.tl.releasePointerCapture(event.pointerId)
})

el.speak.addEventListener('click', () => void speak())
el.stop.addEventListener('click', stop)
window.addEventListener('keydown', (event) => {
  if (event.target === el.text) return

  if (event.code === 'Space') {
    event.preventDefault()
    void speak()
    return
  }

  // Frame stepping. The whole reason for a scrubber is the shape that is wrong
  // for two frames somewhere in the middle of a word, and dragging never lands
  // on it — arrow keys do.
  const direction = event.code === 'ArrowRight' ? 1 : event.code === 'ArrowLeft' ? -1 : 0
  if (direction === 0 || trace.length === 0) return
  event.preventDefault()
  const current = scrubT ?? 0
  const index = trace.indexOf(sampleAt(current) ?? trace[0]!)
  const next = trace[Math.max(0, Math.min(trace.length - 1, index + direction))]
  if (next) scrubTo(next.t)
})

// Selecting a clip loads its script into the box. For a cached answer the audio
// is fixed and the text only feeds the estimate and the character readout, so it
// stays editable — retyping a word is how you check whether a mistimed shape is
// the estimate's fault or the mouth's.
el.source.addEventListener('change', () => {
  const answer = answers.get(el.source.value)
  el.text.value = answer ? spokenText(answer) : SAMPLE_TEXT
  el.estimate.disabled = !answer
})
el.estimate.disabled = true

void loadAnswerBank().catch((error: unknown) => {
  setStatus(error instanceof Error ? error.message : String(error), true)
})

function step(dt: number): void {
  // Playing drives the mouth live and records it; scrubbing replays the record.
  // Either way `face.update` still runs, so the blend between shapes is the real
  // one — a scrubbed frame shows the mouth mid-transition exactly as it was.
  const live = lipSync.update(dt)
  const scrubbed = scrubT === null ? null : sampleAt(scrubT)
  const mouthOpen = scrubbed ? scrubbed.open : live.mouthOpen
  const viseme = scrubbed ? scrubbed.viseme : live.viseme

  face.setMouth(mouthOpen, viseme)
  face.setExpression(bus.isPlaying || scrubbed ? 'talking' : 'idle')
  face.update(dt)

  const t = scrubbed ? scrubbed.t : bus.isPlaying ? Math.max(0, bus.playbackSeconds) : 0
  if (bus.isPlaying && !scrubbed) trace.push({ t, open: mouthOpen, viseme })

  el.time.textContent = `${t.toFixed(2)}s${scrubbed ? ' — scrub' : ''}`
  el.viseme.textContent = viseme
  el.open.textContent = mouthOpen.toFixed(2)

  // The character under the playhead, in context. This is what turns "the mouth
  // looks wrong" into "the press is landing a syllable late".
  const index = charIndexAt(t)
  if (alignment && index >= 0) {
    const from = Math.max(0, index - 14)
    const before = alignment.chars.slice(from, index).join('')
    const after = alignment.chars.slice(index + 1, index + 15).join('')
    el.ctx.innerHTML = `${escapeHtml(before)}<b>${escapeHtml(alignment.chars[index] ?? '')}</b>${escapeHtml(after)}`
  } else if (!bus.isPlaying && !scrubbed) {
    el.ctx.textContent = ''
  }

  drawTimeline(t)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

let last = performance.now()
function frame(now: number): void {
  step(Math.min((now - last) / 1000, 0.05))
  last = now
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

// Handy from the console for poking at timings, and necessary to advance at all
// when the tab is in the background — browsers throttle rAF to nothing there.
;(window as unknown as Record<string, unknown>).__lipsync = { bus, lipSync, face, step }
