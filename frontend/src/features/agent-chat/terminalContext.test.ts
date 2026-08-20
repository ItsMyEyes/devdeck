import { describe, expect, it } from 'vitest'
import { composerTerminalContextChip, composerText, serializeComposerDoc } from '@/features/agent-chat/composerSerialize'
import type { ComposerDoc } from '@/features/agent-chat/composerSerialize'
import { buildTerminalContextBlock, extractTrailingTerminalContexts } from '@/features/agent-chat/terminalContext'

function doc(...content: ComposerDoc['content']): ComposerDoc {
  return { type: 'doc', content }
}

/** Pulls every `terminal:` markdown-link destination out of a serialized
 *  composer message, in document order — the same shape T1 produces. */
function linkDestinations(text: string): string[] {
  return [...text.matchAll(/\]\((terminal:[^)]+)\)/g)].map((match) => match[1]!)
}

describe('buildTerminalContextBlock', () => {
  it('appends a trailing block whose per-entry header is the T1 destination', () => {
    const result = buildTerminalContextBlock('please check this', [
      { destination: 'terminal:sess-7f2a/L12-L40', label: 'Terminal 1 lines 12-40', text: 'npm test\nPASS 12 tests' },
    ])
    expect(result).toBe(
      [
        'please check this',
        '',
        '<terminal_context>',
        '- terminal:sess-7f2a/L12-L40:',
        '  npm test',
        '  PASS 12 tests',
        '</terminal_context>',
      ].join('\n'),
    )
  })

  it('appends one block entry per context, separated and in order', () => {
    const result = buildTerminalContextBlock('two selections', [
      { destination: 'terminal:sess-7f2a/L12-L40', text: 'npm test\nPASS' },
      { destination: 'terminal:sess-9b1c/L1-L5', text: 'ls\nfoo.txt' },
    ])
    expect(result).toBe(
      [
        'two selections',
        '',
        '<terminal_context>',
        '- terminal:sess-7f2a/L12-L40:',
        '  npm test',
        '  PASS',
        '',
        '- terminal:sess-9b1c/L1-L5:',
        '  ls',
        '  foo.txt',
        '</terminal_context>',
      ].join('\n'),
    )
  })

  it('returns the text unchanged when there are no terminal-context chips', () => {
    expect(buildTerminalContextBlock('hello world', [])).toBe('hello world')
  })
})

describe('extractTrailingTerminalContexts', () => {
  it('round-trips a block built by buildTerminalContextBlock back to the same entries', () => {
    const contexts = [
      { destination: 'terminal:sess-7f2a/L12-L40', text: 'npm test\nPASS' },
      { destination: 'terminal:sess-9b1c/L1-L5', text: 'ls\nfoo.txt\n\nbar.txt' },
    ]
    const built = buildTerminalContextBlock('please check', contexts)
    const result = extractTrailingTerminalContexts(built)
    expect(result.contexts).toEqual(contexts)
  })

  it('strips the block from visibleText but keeps it in copyText', () => {
    const built = buildTerminalContextBlock('please check', [
      { destination: 'terminal:sess-7f2a/L12-L40', text: 'npm test\nPASS' },
    ])
    const result = extractTrailingTerminalContexts(built)
    expect(result.visibleText).toBe('please check')
    expect(result.copyText).toBe(built)
    expect(result.copyText).toContain('<terminal_context>')
    expect(result.visibleText).not.toContain('<terminal_context>')
  })

  it('returns the whole text as visibleText/copyText and no contexts when there is no block', () => {
    const result = extractTrailingTerminalContexts('just plain text, no block here')
    expect(result).toEqual({
      visibleText: 'just plain text, no block here',
      copyText: 'just plain text, no block here',
      contexts: [],
    })
  })
})

describe('the join-key property', () => {
  it('every terminal-context link destination in the text has a matching block entry, and vice versa', () => {
    const text = serializeComposerDoc(
      doc(
        composerTerminalContextChip('sess-7f2a/L12-L40', 'Terminal 1 lines 12-40'),
        composerText(' and also '),
        composerTerminalContextChip('sess-9b1c/L1-L5', 'Terminal 2 lines 1-5'),
        composerText(' please'),
      ),
    )
    const destinations = linkDestinations(text)
    expect(destinations).toEqual(['terminal:sess-7f2a/L12-L40', 'terminal:sess-9b1c/L1-L5'])

    const contexts = destinations.map((destination) => ({ destination, text: `output for ${destination}` }))
    const built = buildTerminalContextBlock(text, contexts)
    const { contexts: blockEntries } = extractTrailingTerminalContexts(built)
    const blockDestinations = blockEntries.map((entry) => entry.destination)

    // No destination without a block entry, no block entry without a
    // destination in the text — same set, same count, either direction.
    expect(blockDestinations).toEqual(destinations)
    expect(blockDestinations.every((destination) => destinations.includes(destination))).toBe(true)
    expect(destinations.every((destination) => blockDestinations.includes(destination))).toBe(true)
  })

  it('a message with no terminal-context chips has no destinations and produces no block', () => {
    const text = serializeComposerDoc(doc(composerText('just a plain message')))
    const destinations = linkDestinations(text)
    expect(destinations).toEqual([])
    expect(buildTerminalContextBlock(text, [])).toBe(text)
  })
})
