/**
 * The picker replaced a ghost pill over four hardcoded model ids that never
 * reached the backend. These cover the things that makes it real: the rail is
 * the machine's installed agents, the rows are that agent's actual models, the
 * choice reports which AGENT it belongs to, and search / ⌘N / favourites all
 * act on the rows actually rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Machine } from '@/store/types'

const CLAUDE_MODELS = [
  { id: 'claude-fable-5', name: 'Claude Fable 5', contextWindow: 1_000_000 },
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextWindow: 1_000_000 },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextWindow: 200_000 },
]
const CODEX_MODELS = [{ id: 'gpt-5-codex', name: 'GPT-5 Codex', contextWindow: 400_000 }]

vi.mock('@/features/data/queries', () => ({
  useAgents: () => ({
    data: [
      { id: 'claude', name: 'Claude', installed: true },
      { id: 'codex', name: 'Codex', installed: true },
      { id: 'gemini', name: 'Gemini', installed: false },
    ],
    isLoading: false,
    error: null,
  }),
  useAgentModels: (_machine: unknown, agentId: string | undefined) => ({
    data: agentId === 'codex' ? CODEX_MODELS : CLAUDE_MODELS,
    isLoading: false,
    error: null,
  }),
}))

const { ModelPicker, favouriteKey, instanceIdForAgent } = await import('./ModelPicker')
const { useDevDeckStore } = await import('@/store/useDevDeckStore')

const machine: Machine = { id: 'm1', name: 'dev', url: '', key: '', isLocal: false, signingPublicKey: '' }

beforeEach(() => {
  useDevDeckStore.setState({ favouriteModels: [] })
})

afterEach(() => {
  cleanup()
})

function renderPicker(onChange = vi.fn()) {
  render(<ModelPicker machine={machine} worktreeAgentId="claude" value={null} onChange={onChange} />)
  return onChange
}

async function open() {
  await userEvent.click(screen.getByRole('button', { name: /Model/ }))
  return screen.findByPlaceholderText('Search models…')
}

describe('ModelPicker', () => {
  it('rails only the agents actually installed on the machine', async () => {
    renderPicker()
    await open()

    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()
    // Gemini is in the catalog but not installed — offering it would be a
    // promise the runtime cannot keep.
    expect(screen.queryByRole('button', { name: 'Gemini' })).toBeNull()
  })

  it('reports the agent alongside the model, so a turn can name the instance', async () => {
    const onChange = renderPicker()
    await open()

    await userEvent.click(screen.getByRole('button', { name: /^Claude Opus 5/ }))
    expect(onChange).toHaveBeenCalledWith({ agentId: 'claude', modelId: 'claude-opus-5', modelName: 'Claude Opus 5' })
  })

  it('switches the listed catalog when the rail changes agent', async () => {
    const onChange = renderPicker()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(await screen.findByRole('button', { name: /^GPT-5 Codex/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Claude Opus 5/ })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /^GPT-5 Codex/ }))
    expect(onChange).toHaveBeenCalledWith({ agentId: 'codex', modelId: 'gpt-5-codex', modelName: 'GPT-5 Codex' })
  })

  it('filters rows by the search query', async () => {
    renderPicker()
    const search = await open()

    await userEvent.type(search, 'opus')
    expect(screen.getByRole('button', { name: /^Claude Opus 5/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Claude Fable 5/ })).toBeNull()
  })

  it('says so when nothing matches instead of showing an empty box', async () => {
    renderPicker()
    const search = await open()

    await userEvent.type(search, 'llama')
    expect(screen.getByText(/No model matches/)).toBeInTheDocument()
  })

  // ⌘N has to address the rows on screen, not the unfiltered catalog —
  // otherwise the badge points at one model and the shortcut picks another.
  it('binds ⌘N to the row carrying that badge', async () => {
    const onChange = renderPicker()
    await open()

    await userEvent.keyboard('{Meta>}2{/Meta}')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'claude-opus-5' }))
  })

  // The badge and the shortcut have to agree after a filter, or ⌘1 picks
  // something other than the row labelled ⌘1.
  it('renumbers ⌘N as the list filters', async () => {
    const onChange = renderPicker()
    const search = await open()

    await userEvent.type(search, 'sonnet')
    await userEvent.keyboard('{Meta>}1{/Meta}')
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ modelId: 'claude-sonnet-5' }))
  })

  it('ignores a ⌘N with no row behind it', async () => {
    const onChange = renderPicker()
    const search = await open()

    await userEvent.type(search, 'sonnet')
    await userEvent.keyboard('{Meta>}3{/Meta}')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('stars a model and filters to favourites', async () => {
    renderPicker()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Favourite Claude Opus 5' }))
    expect(useDevDeckStore.getState().favouriteModels).toContain(favouriteKey('claude', 'claude-opus-5'))

    await userEvent.click(screen.getByRole('button', { name: 'Favourites' }))
    expect(screen.getByRole('button', { name: /^Claude Opus 5/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Claude Fable 5/ })).toBeNull()
  })

  it('explains an empty favourites view rather than looking broken', async () => {
    renderPicker()
    await open()

    await userEvent.click(screen.getByRole('button', { name: 'Favourites' }))
    expect(screen.getByText(/No favourites in Claude yet/)).toBeInTheDocument()
  })
})

// The turn payload has to speak the backend's instance naming rule
// (`orchestration.InstanceIDForAgent`), or the reactor cannot resolve it.
describe('instanceIdForAgent', () => {
  it('is <agent>:default', () => {
    expect(instanceIdForAgent('codex')).toBe('codex:default')
  })

  it('falls back to claude for an unset agent, matching the backend default', () => {
    expect(instanceIdForAgent('')).toBe('claude:default')
  })
})
