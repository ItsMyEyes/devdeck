import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Machine } from '@/store/types'
import { useDevDeckStore } from '@/store/useDevDeckStore'
import { GitPanel } from './GitPanel'
import { gitDiffLabel } from './GitDiffPane'
import { createGitDiffContent, gitDiffTargetKey } from './paneTree'

// The panel's data all comes from react-query hooks that hit a live machine —
// stub them so these tests only exercise GitPanel's own layout and selection
// behaviour. Only `useGitStatus` needs real-looking data.
const status = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  files: [{ path: 'src/root.go', index: '.', worktree: 'M' }],
}

// A deliberately long subject and ref list — the shapes that used to spill
// past the sidebar's right edge.
const log = [
  {
    hash: '9637461cefce3f447f25bd2dbcde866ebe2b4870',
    short: '9637461',
    subject: 'feat: add the thing',
    author: 'itsmyeyes',
    date: '2026-08-02T00:42:34+07:00',
    refs: ['HEAD -> master-production', 'origin/master-production'],
  },
]

vi.mock('@/features/data/queries', () => {
  const idle = { data: undefined, isLoading: false, error: null, isFetching: false, refetch: vi.fn() }
  const mutation = { mutate: vi.fn(), isPending: false }
  return {
    useGitStatus: () => ({ ...idle, data: status }),
    useGitLog: () => ({ ...idle, data: log }),
    useGitDiff: () => ({ ...idle, data: { diff: 'diff --git a/x b/x' } }),
    useGitStage: () => mutation,
    useGitUnstage: () => mutation,
    useGitDiscard: () => mutation,
    useGitCommit: () => mutation,
    useGitPush: () => mutation,
    useGitPull: () => mutation,
  }
})

