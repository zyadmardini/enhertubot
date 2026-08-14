import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback: ReactNode
}

interface State {
  failed: boolean
}

/**
 * Catches a failed GLB load and shows the placeholder instead.
 *
 * A bad or missing model must never take the scene down. On event day the
 * difference between a stylised stand-in robot and a black screen is the
 * difference between a booth that works and one that doesn't.
 */
export class ModelBoundary extends Component<Props, State> {
  state: State = { failed: false }

  static getDerivedStateFromError(): State {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[enubot] Character model failed to load — using the placeholder.', error, info)
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
