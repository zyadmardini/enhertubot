import { describe, expect, it } from 'vitest'
import { bootStatus } from '../progress.ts'

/**
 * What the boot bar promises, and the two ways it must not lie.
 *
 * It must not finish early — a bar at 100% over a robot that then swaps its body
 * or stands silent through a press is worse than no bar at all. And it must not
 * fail to finish: every path out of a download, including the ones that go
 * wrong, has to release the screen.
 */

const warming = (done: number, total: number) => ({ done, total, ready: done >= total })
const noVoiceYet = { done: 0, total: 0, ready: false }

describe('bootStatus', () => {
  it('waits for both downloads before calling the kiosk ready', () => {
    const modelOnly = bootStatus({ modelRatio: 1, modelSettled: true, voice: warming(4, 11) })
    const voiceOnly = bootStatus({ modelRatio: 0.4, modelSettled: false, voice: warming(11, 11) })

    expect(modelOnly.ready).toBe(false)
    expect(voiceOnly.ready).toBe(false)
    expect(
      bootStatus({ modelRatio: 1, modelSettled: true, voice: warming(11, 11) }).ready,
    ).toBe(true)
  })

  it('treats a missing model as settled, not as a wait', () => {
    // The GLB failing to load is an answer: the placeholder carries the scene.
    // Holding the screen for it would turn a graceful fallback into a hang.
    const status = bootStatus({ modelRatio: 1, modelSettled: true, voice: warming(3, 3) })

    expect(status.ready).toBe(true)
    expect(status.label).toBe('Ready')
  })

  it('moves on the model before the answer bank has reported anything', () => {
    // The manifest lands after the model has been downloading for a while, so
    // until it does the voice half has no total. The bar still has to move.
    const early = bootStatus({ modelRatio: 0.5, modelSettled: false, voice: noVoiceYet })

    expect(early.ratio).toBeCloseTo(0.25)
    expect(early.ratio).toBeGreaterThan(
      bootStatus({ modelRatio: 0.1, modelSettled: false, voice: noVoiceYet }).ratio,
    )
  })

  it('never reports more than done or less than nothing', () => {
    // A gzipped response reports more decoded bytes than its Content-Length.
    const over = bootStatus({ modelRatio: 1.4, modelSettled: true, voice: warming(3, 3) })
    const under = bootStatus({ modelRatio: Number.NaN, modelSettled: false, voice: noVoiceYet })

    expect(over.ratio).toBe(1)
    expect(under.ratio).toBe(0)
  })

  it('says which half is still going', () => {
    expect(bootStatus({ modelRatio: 0.3, modelSettled: false, voice: noVoiceYet }).label).toBe(
      'Waking Enubot up',
    )
    expect(bootStatus({ modelRatio: 1, modelSettled: true, voice: warming(2, 11) }).label).toBe(
      'Loading his voice',
    )
  })
})
