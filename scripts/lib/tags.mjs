/**
 * Inline gesture tags, parsed the way the app parses them.
 *
 * Must stay in step with `parseGestureTags` in
 * `apps/kiosk/src/core/gestures.ts`. Kept as a copy rather than imported because
 * these scripts run on plain node with no build step, and shared between the
 * bake scripts rather than copied into each of them — two copies of a parser
 * that has to agree character-for-character is already one too many.
 *
 * `src/core/__tests__/bake.test.ts` runs the real parser over the committed
 * manifest and fails if the two ever disagree, so the duplication is checked
 * rather than trusted.
 */

const GESTURE_NAMES = ['wave', 'bye', 'point', 'present', 'shrug', 'nod', 'shake', 'think']
const EXPRESSION_NAMES = ['happy', 'confused', 'surprised', 'sorry']
const TAG_PATTERN = /\[([a-z_]+)(\?)?\]/gi

/**
 * Split `text` into the words that were spoken and the cues that were not.
 *
 * `charIndex` is an offset into `clean`, which is what makes a tag position
 * resolvable to an audio time later.
 */
export function parseTags(text) {
  const cues = []
  let clean = ''
  let lastIndex = 0

  const append = (chunk) => {
    let next = chunk.replace(/[ \t]{2,}/g, ' ')
    if (clean.length === 0 || /[ \t]$/.test(clean)) next = next.replace(/^[ \t]+/, '')
    clean += next
  }

  TAG_PATTERN.lastIndex = 0
  for (let match = TAG_PATTERN.exec(text); match !== null; match = TAG_PATTERN.exec(text)) {
    append(text.slice(lastIndex, match.index))
    lastIndex = match.index + match[0].length

    const token = match[1]?.toLowerCase()
    const optional = match[2] === '?'
    if (GESTURE_NAMES.includes(token)) {
      cues.push({ kind: 'gesture', name: token, charIndex: clean.length, optional })
    } else if (EXPRESSION_NAMES.includes(token)) {
      cues.push({ kind: 'expression', name: token, charIndex: clean.length })
    } else {
      append(match[0])
    }
  }
  append(text.slice(lastIndex))

  clean = clean.replace(/[ \t]+$/, '')
  for (const cue of cues) cue.charIndex = Math.min(cue.charIndex, clean.length)
  return { clean, cues }
}

/**
 * Cheap staleness key: re-bake when the words or the recording changed.
 *
 * Shared by every bake step so they all go stale together — an answer whose
 * gestures were re-timed but whose mouth was not is a worse state than either
 * being out of date.
 */
export const stampOf = (answer, bytes) => `${answer.length}:${bytes}`
