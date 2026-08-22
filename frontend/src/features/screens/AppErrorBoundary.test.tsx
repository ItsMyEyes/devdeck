import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { ReactElement } from 'react'
import { AppErrorBoundary } from './AppErrorBoundary'

afterEach(cleanup)

function Boom({ label }: { label: string }): ReactElement {
  throw new Error(`boom in ${label}`)
}

describe('AppErrorBoundary', () => {
  it('renders children when nothing throws', () => {
    render(<AppErrorBoundary><div>ok content</div></AppErrorBoundary>)
    expect(screen.getByText('ok content')).toBeInTheDocument()
  })

  it('catches a render crash, shows recovery UI, and logs the component stack naming the culprit', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<AppErrorBoundary><Boom label="WidgetX" /></AppErrorBoundary>)

    // Recovered instead of a blank tree.
    expect(screen.getByText(/something in the interface crashed/i)).toBeInTheDocument()
    expect(screen.getByText(/boom in WidgetX/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()

    // The diagnostic: a logged component stack that NAMES the culprit.
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toMatch(/component stack:/)
    expect(logged).toMatch(/Boom/) // the component that threw, by name
    spy.mockRestore()
  })
})
