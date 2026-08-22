import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/**
 * The app's single root error boundary.
 *
 * DevDeck had none, which is why a render-phase crash — most notably React
 * error #185 ("Maximum update depth exceeded", an unintended setState loop) —
 * took the WHOLE tree down to a blank window with only a minified message in
 * the console and no way to tell WHICH component looped. A minified stack
 * names nothing, so the culprit was invisible in production.
 *
 * Two jobs:
 *
 *  1. Recover instead of white-screening. A render crash that React 19's own
 *     concurrent recovery could not absorb (it retries the render synchronously
 *     first; a genuinely persistent loop survives that) lands here and gets a
 *     panel with "Try again" and a reload, rather than a dead window.
 *
 *  2. Make the crash self-diagnosing. `componentDidCatch` logs
 *     `errorInfo.componentStack`, which lists the component hierarchy the error
 *     came from. Those are real component NAMES (esbuild keeps top-level
 *     function names, React reads `displayName`/`Function.name`), so even in the
 *     minified build the log points straight at the looping component — the one
 *     piece a bare "#185" never gave up.
 */
interface State {
  error: Error | null
  componentStack: string | null
}

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The line that turns a minified "#185" into a location. A single grouped
    // console.error so it is copy-pasteable straight out of the desktop app's
    // Web Inspector.
    // eslint-disable-next-line no-console
    console.error(
      `[DevDeck] uncaught render error: ${error.message}\ncomponent stack:${info.componentStack ?? ' (none)'}`,
      error,
    )
    this.setState({ componentStack: info.componentStack ?? null })
  }

  private reset = () => this.setState({ error: null, componentStack: null })

  render(): ReactNode {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    // The topmost frame of the component stack — usually the looping component.
    const topFrame = componentStack?.trim().split('\n')[0]?.trim()

    return (
      <div className="flex min-h-screen w-full flex-col items-center justify-center gap-4 bg-devdeck-base px-6 text-center">
        <div className="flex max-w-lg flex-col items-center gap-3">
          <h1 className="text-sm font-medium text-devdeck-fg">Something in the interface crashed</h1>
          <p className="font-mono text-[11px] leading-relaxed break-words text-devdeck-fg-2">{error.message}</p>
          {topFrame ? <p className="font-mono text-[10.5px] text-devdeck-dim-pane">in {topFrame}</p> : null}
          <p className="text-[11px] text-devdeck-fg-2">
            The full component stack was written to the console. Copy it here to pinpoint the cause.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={this.reset}
            className="rounded border border-devdeck-border-strong bg-devdeck-glass-solid px-3 py-1.5 text-[11px] text-devdeck-fg hover:border-devdeck-line"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded px-3 py-1.5 text-[11px] text-devdeck-fg-2 hover:text-devdeck-fg"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
