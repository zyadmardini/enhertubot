import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { VisemeTrack } from '../visemes.ts'
import type { PhoneTrack } from '../visemes.ts'

/**
 * Keeps the committed alignment honest.
 *
 * `npm run bake:visemes` writes a `<id>.phones.json` beside every answer and the
 * result is committed, which means the mouth a visitor sees is decided by files
 * in the repo rather than by anything the app computes. A bad bake — the wrong
 * script against the right audio, an aligner that gave up and called half the
 * clip silence, a re-render nobody re-aligned — produces a well-formed file that
 * drives the mouth confidently and wrongly, and nothing at runtime can tell.
 *
 * So the shipped tracks are measured here, through the real `VisemeTrack`, and
 * held to what speech actually looks like. The bounds are deliberately wide: this
 * is a smoke alarm for a bank that has gone stale, not a tuning test.
 */

interface ManifestEntry {
  id: string
  file: string
  phonesFile?: string
}

interface Manifest {
  answers: ManifestEntry[]
  refusalFallback?: ManifestEntry
}

const FALLBACK = new URL('../../../public/fallback/', import.meta.url)

const manifest = JSON.parse(
  readFileSync(new URL('manifest.json', FALLBACK), 'utf8'),
) as Manifest

const entries = [...manifest.answers, ...(manifest.refusalFallback ? [manifest.refusalFallback] : [])]

/** Matches `lipSync.minMeasuredSeconds` in enubot.config.ts. */
const MIN_SPAN = 0.033

function load(entry: ManifestEntry): PhoneTrack {
  return JSON.parse(readFileSync(new URL(entry.phonesFile ?? '', FALLBACK), 'utf8')) as PhoneTrack
}

interface Stats {
  /** Shape changes per second of speech. Real speech does roughly 5 to 8. */
  rate: number
  /** How many of the fifteen shapes the answer uses. */
  distinct: number
  /** Share of the clip the track has an opinion about. */
  coverage: number
}

function measure(track: PhoneTrack): Stats {
  const visemes = new VisemeTrack({ minSpanSeconds: MIN_SPAN })
  visemes.append(track, 0)

  const duration = track.durationSeconds ?? 0
  const spans = visemes.spans
  const shown = spans.filter((span) => span.viseme !== 'sil')
  const covered = spans.reduce((total, span) => total + (span.end - span.start), 0)

  return {
    rate: shown.length / Math.max(0.001, duration),
    distinct: new Set(shown.map((span) => span.viseme)).size,
    coverage: covered / Math.max(0.001, duration),
  }
}

describe('the committed answer bank', () => {
  it('has been through the aligner', () => {
    // Not a style preference: on the `cached` driver these files are the mouth.
    // An answer without one falls back to the analyser, which cannot see a
    // consonant — see audio/visemes.ts.
    expect(entries.filter((entry) => entry.phonesFile).map((entry) => entry.id)).toEqual(
      entries.map((entry) => entry.id),
    )
  })

  for (const entry of entries) {
    describe(entry.id, () => {
      const track = load(entry)
      const stats = measure(track)

      it('covers the whole clip, so the mouth is never handed back mid-answer', () => {
        expect(stats.coverage).toBeGreaterThan(0.95)
      })

      it('changes shape at something like a speaking rate', () => {
        // Below about 3 the alignment has collapsed into long held shapes, which
        // is what a mismatched script looks like. Above about 14 it is describing
        // something no jaw could do.
        expect(stats.rate).toBeGreaterThan(3)
        expect(stats.rate).toBeLessThan(14)
      })

      it('uses enough of the shape vocabulary to read as articulation', () => {
        // The failure this catches is a mouth that flaps between three vowels for
        // ten seconds — which is exactly what the analyser alone produces, and
        // therefore the thing worth proving we no longer do.
        expect(stats.distinct).toBeGreaterThanOrEqual(8)
      })
    })
  }
})
