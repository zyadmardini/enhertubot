import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationMachine, pressToVoiceMs } from '../machine.ts'

/** Controllable clock so latency assertions don't depend on real timing. */
function makeClock() {
  let now = 0
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('ConversationMachine', () => {
  let clock: ReturnType<typeof makeClock>
  let machine: ConversationMachine

  beforeEach(() => {
    clock = makeClock()
    machine = new ConversationMachine(clock.now)
  })

  it('walks a complete turn back to idle', () => {
    expect(machine.state).toBe('idle')
    machine.send({ type: 'ptt_down' })
    expect(machine.state).toBe('listening')
    machine.send({ type: 'ptt_up' })
    expect(machine.state).toBe('thinking')
    machine.send({ type: 'audio_start' })
    expect(machine.state).toBe('speaking')
    machine.send({ type: 'audio_end' })
    expect(machine.state).toBe('idle')
  })

  it('measures press-to-first-audio', () => {
    machine.send({ type: 'ptt_down' })
    clock.advance(900)
    machine.send({ type: 'ptt_up' })
    clock.advance(820)
    machine.send({ type: 'audio_start' })
    clock.advance(2000)
    machine.send({ type: 'audio_end' })

    // Time held on the button must not count — only release to first sound.
    expect(pressToVoiceMs(machine.turn)).toBe(820)
  })

  it('reports an interrupted turn without an audio-end time', () => {
    const onTurn = vi.fn()
    machine.on('turn', onTurn)

    machine.send({ type: 'ptt_down' })
    machine.send({ type: 'ptt_up' })
    machine.send({ type: 'audio_start' })
    machine.send({ type: 'interrupt' })

    expect(machine.state).toBe('idle')
    expect(onTurn).toHaveBeenCalledTimes(1)
    expect(onTurn.mock.calls[0]?.[0]).toMatchObject({ interrupted: true, audioEndAt: null })
  })

  it('treats a press during playback as barge-in plus the start of the next turn', () => {
    const states: string[] = []
    machine.on('state', ({ to }) => states.push(to))

    machine.send({ type: 'ptt_down' })
    machine.send({ type: 'ptt_up' })
    machine.send({ type: 'audio_start' })
    machine.send({ type: 'ptt_down' })

    expect(machine.state).toBe('listening')
    expect(states).toEqual(['listening', 'thinking', 'speaking', 'idle', 'listening'])
    // Metrics must reset, or the interrupted turn's timestamps pollute the next one.
    expect(machine.turn.firstAudioAt).toBeNull()
  })

  it('ignores a release that was never preceded by a press', () => {
    machine.send({ type: 'ptt_up' })
    expect(machine.state).toBe('idle')
  })

  it('ignores audio that arrives after the turn was abandoned', () => {
    machine.send({ type: 'ptt_down' })
    machine.send({ type: 'ptt_up' })
    machine.send({ type: 'interrupt' })
    machine.send({ type: 'audio_start' })
    expect(machine.state).toBe('idle')
  })

  it('records only the first token time when text streams in', () => {
    machine.send({ type: 'ptt_down' })
    machine.send({ type: 'ptt_up' })
    clock.advance(300)
    machine.send({ type: 'agent_text', text: 'Main', done: false })
    clock.advance(200)
    machine.send({ type: 'agent_text', text: 'Main hall.', done: true })
    expect(machine.turn.firstTextAt).toBe(300)
  })
})
