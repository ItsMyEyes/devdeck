import { describe, expect, it } from 'vitest'
import {
  changedFileName,
  changedFileScope,
  changedFilesOf,
  previewFiles,
  summarizeScopes,
} from '@/features/agent-chat/changedFiles'
import type { ChatItem } from '@/features/agent-chat/types'

function tool(p: Partial<ChatItem>): ChatItem {
  return {
    id: `t-${Math.abs(JSON.stringify(p).length)}-${p.toolName}-${JSON.stringify(p.input)}`,
    kind: 'tool',
    text: '',
    status: 'done',
    createdAt: 1,
    updatedAt: 1,
    lastSequence: 0,
    ...p,
  } as ChatItem
}

describe('changedFilesOf', () => {
  it('collects the file each writing tool targeted, in first-touched order', () => {
    const files = changedFilesOf([
      tool({ toolName: 'Write', input: { file_path: 'scripts/migrate.sh' } }),
      tool({ toolName: 'Edit', input: { file_path: '.gitignore' } }),
    ])
    expect(files.map((f) => f.path)).toEqual(['scripts/migrate.sh', '.gitignore'])
    expect(files[0].tool).toBe('Write')
  })

  // The trap this list exists to avoid: Read/Grep/Bash all carry a
  // file_path/path argument, so keying off "has a path" would report every file
  // the agent merely LOOKED at as changed.
  it('ignores tools that only read', () => {
    const files = changedFilesOf([
      tool({ toolName: 'Read', input: { file_path: 'src/app.ts' } }),
      tool({ toolName: 'Grep', input: { path: 'src', pattern: 'foo' } }),
      tool({ toolName: 'Glob', input: { path: 'src' } }),
      tool({ toolName: 'Bash', input: { command: 'ls', path: '/tmp' } }),
    ])
    expect(files).toEqual([])
  })

  // A failed write did not write. Listing it would send the operator to review
  // a file that never changed, which is the one error this card cannot afford.
  it('counts only calls that actually completed', () => {
    const files = changedFilesOf([
      tool({ toolName: 'Write', status: 'failed', input: { file_path: 'a.txt' } }),
      tool({ toolName: 'Write', status: 'running', input: { file_path: 'b.txt' } }),
      tool({ toolName: 'Write', status: 'done', input: { file_path: 'c.txt' } }),
    ])
    expect(files.map((f) => f.path)).toEqual(['c.txt'])
  })

  it('counts a file edited four times as one file', () => {
    const files = changedFilesOf([
      tool({ toolName: 'Edit', input: { file_path: 'a.ts' } }),
      tool({ toolName: 'Edit', input: { file_path: 'a.ts' } }),
      tool({ toolName: 'Write', input: { file_path: 'a.ts' } }),
    ])
    expect(files).toHaveLength(1)
    // The FIRST toucher is kept — the chip answers "which step started this".
    expect(files[0].tool).toBe('Edit')
  })

  // The same capability is spelled differently per provider, and DevDeck's own
  // SSH tool layer adds a third spelling.
  it('recognises the provider spellings of the same capability', () => {
    const files = changedFilesOf([
      tool({ toolName: 'WriteFile', input: { path: '/etc/nginx/nginx.conf' } }),
      tool({ toolName: 'write_file', input: { path: '/etc/hosts' } }),
      tool({ toolName: 'str_replace_editor', input: { path: '/opt/app.py' } }),
      tool({ toolName: 'NotebookEdit', input: { notebook_path: 'a.ipynb' } }),
    ])
    expect(files.map((f) => f.path)).toEqual([
      '/etc/nginx/nginx.conf',
      '/etc/hosts',
      '/opt/app.py',
      'a.ipynb',
    ])
  })

  it('skips a writing call whose arguments carry no path at all', () => {
    expect(changedFilesOf([tool({ toolName: 'Write', input: { content: 'x' } })])).toEqual([])
    expect(changedFilesOf([tool({ toolName: 'Write' })])).toEqual([])
    expect(changedFilesOf([tool({ toolName: 'Write', input: { file_path: '   ' } })])).toEqual([])
  })

  it('ignores everything that is not a tool item', () => {
    expect(
      changedFilesOf([
        { id: 'u', kind: 'user', text: 'go', createdAt: 1, updatedAt: 1, lastSequence: 0 },
        { id: 'a', kind: 'assistant', text: 'done', createdAt: 1, updatedAt: 1, lastSequence: 0 },
      ]),
    ).toEqual([])
  })
})

describe('changedFileName / changedFileScope', () => {
  it('splits a POSIX path', () => {
    expect(changedFileName('scripts/db/migrate.sh')).toBe('migrate.sh')
    expect(changedFileScope('scripts/db/migrate.sh')).toBe('scripts/db')
  })

  // An SSH thread reports POSIX paths and a Windows worktree reports
  // backslashes; both reach the same card.
  it('splits a Windows path', () => {
    expect(changedFileName('src\\app\\main.ts')).toBe('main.ts')
    expect(changedFileScope('src\\app\\main.ts')).toBe('src\\app')
  })

  it('treats a bare filename as living at the root', () => {
    expect(changedFileName('.gitignore')).toBe('.gitignore')
    expect(changedFileScope('.gitignore')).toBe('')
  })

  // An absolute path's leading slash is not a directory named ''.
  it('does not mistake a leading slash for a scope', () => {
    expect(changedFileScope('/etc/hosts')).toBe('/etc')
    expect(changedFileName('/etc/hosts')).toBe('hosts')
  })
})

describe('summarizeScopes', () => {
  it('counts files per directory, busiest first', () => {
    const files = changedFilesOf([
      tool({ toolName: 'Write', input: { file_path: 'scripts/a.sh' } }),
      tool({ toolName: 'Write', input: { file_path: 'scripts/b.sh' } }),
      tool({ toolName: 'Write', input: { file_path: '.gitignore' } }),
    ])
    expect(summarizeScopes(files)).toEqual([
      { label: 'scripts', fileCount: 2 },
      { label: 'root', fileCount: 1 },
    ])
  })

  // This renders on every settled turn; a summary that reshuffles between
  // renders reads as the file list itself changing.
  it('breaks a count tie by label, so the order is stable', () => {
    const files = changedFilesOf([
      tool({ toolName: 'Write', input: { file_path: 'z/one.ts' } }),
      tool({ toolName: 'Write', input: { file_path: 'a/two.ts' } }),
    ])
    expect(summarizeScopes(files).map((s) => s.label)).toEqual(['a', 'z'])
  })
})

describe('previewFiles', () => {
  it('stops at the preview limit and leaves the rest to Show all', () => {
    const files = changedFilesOf(
      ['a', 'b', 'c', 'd', 'e'].map((n) => tool({ toolName: 'Write', input: { file_path: `${n}.ts` } })),
    )
    expect(previewFiles(files).map((f) => f.path)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('returns everything when there is less than a full row', () => {
    const files = changedFilesOf([tool({ toolName: 'Write', input: { file_path: 'a.ts' } })])
    expect(previewFiles(files)).toHaveLength(1)
  })
})
