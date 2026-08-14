import { describe, expect, it } from 'vitest'
import { Greeter } from '../greeter.ts'
import type { GreetInput, GreetingTuning } from '../greeter.ts'

const tuning: GreetingTuning = { onArrival: true, cooldownSeconds: 5 }

const input = (overrides: Partial<GreetInput> = {}): GreetInput => ({
  event: null,
  waved: false,
  visitorId: 1,
  idle: true,
  ...overrides,
})

describe('Greeter', () => {
  it('greets a visitor who walks up', () => {
    const greeter = new Greeter(tuning)
    expect(greeter.consider(0, input({ event: 'arrived' }))).toBe('arrival')
  })

  it('greets a given arrival only once', () => {
    const greeter = new Greeter(tuning)
    greeter.consider(0, input({ event: 'arrived' }))
    // The tracker re-fires arrival after a dropout; the same person shouldn't
    // be waved at twice for standing still.
    expect(greeter.consider(30, input({ event: 'arrived' }))).toBeNull()
  })

  it('greets the next person in the queue', () => {
    const greeter = new Greeter(tuning)
    greeter.consider(0, input({ event: 'arrived', visitorId: 1 }))
    expect(greeter.consider(30, input({ event: 'arrived', visitorId: 2 }))).toBe('arrival')
  })

  it('answers a wave', () => {
    const greeter = new Greeter(tuning)
    expect(greeter.consider(0, input({ waved: true }))).toBe('wave')
  })

  it('answers a wave from someone already greeted on arrival', () => {
    // Ignoring a wave aimed straight at it is the one thing that reads as broken.
    const greeter = new Greeter(tuning)
    greeter.consider(0, input({ event: 'arrived' }))
    expect(greeter.consider(10, input({ waved: true }))).toBe('wave')
  })

  it('never greets over a conversation', () => {
    const greeter = new Greeter(tuning)
    expect(greeter.consider(0, input({ waved: true, idle: false }))).toBeNull()
    expect(greeter.consider(1, input({ event: 'arrived', idle: false }))).toBeNull()
  })

  it('holds off inside the cooldown', () => {
    // The failure mode this exists for: a busy floor churning the nearest face,
    // and a robot that waves without stopping.
    const greeter = new Greeter(tuning)
    expect(greeter.consider(0, input({ waved: true }))).toBe('wave')
    expect(greeter.consider(2, input({ waved: true }))).toBeNull()
    expect(greeter.consider(2, input({ event: 'arrived', visitorId: 9 }))).toBeNull()
    expect(greeter.inCooldown(2)).toBe(true)
  })

  it('greets again once the cooldown expires', () => {
    const greeter = new Greeter(tuning)
    greeter.consider(0, input({ waved: true }))
    expect(greeter.consider(6, input({ waved: true }))).toBe('wave')
  })

  it('leaves arrival greetings off when configured off', () => {
    const greeter = new Greeter({ ...tuning, onArrival: false })
    expect(greeter.consider(0, input({ event: 'arrived' }))).toBeNull()
    // A wave still gets answered — that's a different question.
    expect(greeter.consider(0, input({ waved: true }))).toBe('wave')
  })
})
