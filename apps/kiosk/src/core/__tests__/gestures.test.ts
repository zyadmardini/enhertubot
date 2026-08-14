import { describe, expect, it, vi } from 'vitest'
import { GestureScheduler, parseGestureTags } from '../gestures.ts'
import type { BakedTrack, ParsedText } from '../gestures.ts'

/** A stream that always returns the same value, so jitter is a known constant. */
const fixed = (value: number) => () => value

/** ParsedText is three fields; most tests only care about one. */
function parsed(partial: Partial<ParsedText>): ParsedText {
  return { clean: '', tags: [], expressions: [], ...partial }
}

describe('parseGestureTags', () => {
  it('strips tags and reports positions against the cleaned text', () => {
    const { clean, tags } = parseGestureTags('[wave] Hello there, friend.')
    expect(clean).toBe('Hello there, friend.')
    expect(tags).toEqual([{ name: 'wave', charIndex: 0, optional: false }])
  })

  it('keeps later tag positions aligned after earlier tags are removed', () => {
    // The whole point of measuring against cleaned text: the TTS never sees the
    // tags, so raw offsets would drift further out with every tag in the line.
    const { clean, tags } = parseGestureTags('[nod] Yes. [shrug] Maybe not.')
    expect(clean).toBe('Yes. Maybe not.')
    expect(tags[0]).toEqual({ name: 'nod', charIndex: 0, optional: false })
    expect(clean.slice(tags[1]!.charIndex)).toBe('Maybe not.')
  })

  it('is case insensitive and ignores unknown tags', () => {
    const { clean, tags } = parseGestureTags('[WAVE] hi [dance] there')
    expect(tags).toHaveLength(1)
    expect(tags[0]?.name).toBe('wave')
    expect(clean).toContain('[dance]')
  })

  it('returns text unchanged when there are no tags', () => {
    const { clean, tags } = parseGestureTags('Just a plain answer.')
    expect(clean).toBe('Just a plain answer.')
    expect(tags).toEqual([])
  })

  it('collects expression tags separately from gestures', () => {
    const { clean, tags, expressions } = parseGestureTags('[sorry] I missed that. [shrug] Try again?')
    expect(clean).toBe('I missed that. Try again?')
    expect(tags.map((t) => t.name)).toEqual(['shrug'])
    expect(expressions).toEqual([{ name: 'sorry', charIndex: 0 }])
  })

  it('marks a question-marked beat as optional', () => {
    const { clean, tags } = parseGestureTags('Sure. [nod?] Happy to help.')
    expect(clean).toBe('Sure. Happy to help.')
    expect(tags[0]?.optional).toBe(true)
  })

  it('keeps a misspelled tag in the text where it is visible', () => {
    // Swallowing it would send `[shurg]` to TTS to be read aloud at a visitor.
    // Left in, it shows up in the captions and in `npm run check:cache`.
    const { clean, tags } = parseGestureTags('Well, [shurg] who knows.')
    expect(clean).toContain('[shurg]')
    expect(tags).toEqual([])
  })
})

