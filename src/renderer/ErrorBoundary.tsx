import React from 'react'

/**
 * Last line of defence for the launcher.
 *
 * An uncaught error during render unmounts the React root, and nothing
 * remounts it: the window stays alive but empty, reports zero hit rects to the
 * shell so every click passes straight through, and re-summoning shows the same
 * blank surface. From the outside the app has simply vanished and will not come
 * back — which is exactly what a single `undefined.substring()` in the history
 * picker did.
 *
 * A boundary turns that into a visible, recoverable error. Deliberately built
 * from plain inline styles and no store or theme access: whatever broke may be
 * the very thing this needs to render.
 */
interface Props {
  children: React.ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The GUI subsystem has no console, so put it where spike.log can be read.
    const where = (info.componentStack || '').split('\n').slice(0, 4).join(' | ').trim()
    try {
      window.clui?.traceShell?.(`[renderer] boundary caught: ${error.message} @ ${where}`)
    } catch {
      // Bridge unavailable — the on-screen message is still the point.
    }
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          alignItems: 'center',
          padding: 24,
          fontFamily: "-apple-system, 'Segoe UI', system-ui, sans-serif",
        }}
      >
        {/*
          data-clui-ui goes on the card, never the full-height wrapper: the
          shim publishes the bounding box of every marked element as a
          click-through exclusion rect, so marking the wrapper would turn the
          whole transparent window opaque to the mouse.
        */}
        <div
          data-clui-ui
          style={{
            width: 'min(560px, 100%)',
            borderRadius: 16,
            padding: '14px 16px',
            background: 'rgba(28, 28, 26, 0.96)',
            border: '1px solid rgba(196, 112, 96, 0.5)',
            boxShadow: '0 12px 40px rgba(0, 0, 0, 0.45)',
            color: '#e8e6df',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
            OpenClaw UI hit an error
          </div>
          <div
            style={{
              fontSize: 11,
              lineHeight: 1.5,
              color: '#c0bdb2',
              fontFamily: 'ui-monospace, monospace',
              maxHeight: 120,
              overflow: 'auto',
              marginBottom: 10,
              wordBreak: 'break-word',
            }}
          >
            {error.message || String(error)}
          </div>
          <button
            onClick={this.handleReload}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: '5px 12px',
              borderRadius: 8,
              border: '1px solid rgba(226, 74, 74, 0.5)',
              background: 'rgba(226, 74, 74, 0.14)',
              color: '#e24a4a',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}
