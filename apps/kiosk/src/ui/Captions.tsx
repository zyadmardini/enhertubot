interface CaptionsProps {
  user: string
  agent: string
}

/**
 * Live captions for both sides of the conversation.
 *
 * Cheap to build off transcript events we already have, and it earns its place
 * three times over: it's the accessibility story for deaf visitors, it's the
 * insurance policy when a noisy hall drowns the speaker, and it's the fastest
 * way to see what Enubot actually heard when an answer goes sideways.
 */
export function Captions({ user, agent }: CaptionsProps) {
  if (!user && !agent) return null
  return (
    <div className="captions" aria-live="polite">
      {user ? <p className="captions__user">“{user}”</p> : null}
      {agent ? <p className="captions__agent">{agent}</p> : null}
    </div>
  )
}
