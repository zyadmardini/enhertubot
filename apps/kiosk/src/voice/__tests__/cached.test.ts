import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CachedDriver } from '../adapters/cached.ts'
import { hasCannedAnswers } from '../types.ts'
import type { DriverEvent } from '../types.ts'
import { GestureScheduler, parseGestureTags } from '../../core/gestures.ts'

/**
 * The cached driver, and the path from a pre-rendered answer to a moving robot.
 *
 * The animation half is the part worth pinning down here. A cached answer is a
 * plain MP3 with no timing metadata of any kind, so everything the body does is
 * derived from the tags in the manifest text and the decoded duration — and the
 * scene subtree only mounts in a real browser, which puts all of it out of reach
 * of any test that goes through React. So the wiring is exercised directly.
 */

const MANIFEST = {
  answers: [
    {
      id: 'what-are-you',
      hotkey: '1',
      question: 'What are you?',
      answer: '[wave] I am Enubot. I live on this screen.',
      file: 'what-are-you.mp3',
    },
    {
      id: 'keynote',
      hotkey: '3',
      question: 'Where is the keynote?',
      answer: '[point] Main hall, past the coffee. [nod] Ten sharp.',
      file: 'keynote.mp3',
      // Baked by `npm run bake:gestures`, and the timings the app should trust
      // over anything it could infer from where the tags sit in the text.
      cues: [
        { kind: 'gesture' as const, name: 'point' as const, atSeconds: 0 },
        { kind: 'gesture' as const, name: 'nod' as const, atSeconds: 2.4 },
      ],
      alignmentFile: 'keynote.alignment.json',
    },
  ],
  refusalFallback: {
    id: 'refusal-fallback',
    question: '',
    answer: '[shrug] Above my pay grade.',
    file: 'refusal-fallback.mp3',
  },
}

/** Six answers, no sidecars, so the warm's concurrency and order are visible. */
const WIDE_MANIFEST = {
  answers: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => ({
    id,
    question: `${id}?`,
    answer: `${id}.`,
    file: `${id}.mp3`,
  })),
}

/** Every clip decodes to a five-second buffer; only its duration is ever read. */
const BUFFER = { duration: 5 } as AudioBuffer

const ALIGNMENT = {
  chars: [...'Main hall'],
  charStartTimesMs: [...'Main hall'].map((_, i) => i * 90),
  charDurationsMs: [...'Main hall'].map(() => 90),
}

function stubFetch(manifest: unknown = MANIFEST) {
  return vi.fn(async (input: string) => {
    if (String(input).endsWith('manifest.json')) {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => manifest,
      } as unknown as Response
    }
    if (String(input).endsWith('.alignment.json')) {
      return {
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ALIGNMENT,
      } as unknown as Response
    }
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'audio/mpeg' }),
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as Response
  })
}

function makeDriver() {
  const audioContext = {
    decodeAudioData: vi.fn(async () => BUFFER),
  } as unknown as AudioContext
  const driver = new CachedDriver({ audioContext, proxyUrl: 'http://127.0.0.1:8787' })
  // Turn events and warm progress are collected apart. They travel on the same
  // channel but answer different questions — one is what the visitor is being
  // told, the other is how much of the bank is downloaded — and an assertion
  // about a turn should not have to step over the boot chatter to make it.
  const events: DriverEvent[] = []
  const warming: Array<Extract<DriverEvent, { type: 'warming' }>> = []
  driver.on((event) => {
    if (event.type === 'warming') warming.push(event)
    else events.push(event)
  })
  return { driver, events, warming, audioContext }
}

/** Drain timers and the microtasks the decode chain resolves through. */
async function settle() {
  for (let i = 0; i < 8; i++) {
    await vi.advanceTimersByTimeAsync(50)
  }
}

