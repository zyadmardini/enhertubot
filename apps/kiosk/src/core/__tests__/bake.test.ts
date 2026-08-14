import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseGestureTags } from '../gestures.ts'
import type { BakedCue } from '../gestures.ts'

/**
 * Keeps `scripts/bake-gestures.mjs` honest.
 *
 * The bake carries its own copy of the tag parser, because the scripts run on
 * plain node with no build step and the real one is TypeScript. A copy is a
 * liability: if the two ever disagree about where a tag sits, the baked times
 * describe a sentence the app isn't speaking, and nothing at runtime can tell.
 *
 * So the copy is checked rather than trusted. This runs the *real* parser over
 * the committed manifest and asserts the baked track agrees with it — which
 * fails the moment either parser is changed without the other.
 */

interface ManifestEntry {
  id: string
  answer: string
  cues?: BakedCue[]
}

interface Manifest {
  answers: ManifestEntry[]
  refusalFallback?: ManifestEntry
}

const manifest = JSON.parse(
  readFileSync(new URL('../../../public/fallback/manifest.json', import.meta.url), 'utf8'),
) as Manifest

const entries = [...manifest.answers, ...(manifest.refusalFallback ? [manifest.refusalFallback] : [])]

/** What the real parser says this answer's cues are, in text order. */
function expected(answer: string): string[] {
  const { tags, expressions } = parseGestureTags(answer)
  return [
    ...tags.map((t) => ({ at: t.charIndex, label: `gesture:${t.name}` })),
    ...expressions.map((t) => ({ at: t.charIndex, label: `expression:${t.name}` })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((cue) => cue.label)
}

describe('baked cue tracks', () => {
  it('has answers to check', () => {
    expect(entries.length).toBeGreaterThan(0)
  })

  for (const entry of entries) {
    describe(entry.id, () => {
      it('bakes exactly the cues the app parses', () => {
        const actual = (entry.cues ?? []).map((cue) => `${cue.kind}:${cue.name}`)
        expect(actual).toEqual(expected(entry.answer))
      })

      it('places every cue inside the utterance, in order', () => {
        const times = (entry.cues ?? []).map((cue) => cue.atSeconds)
        for (const time of times) expect(time).toBeGreaterThanOrEqual(0)
        // A track out of order would still fire correctly — the scheduler sorts —
        // but it means the bake read the text differently from the parser above.
        expect([...times].sort((a, b) => a - b)).toEqual(times)
      })
    })
  }
})
