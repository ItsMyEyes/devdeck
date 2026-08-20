/**
 * Plan T8 — `ProposedPlanCard`, ported from
 * `gg/t3code/apps/web/src/components/chat/ProposedPlanCard.tsx:148-205`
 * (design spec §6) onto this repo's own component set (`Pill`,
 * `TabStripPopoverMenu`, `Dialog`, `sonner`'s `toast`, `MessageResponse`).
 *
 * `writeWorktreeFile` is mocked at the module boundary — same technique
 * `ComposerPromptEditor.test.tsx` uses for `searchWorktreeFiles` — so "Save
 * to workspace" is tested as a real call into `@/lib/machineApi`'s typed
 * helper, not a stand-in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import type { Machine } from '@/store/types'
import { writeWorktreeFile } from '@/lib/machineApi'
import { ProposedPlanCard } from '@/features/agent-chat/ProposedPlanCard'

vi.mock('@/lib/machineApi', () => ({
  writeWorktreeFile: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

const writeWorktreeFileMock = vi.mocked(writeWorktreeFile)

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  writeWorktreeFileMock.mockReset()
})

const MACHINE: Machine = {
  id: 'machine-1',
  name: 'local',
  url: 'http://localhost:8989',
  key: 'test-key',
  isLocal: true,
  signingPublicKey: 'pub',
}

const SHORT_PLAN = '# Ship the widget\n\n## Summary\n\n- Wire the endpoint\n- Add a test'

const LONG_PLAN = [
  '# Ship the widget',
  '',
  ...Array.from({ length: 25 }, (_, i) => `- Step ${i + 1}`),
].join('\n')

async function openPlanActionsMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Plan actions' }))
  return user
}

describe('ProposedPlanCard — collapse', () => {
  it('renders collapsed with only a preview when the markdown exceeds the threshold, and expands on click', async () => {
    const user = userEvent.setup()
    render(<ProposedPlanCard markdown={LONG_PLAN} />)

    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.queryByText('Step 21')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Expand plan' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Expand plan' }))

    expect(screen.getByText('Step 21')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Collapse plan' })).toBeInTheDocument()
  })

  it('renders fully expanded with no expand control when the markdown is under both thresholds', () => {
    render(<ProposedPlanCard markdown={SHORT_PLAN} />)

    expect(screen.getByText('Wire the endpoint')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Expand plan' })).not.toBeInTheDocument()
  })

  it('shows the plan title from the first heading', () => {
    render(<ProposedPlanCard markdown={SHORT_PLAN} />)
    expect(screen.getByText('Ship the widget')).toBeInTheDocument()
  })

  it('falls back to "Proposed plan" when the markdown has no heading', () => {
    render(<ProposedPlanCard markdown="- just a list item" />)
    expect(screen.getByText('Proposed plan')).toBeInTheDocument()
  })
})

describe('ProposedPlanCard — actions menu', () => {
  it('Copy calls the clipboard with the normalized plan markdown', async () => {
    const user = userEvent.setup()
    render(<ProposedPlanCard markdown={SHORT_PLAN} />)

    await user.click(screen.getByRole('button', { name: 'Plan actions' }))
    await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }))

    await expect(window.navigator.clipboard.readText()).resolves.toBe(`${SHORT_PLAN}\n`)
  })

  it('Download triggers a file save named via buildProposedPlanMarkdownFilename', async () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:plan'), revokeObjectURL: vi.fn() })
    const downloadedNames: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloadedNames.push(this.download)
    })

    const user = userEvent.setup()
    render(<ProposedPlanCard markdown={SHORT_PLAN} />)

    await user.click(screen.getByRole('button', { name: 'Plan actions' }))
    await user.click(screen.getByRole('button', { name: 'Download as markdown' }))

    // Saving is async now — it goes through @/lib/saveFile, which awaits the
    // OS save dialog where one exists before it ever reaches this anchor
    // fallback (jsdom has neither the picker nor Tauri's IPC).
    await waitFor(() => expect(downloadedNames).toEqual(['ship-the-widget.md']))
  })

  it('Save to workspace calls writeWorktreeFile(machine, worktreeId, {path, content})', async () => {
    writeWorktreeFileMock.mockResolvedValue({ path: 'ship-the-widget.md', content: `${SHORT_PLAN}\n` })
    const user = userEvent.setup()
    render(<ProposedPlanCard markdown={SHORT_PLAN} machine={MACHINE} worktreeId="wt-1" />)

    await user.click(screen.getByRole('button', { name: 'Plan actions' }))
    await user.click(screen.getByRole('button', { name: 'Save to workspace' }))

    expect(screen.getByText('Save plan to workspace')).toBeInTheDocument()
    const input = screen.getByLabelText('Workspace path')
    expect(input).toHaveValue('ship-the-widget.md')

    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(writeWorktreeFileMock).toHaveBeenCalledWith(MACHINE, 'wt-1', {
      path: 'ship-the-widget.md',
      content: `${SHORT_PLAN}\n`,
    })
  })

  it('Save is disabled when no worktree/machine is available', async () => {
    render(<ProposedPlanCard markdown={SHORT_PLAN} />)
    await openPlanActionsMenu()

    expect(screen.getByRole('button', { name: 'Save to workspace' })).toBeDisabled()
  })

  it('Save is disabled when a machine is given but no worktreeId is', async () => {
    render(<ProposedPlanCard markdown={SHORT_PLAN} machine={MACHINE} />)
    await openPlanActionsMenu()

    expect(screen.getByRole('button', { name: 'Save to workspace' })).toBeDisabled()
  })
})