/** Drain microtasks only, so nothing that is merely waiting on a timer moves. */
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', stubFetch())
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('CachedDriver', () => {
  it('advertises its bank so the hotkeys have one source', async () => {
    const { driver } = makeDriver()
    await driver.connect()

    expect(hasCannedAnswers(driver)).toBe(true)
    expect(driver.bank.map((answer) => answer.hotkey)).toEqual(['1', '3'])
  })

  it('emits a full turn — transcript, tagged text, then audio', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.pttUp()
    await settle()

    expect(events.map((event) => event.type)).toEqual(['user_transcript', 'agent_text', 'audio'])
    expect(events[0]).toMatchObject({ text: 'What are you?', final: true })
    // Tags travel in the text; the runtime strips them. Anything that arrives
    // already-stripped has silently dropped every gesture in the answer.
    expect(events[1]).toMatchObject({ text: MANIFEST.answers[0]!.answer, done: true })
    expect(events[2]).toMatchObject({ type: 'audio', buffer: BUFFER })
  })

  it('sends no alignment when none was captured at render time', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.pttUp()
    await settle()

    // An MP3 carries no timings, and inventing linear ones over real speech would
    // press the lips shut on the wrong syllables — worse than the analyser alone.
    const audio = events.find((event) => event.type === 'audio')
    expect(audio && 'alignment' in audio ? audio.alignment : undefined).toBeUndefined()
  })

  it('sends the alignment sidecar when the bake recorded one', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.speak('keynote')
    await settle()

    const audio = events.find((event) => event.type === 'audio')
    expect(audio && 'alignment' in audio ? audio.alignment : undefined).toMatchObject({
      charStartTimesMs: ALIGNMENT.charStartTimesMs,
    })
  })

  it('still speaks when the alignment sidecar is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input).endsWith('manifest.json')) {
          return {
            ok: true,
            headers: new Headers({ 'content-type': 'application/json' }),
            json: async () => MANIFEST,
          } as unknown as Response
        }
        if (String(input).endsWith('.alignment.json')) {
          return { ok: false, status: 404 } as unknown as Response
        }
        return {
          ok: true,
          headers: new Headers({ 'content-type': 'audio/mpeg' }),
          arrayBuffer: async () => new ArrayBuffer(8),
        } as unknown as Response
      }),
    )
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.speak('keynote')
    await settle()

    // Degrading to the analyser is the correct outcome. A missing sidecar must
    // never cost the answer its voice.
    const audio = events.find((event) => event.type === 'audio')
    expect(audio).toMatchObject({ type: 'audio', buffer: BUFFER })
    expect(audio && 'alignment' in audio ? audio.alignment : undefined).toBeUndefined()
  })

  describe('baked cues', () => {
    it('emits the baked track after the text it belongs to', async () => {
      const { driver, events } = makeDriver()
      await driver.connect()

      driver.speak('keynote')
      await settle()

      expect(events.map((event) => event.type)).toEqual([
        'user_transcript',
        'agent_text',
        'cues',
        'audio',
      ])
      const cues = events.find((event) => event.type === 'cues')
      expect(cues).toMatchObject({ track: MANIFEST.answers[1]!.cues })
    })

    it('emits nothing for an answer that has not been baked', async () => {
      const { driver, events } = makeDriver()
      await driver.connect()

      // The runtime then falls back to placing tags by character position, which
      // is the pre-bake behaviour and still correct — just less accurate.
      driver.speak('what-are-you')
      await settle()

      expect(events.some((event) => event.type === 'cues')).toBe(false)
    })
  })

  it('walks the bank so repeated presses cover every clip', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    for (let i = 0; i < 3; i++) {
      driver.pttUp()
      await settle()
    }

    const asked = events
      .filter((event) => event.type === 'user_transcript')
      .map((event) => (event.type === 'user_transcript' ? event.text : ''))
    expect(asked).toEqual(['What are you?', 'Where is the keynote?', 'What are you?'])
  })

  it('plays a specific answer by id for the staff hotkeys', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.speak('keynote')
    await settle()

    expect(events[0]).toMatchObject({ text: 'Where is the keynote?' })
  })

  it('falls back to the refusal clip for an id it has never heard of', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.speak('what-is-the-airspeed-velocity-of-an-unladen-swallow')
    await settle()

    expect(events.some((event) => event.type === 'error')).toBe(false)
    expect(events.find((event) => event.type === 'agent_text')).toMatchObject({
      text: MANIFEST.refusalFallback.answer,
    })
  })

  it('speaks nothing more after a barge-in', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.pttUp()
    driver.interrupt()
    await settle()

    // Not just "no audio": a text event landing after the visitor cut in puts a
    // caption on screen for an answer that is never spoken.
    expect(events).toEqual([])
  })

  it('reuses a decoded clip rather than decoding it again', async () => {
    const { driver, audioContext } = makeDriver()
    await driver.connect()
    await settle()

    driver.speak('keynote')
    await settle()
    driver.speak('keynote')
    await settle()

    // Two answers plus the refusal, warmed once each at connect, and never again.
    expect(audioContext.decodeAudioData).toHaveBeenCalledTimes(3)
  })

  it('says what is wrong when the manifest is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response),
    )
    const { driver } = makeDriver()

    await expect(driver.connect()).rejects.toThrow(/Render the answers first/)
  })

  it('does not mistake a dev server SPA fallback for a manifest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => ({}),
      }) as unknown as Response),
    )
    const { driver } = makeDriver()

    await expect(driver.connect()).rejects.toThrow(/returned HTML/)
  })

  /**
   * The warm, which is what boot holds the screen for.
   *
   * Nothing here is about how an answer sounds — it is about the bank being in
   * memory before anyone can press the button. A press that has to wait on a
   * fetch is the failure this whole path exists to prevent, and it used to be
   * the normal case on a cold load.
   */
  describe('warming the bank', () => {
    it('announces the total before connect resolves, and counts to it', async () => {
      const { driver, warming } = makeDriver()
      await driver.connect()

      // Before, not after: the runtime reads this to decide whether a warm is
      // even coming, and a driver that says nothing is treated as ready.
      expect(warming[0]).toEqual({ type: 'warming', done: 0, total: 3 })

      await settle()

      // Two answers plus the refusal clip. Done equals total is what readiness is.
      expect(warming.at(-1)).toEqual({ type: 'warming', done: 3, total: 3 })
    })

    it('warms a few at a time, in the order the press-to-talk cursor walks', async () => {
      const gates = new Map<string, () => void>()
      const started: string[] = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const url = String(input)
          if (url.endsWith('manifest.json')) {
            return {
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              json: async () => WIDE_MANIFEST,
            } as unknown as Response
          }
          started.push(url.split('/').pop() ?? url)
          await new Promise<void>((resolve) => gates.set(url, resolve))
          return {
            ok: true,
            headers: new Headers({ 'content-type': 'audio/mpeg' }),
            arrayBuffer: async () => new ArrayBuffer(8),
          } as unknown as Response
        }),
      )

      const { driver } = makeDriver()
      await driver.connect()
      await flush()

      // Firing all six at once is what this replaced: every clip landed in one
      // heap, so the one the first press needs finished near last.
      expect(started).toEqual(['a.mp3', 'b.mp3', 'c.mp3'])

      gates.get('/fallback/a.mp3')?.()
      await flush()

      // A slot frees, the next clip in bank order takes it.
      expect(started).toEqual(['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'])
    })

    it('counts a clip that fails, so one 404 cannot hold the screen', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const url = String(input)
          if (url.endsWith('manifest.json')) {
            return {
              ok: true,
              headers: new Headers({ 'content-type': 'application/json' }),
              json: async () => MANIFEST,
            } as unknown as Response
          }
          if (url.endsWith('keynote.mp3')) return { ok: false, status: 404 } as unknown as Response
          return {
            ok: true,
            headers: new Headers({ 'content-type': 'audio/mpeg' }),
            arrayBuffer: async () => new ArrayBuffer(8),
          } as unknown as Response
        }),
      )

      const { driver, warming } = makeDriver()
      await driver.connect()
      await settle()

      // The missing clip fails on its own press, recoverably, exactly as before.
      // What it must not do is leave the kiosk behind a loading bar for ever.
      expect(warming.at(-1)).toEqual({ type: 'warming', done: 3, total: 3 })
    })
  })
})

