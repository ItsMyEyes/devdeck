import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChangedFilesCard } from '@/features/agent-chat/ChangedFilesCard'
import type { ChangedFile } from '@/features/agent-chat/changedFiles'

afterEach(() => cleanup())

const file = (path: string, tool = 'Write'): ChangedFile => ({ path, tool })

const three = [
  file('scripts/migrate-mysql-table-to-postgres.sh'),
  file('scripts/.env.migration.example'),
  file('.gitignore', 'Edit'),
]

describe('ChangedFilesCard', () => {
  it('renders nothing when the turn changed no files', () => {
    const { container } = render(<ChangedFilesCard files={[]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('counts the files and summarises them by directory', () => {
    render(<ChangedFilesCard files={three} />)
    expect(screen.getByText('3 changed files')).toBeInTheDocument()
    expect(screen.getByText('scripts')).toBeInTheDocument()
    expect(screen.getByText('2 files')).toBeInTheDocument()
    expect(screen.getByText('root')).toBeInTheDocument()
    expect(screen.getByText('1 file')).toBeInTheDocument()
  })

  it('singularises a one-file turn', () => {
    render(<ChangedFilesCard files={[file('a.ts')]} />)
    expect(screen.getByText('1 changed file')).toBeInTheDocument()
  })

  // The chip shows a basename; the full path and the tool that wrote it are
  // the two questions that leaves, so they ride on the title.
  it('shows each file by name, with its path and tool on the tooltip', () => {
    render(<ChangedFilesCard files={three} />)
    const chip = screen.getByTitle('scripts/migrate-mysql-table-to-postgres.sh · Write')
    expect(chip).toHaveTextContent('migrate-mysql-table-to-postgres.sh')
    expect(screen.getByTitle('.gitignore · Edit')).toBeInTheDocument()
  })

  it('stops at the preview limit and offers the rest', async () => {
    const many = ['a', 'b', 'c', 'd', 'e'].map((n) => file(`src/${n}.ts`))
    render(<ChangedFilesCard files={many} />)

    expect(screen.queryByText('d.ts')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show all 5 files' }))
    expect(screen.getByText('d.ts')).toBeInTheDocument()
    expect(screen.getByText('e.ts')).toBeInTheDocument()
  })

  it('expands and collapses from the header', async () => {
    const many = ['a', 'b', 'c', 'd'].map((n) => file(`src/${n}.ts`))
    render(<ChangedFilesCard files={many} />)

    const header = screen.getByRole('button', { name: /4 changed files/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('Show files')).toBeInTheDocument()

    await userEvent.click(header)
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Hide files')).toBeInTheDocument()
    expect(screen.getByText('d.ts')).toBeInTheDocument()

    await userEvent.click(header)
    expect(screen.queryByText('d.ts')).not.toBeInTheDocument()
  })

  it('opens a file when the caller can', async () => {
    const onOpenFile = vi.fn()
    render(<ChangedFilesCard files={three} onOpenFile={onOpenFile} />)

    await userEvent.click(screen.getByTitle('.gitignore · Edit'))
    expect(onOpenFile).toHaveBeenCalledWith('.gitignore')
  })

  // An SSH thread's paths live on a remote host DevDeck has no editor for, so
  // there is nowhere to open them. A chip that looks clickable and does nothing
  // is worse than a plain label.
  it('renders the chips as labels, not buttons, when there is nowhere to open a file', () => {
    render(<ChangedFilesCard files={three} />)
    // Only the disclosure header is a button.
    expect(screen.getAllByRole('button')).toHaveLength(1)
    expect(screen.getByTitle('.gitignore · Edit').tagName).toBe('SPAN')
  })
})
