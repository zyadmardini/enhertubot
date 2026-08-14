/** Domain vocabulary shared by every module. No vendor types leak in here. */

export type ConversationState = 'idle' | 'listening' | 'thinking' | 'speaking'

/**
 * Tags the answer text may carry inline. Parsed out before text reaches TTS.
 *
 * On the cached path these are authored by hand in the manifest and baked to
 * exact audio times offline; on a live route they are what the LLM is prompted
 * to emit. Same vocabulary either way, so the two paths never diverge.
 */
export type GestureName =
  | 'wave'
  | 'bye'
  | 'point'
  | 'present'
  | 'shrug'
  | 'nod'
  | 'shake'
  | 'think'

export const GESTURE_NAMES: readonly GestureName[] = [
  'wave',
  'bye',
  'point',
  'present',
  'shrug',
  'nod',
  'shake',
  'think',
]

/**
 * Expression tags, on the same inline channel as gestures.
 *
 * Separate from `ConversationState`'s implied expression: state says *what
 * Enubot is doing*, this says *how the sentence is meant*. A tagged expression
 * holds for the rest of the utterance and then falls back to the state default,
 * which is what stops a delighted face surviving into the next visitor's turn.
 */
export type ExpressionName = 'happy' | 'confused' | 'surprised' | 'sorry'

export const EXPRESSION_NAMES: readonly ExpressionName[] = [
  'happy',
  'confused',
  'surprised',
  'sorry',
]

/**
 * Animation clip names embedded in the GLB.
 *
 * Two tiers, and the split is load-bearing. `REQUIRED_CLIPS` is the contract
 * with the 3D artist — `scripts/validate-glb.mjs` fails the export if one is
 * missing, because the app cannot stand up without them. `OPTIONAL_CLIPS` are
 * the variants that make repetition invisible; a rig without them animates
 * correctly and just repeats itself more, so they can land export by export
 * instead of holding up a delivery.
 */
export type ClipName = RequiredClip | OptionalClip

export type RequiredClip =
  | 'idle'
  | 'breathe'
  | 'greeting_wave'
  | 'talk_a'
  | 'talk_b'
  | 'talk_c'
  | 'thinking'
  | 'nod'

export type OptionalClip =
  | 'idle_look_around'
  | 'goodbye_wave'
  | 'point_front'
  | 'point_side'
  | 'present'
  | 'shrug'
  | 'shake'
  | 'nod_slow'
  | 'thinking_chin'
  | 'celebrate'

export const REQUIRED_CLIPS: readonly RequiredClip[] = [
  'idle',
  'breathe',
  'greeting_wave',
  'talk_a',
  'talk_b',
  'talk_c',
  'thinking',
  'nod',
]

export const OPTIONAL_CLIPS: readonly OptionalClip[] = [
  'idle_look_around',
  'goodbye_wave',
  'point_front',
  'point_side',
  'present',
  'shrug',
  'shake',
  'nod_slow',
  'thinking_chin',
  'celebrate',
]

/**
 * Candidate clips per gesture, in preference order.
 *
 * The picker keeps only those the loaded rig actually has and chooses among
 * them, so a richer export gets more variety with no code change. Order matters
 * where the list mixes tiers: the purpose-built clip comes first and the generic
 * talking clip trails as neutral filler.
 *
 * `shake` deliberately lists nothing else. Every other gesture has a substitute
 * that is merely bland, but the substitute for a head shake is a head nod —
 * standing still is better than answering "no" with "yes".
 */
export const GESTURE_CLIPS: Record<GestureName, readonly ClipName[]> = {
  wave: ['greeting_wave'],
  bye: ['goodbye_wave', 'greeting_wave'],
  point: ['point_front', 'point_side', 'talk_a'],
  present: ['present', 'talk_a'],
  shrug: ['shrug', 'talk_c'],
  nod: ['nod', 'nod_slow'],
  shake: ['shake'],
  think: ['thinking', 'thinking_chin'],
}

/**
 * Candidate idle clips per conversation state, same picking rules.
 *
 * `speaking` lists all three talking clips rather than pinning `talk_b`: the
 * base loop under an answer is the single most-seen animation in the booth, and
 * the same one every time is what makes a kiosk read as a video rather than a
 * character.
 */
export const STATE_CLIPS: Record<ConversationState, readonly ClipName[]> = {
  idle: ['idle', 'idle_look_around'],
  listening: ['idle'],
  thinking: ['thinking', 'thinking_chin'],
  speaking: ['talk_b', 'talk_a', 'talk_c'],
}

export type Expression =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'happy'
  | 'confused'
  | 'surprised'
  | 'sorry'

export const STATE_EXPRESSIONS: Record<ConversationState, Expression> = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'talking',
}

/** Inline expression tags map straight through; the names were chosen to. */
export const TAG_EXPRESSIONS: Record<ExpressionName, Expression> = {
  happy: 'happy',
  confused: 'confused',
  surprised: 'surprised',
  sorry: 'sorry',
}