describe('cached answers drive the body', () => {
  /**
   * The end-to-end shape of the animation path, with the same wiring the runtime
   * does: the driver's tagged text is parsed, scheduled, calibrated against the
   * real decoded duration, and then ticked against audio playback position.
   */
  it('fires each gesture at its clause, re-timed to the real clip length', async () => {
    const { driver, events } = makeDriver()
    await driver.connect()

    driver.speak('keynote')
    await settle()

    const text = events.find((event) => event.type === 'agent_text')
    const parsed = parseGestureTags(text?.type === 'agent_text' ? text.text : '')
    expect(parsed.clean).toBe('Main hall, past the coffee. Ten sharp.')
    expect(parsed.tags.map((tag) => tag.name)).toEqual(['point', 'nod'])

    const scheduler = new GestureScheduler({ leadSeconds: 0.2, charsPerSecond: 14 })
    const fired: string[] = []
    scheduler.on('fire', (name) => fired.push(name))
    scheduler.schedule(parsed)
    // The estimate has 38 chars at 14/s ≈ 2.7s; the clip is really 5s, so every
    // pending gesture has to stretch with it or the second one lands early.
    scheduler.calibrate(BUFFER.duration)

    // Calibration scales the lead along with the clause, so a tag sitting at
    // character zero lands a shade after zero rather than exactly on it.
    scheduler.update(0)
    expect(fired).toEqual([])
    scheduler.update(0.2)
    expect(fired).toEqual(['point'])

    // 'Ten sharp.' starts 28 of 38 characters in — roughly 3.5s into a
    // five-second clip, and 2.0s into the 2.7s the estimate alone would have
    // guessed. Firing it at 2.5 would be the uncalibrated answer.
    scheduler.update(2.5)
    expect(fired).toEqual(['point'])
    scheduler.update(3.5)
    expect(fired).toEqual(['point', 'nod'])
  })
})