const machine: Machine = {
  id: 'm1',
  name: 'Machine One',
  url: 'https://m1.example',
  key: 'k',
  isLocal: false,
  signingPublicKey: '',
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const baseProps = { worktreeId: 'wt-1', machine, active: true, shellKey: 'wt:wt-1' }

afterEach(() => {
  cleanup()
  useDevDeckStore.setState({ gitDiffs: {} })
})

beforeEach(() => {
  useDevDeckStore.setState({ gitDiffs: {} })
})

describe('GitPanel compact mode', () => {
  // The regression this guards: GitPanel is a two-column component whose file
  // list alone is a fixed 300px. Rendered whole inside the ~280px shell
  // sidebar it overflowed its container and pushed the terminal off-screen.
  it('renders no diff column, so nothing exceeds the sidebar width', () => {
    render(<GitPanel {...baseProps} compact />, { wrapper })

    expect(screen.queryByText('Select a file to view its diff')).toBeNull()
    // The fixed-width list is what overflowed — compact must not use it.
    expect(document.querySelector('.md\\:w-\\[300px\\]')).toBeNull()
  })

  it('renders the diff column when not compact', () => {
    render(<GitPanel {...baseProps} />, { wrapper })

    expect(screen.getByText('Select a file to view its diff')).toBeInTheDocument()
  })

  // The diff opens as its own per-file tab, so the target has to travel with
  // the callback — a bare "reveal the Git tab" would show the wrong file.
  it('hands the picked target to the host so it can open that file as a tab', () => {
    const onOpenDiff = vi.fn()
    render(<GitPanel {...baseProps} compact onOpenDiff={onOpenDiff} />, { wrapper })

    fireEvent.click(screen.getByText('root.go'))

    const picked = { path: 'src/root.go', staged: false, untracked: false }
    expect(onOpenDiff).toHaveBeenCalledTimes(1)
    expect(onOpenDiff).toHaveBeenCalledWith(picked)
    // Still recorded for the list's own selection highlight.
    expect(useDevDeckStore.getState().gitDiffs['wt:wt-1']).toEqual(picked)
  })

  it('does not call onOpenDiff when it owns a diff column of its own', () => {
    const onOpenDiff = vi.fn()
    render(<GitPanel {...baseProps} onOpenDiff={onOpenDiff} />, { wrapper })

    fireEvent.click(screen.getByText('root.go'))

    expect(onOpenDiff).not.toHaveBeenCalled()
  })

  // The two copies share one selection through the store, which is what lets a
  // sidebar click drive the in-pane tab's diff.
  it('reads its selection from the store, so both copies stay in sync', () => {
    useDevDeckStore.setState({ gitDiffs: { 'wt:wt-1': { path: 'src/root.go', staged: false, untracked: false } } })
    render(<GitPanel {...baseProps} />, { wrapper })

    expect(screen.queryByText('Select a file to view its diff')).toBeNull()
    expect(screen.getByTitle('Side-by-side diff')).toBeInTheDocument()
  })
})

describe('GitPanel narrow-width layout', () => {
  // Push sat at the end of a row that could not shrink, so at sidebar width it
  // was pushed past the panel's right edge and became unclickable.
  it('keeps Pull and Push reachable in compact mode', () => {
    render(<GitPanel {...baseProps} compact />, { wrapper })

    const push = screen.getByRole('button', { name: 'Push' })
    const pull = screen.getByRole('button', { name: 'Pull' })
    // flex-none is what stops the row's toolbar from squeezing them away.
    expect(push.className).toContain('flex-none')
    expect(pull.className).toContain('flex-none')
    // Icon-only: the labels are what overflowed the row.
    expect(push.textContent).toBe('')
    expect(push).toHaveAttribute('title', 'git push')
  })

  it('keeps the labels in the full-width panel', () => {
    render(<GitPanel {...baseProps} />, { wrapper })

    expect(screen.getByRole('button', { name: 'Push' }).textContent).toBe('Push')
  })

  // A flex item defaults to min-width:auto and refuses to shrink below its
  // content, so `truncate` alone did nothing and long paths spilled out.
  // `truncate` on a leaf does nothing unless EVERY flex ancestor between it
  // and the fixed-width sidebar is also allowed to shrink — one ancestor left
  // at the default min-width:auto pins the whole row open and the text spills.
  it('lets every ancestor of the commit text shrink, not just the text itself', () => {
    const { container } = render(<GitPanel {...baseProps} compact />, { wrapper })
    fireEvent.click(screen.getByRole('button', { name: /History/ }))

    const subject = screen.getByText('feat: add the thing')
    expect(subject.className).toContain('truncate')

    const root = container.firstElementChild as HTMLElement
    for (let node = subject.parentElement; node && node !== root.parentElement; node = node.parentElement) {
      if (node.className.includes('flex-1') || node.className.includes('flex ')) {
        expect(node.className).toContain('min-w-0')
      }
    }
  })

  it('lets a long file path shrink rather than overflow', () => {
    render(<GitPanel {...baseProps} compact />, { wrapper })

    // status fixture path is 'src/root.go', so the dirname element exists.
    const dir = screen.getByText('src')
    expect(dir.className).toContain('min-w-0')
    expect(dir.className).toContain('truncate')
    // Its row must be allowed to shrink too, or the child's min-w-0 is moot.
    expect(screen.getByText('root.go').closest('button')?.className).toContain('min-w-0')
  })
})

describe('git diff pane tabs', () => {
  // Ids are the target key, which is what makes re-picking the same file
  // refocus its tab instead of stacking a second copy of it.
  it('gives one tab per target and reuses the id for the same target', () => {
    const a = createGitDiffContent({ path: 'src/root.go', staged: false, untracked: false }, 'root.go')
    const again = createGitDiffContent({ path: 'src/root.go', staged: false, untracked: false }, 'root.go')
    const staged = createGitDiffContent({ path: 'src/root.go', staged: true, untracked: false }, 'root.go')
    const other = createGitDiffContent({ path: 'src/main.go', staged: false, untracked: false }, 'main.go')
    const commit = createGitDiffContent({ commit: 'c8e145cb4b' }, 'c8e145cb4b')

    expect(a.id).toBe(again.id)
    // Staged vs unstaged are genuinely different diffs of one path.
    expect(a.id).not.toBe(staged.id)
    expect(a.id).not.toBe(other.id)
    expect(commit.id).toBe(gitDiffTargetKey({ commit: 'c8e145cb4b' }))
    expect(a.kind).toBe('git-diff')
    expect(a.label).toBe('root.go')
  })

  it('labels a file target by basename and a commit by short hash', () => {
    expect(gitDiffLabel({ path: 'internal/api/usecase.go', staged: false, untracked: false })).toBe('usecase.go')
    expect(gitDiffLabel({ commit: 'c8e145cb4b7db04f204c2f223bb1ba01e2b29947' })).toBe('c8e145cb4b')
  })
})