describe('GestureScheduler', () => {
  const options = { leadSeconds: 0.2, charsPerSecond: 10 }

  it('fires a gesture ahead of the clause it belongs to', () => {
    const scheduler = new GestureScheduler(options)
    const fired = vi.fn()
    scheduler.on('fire', fired)

    // 20 chars in at 10 chars/sec = 2.0s, minus the 0.2s lead = 1.8s.
    scheduler.schedule(
      parsed({ clean: 'a'.repeat(40), tags: [{ name: 'point', charIndex: 20, optional: false }] }),
    )

    scheduler.update(1.7)
    expect(fired).not.toHaveBeenCalled()
    scheduler.update(1.85)
    expect(fired).toHaveBeenCalledWith('point')
  })

  it('fires each gesture exactly once', () => {
    const scheduler = new GestureScheduler(options)
    const fired = vi.fn()
    scheduler.on('fire', fired)
    scheduler.schedule(
      parsed({ clean: 'a'.repeat(20), tags: [{ name: 'nod', charIndex: 0, optional: false }] }),
    )

    scheduler.update(0.5)
    scheduler.update(1.0)
    scheduler.update(1.5)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('drops everything pending on flush', () => {
    const scheduler = new GestureScheduler(options)
    const fired = vi.fn()
    scheduler.on('fire', fired)
    scheduler.schedule(
      parsed({ clean: 'a'.repeat(60), tags: [{ name: 'wave', charIndex: 50, optional: false }] }),
    )

    // Barge-in: Enubot must never finish a wave for a sentence it stopped saying.
    scheduler.flush()
    scheduler.update(99)
    expect(fired).not.toHaveBeenCalled()
    expect(scheduler.pending).toBe(0)
  })

  it('re-times pending gestures when the real audio runs longer than estimated', () => {
    const scheduler = new GestureScheduler(options)
    const fired = vi.fn()
    scheduler.on('fire', fired)
    // 100 chars ≈ 10s estimated; tag at 50 chars ≈ 5s, fires at 4.8s.
    scheduler.schedule(
      parsed({ clean: 'a'.repeat(100), tags: [{ name: 'shrug', charIndex: 50, optional: false }] }),
    )

    // Audio actually runs 20s, so the tag belongs at ~10s, firing at 9.8s.
    scheduler.calibrate(20)
    scheduler.update(5)
    expect(fired).not.toHaveBeenCalled()
    scheduler.update(9.9)
    expect(fired).toHaveBeenCalledWith('shrug')
  })

  it('leaves already-fired gestures alone when calibrating mid-playback', () => {
    const scheduler = new GestureScheduler(options)
    const fired = vi.fn()
    scheduler.on('fire', fired)
    scheduler.schedule(
      parsed({
        clean: 'a'.repeat(100),
        tags: [
          { name: 'wave', charIndex: 0, optional: false },
          { name: 'nod', charIndex: 50, optional: false },
        ],
      }),
    )

    scheduler.update(0.1)
    expect(fired).toHaveBeenCalledTimes(1)
    scheduler.calibrate(20)
    scheduler.update(0.2)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('places an expression on its clause rather than ahead of it', () => {
    const scheduler = new GestureScheduler(options)
    const expressed = vi.fn()
    scheduler.on('express', expressed)
    scheduler.schedule(
      parsed({ clean: 'a'.repeat(100), expressions: [{ name: 'happy', charIndex: 50 }] }),
    )

    // A led expression would put the face on before the words that justify it.
    scheduler.update(4.9)
    expect(expressed).not.toHaveBeenCalled()
    scheduler.update(5.05)
    expect(expressed).toHaveBeenCalledWith('happy')
  })

  describe('baked tracks', () => {
    const track: BakedTrack = [{ kind: 'gesture', name: 'point', atSeconds: 2 }]

    it('fires at the measured time, led but not estimated', () => {
      const scheduler = new GestureScheduler(options)
      const fired = vi.fn()
      scheduler.on('fire', fired)
      scheduler.scheduleBaked(track)

      scheduler.update(1.75)
      expect(fired).not.toHaveBeenCalled()
      scheduler.update(1.85)
      expect(fired).toHaveBeenCalledWith('point')
    })

    it('ignores calibration, whose input it already had', () => {
      const scheduler = new GestureScheduler(options)
      const fired = vi.fn()
      scheduler.on('fire', fired)
      scheduler.scheduleBaked(track)

      // The estimate path would rescale here. Doing so to a measured time takes
      // a correct number and makes it wrong.
      scheduler.calibrate(40)
      scheduler.update(1.85)
      expect(fired).toHaveBeenCalledWith('point')
    })

    it('applies jitter within the configured spread', () => {
      const late = new GestureScheduler({ ...options, jitterSeconds: 0.1, rng: fixed(1) })
      const early = new GestureScheduler({ ...options, jitterSeconds: 0.1, rng: fixed(0) })
      const lateFired = vi.fn()
      const earlyFired = vi.fn()
      late.on('fire', lateFired)
      early.on('fire', earlyFired)
      late.scheduleBaked(track)
      early.scheduleBaked(track)

      // 2.0 − 0.2 lead, ±0.1: the late one at 1.9, the early one at 1.7.
      early.update(1.75)
      late.update(1.75)
      expect(earlyFired).toHaveBeenCalled()
      expect(lateFired).not.toHaveBeenCalled()
      late.update(1.95)
      expect(lateFired).toHaveBeenCalled()
    })

    it('drops an optional beat when the roll goes against it', () => {
      const optional: BakedTrack = [
        { kind: 'gesture', name: 'nod', atSeconds: 1, optional: true },
      ]
      const kept = new GestureScheduler({ ...options, optionalChance: 0.5, rng: fixed(0.1) })
      const dropped = new GestureScheduler({ ...options, optionalChance: 0.5, rng: fixed(0.9) })

      kept.scheduleBaked(optional)
      dropped.scheduleBaked(optional)
      expect(kept.pending).toBe(1)
      // Rolled at schedule time, so `pending` is honest before playback starts.
      expect(dropped.pending).toBe(0)
    })

    /** Fire times for one seed, probed finely enough to see the jitter. */
    const times = (seed: number): string[] => {
      const scheduler = new GestureScheduler({ ...options, jitterSeconds: 0.15 })
      scheduler.reseed(seed)
      let probe = 0
      const fired: string[] = []
      scheduler.on('fire', (name) => fired.push(`${name}@${probe.toFixed(3)}`))
      scheduler.scheduleBaked([
        { kind: 'gesture', name: 'nod', atSeconds: 1 },
        { kind: 'gesture', name: 'wave', atSeconds: 2 },
      ])
      for (probe = 0; probe <= 3; probe += 0.005) scheduler.update(probe)
      return fired
    }

    it('is reproducible from a seed', () => {
      // The property that makes "it shrugged in the wrong place" chaseable at all.
      expect(times(7)).toEqual(times(7))
    })

    it('varies between turns', () => {
      const distinct = new Set([1, 2, 3, 4, 5].map((seed) => times(seed).join(' ')))
      expect(distinct.size).toBeGreaterThan(1)
    })
  })
})
