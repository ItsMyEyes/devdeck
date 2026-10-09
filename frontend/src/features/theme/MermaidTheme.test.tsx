import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MermaidDiagram } from '@/features/rich-editor/MermaidDiagram'
import { setThemePreference } from '@/features/theme/theme'

// Mermaid's SVG measurement needs a browser layout engine. Keep the component
// and theme subscriptions real, and substitute just that rendering boundary.
vi.mock('mermaid', () => {
  let theme = ''
  return { default: {
    initialize: (options: { theme: string }) => { theme = options.theme },
    render: async () => ({ svg: `<svg><text>${theme} diagram</text></svg>` }),
  } }
})
beforeEach(() => setThemePreference('dark'))
afterEach(cleanup)

it('repaints an open diagram when the workspace theme changes', async () => {
  render(<MermaidDiagram chart="graph TD; A-->B" />)
  expect(await screen.findByText('dark diagram')).toBeInTheDocument()
  act(() => setThemePreference('light'))
  expect(await screen.findByText('default diagram')).toBeInTheDocument()
})
