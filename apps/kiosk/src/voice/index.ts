import type { DriverId } from '../../enubot.config.ts'
import type { ConversationDriver, DriverDeps } from './types.ts'
import { CachedDriver } from './adapters/cached.ts'
import { MockDriver } from './adapters/mock.ts'
import { ElevenLabsAgentsDriver } from './adapters/elevenlabs-agents.ts'
import { AssembledDriver } from './adapters/assembled.ts'

/** The only place a driver adapter is named. Everything else takes the port. */
export function createDriver(id: DriverId, deps: DriverDeps): ConversationDriver {
  switch (id) {
    case 'cached':
      return new CachedDriver(deps)
    case 'mock':
      return new MockDriver(deps)
    case 'elevenlabs-agents':
      return new ElevenLabsAgentsDriver(deps)
    case 'assembled':
      return new AssembledDriver(deps)
  }
}

export type {
  CannedAnswer,
  CannedAnswerBank,
  ConversationDriver,
  DriverDeps,
  DriverEvent,
} from './types.ts'
export { hasCannedAnswers } from './types.ts'
