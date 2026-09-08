import { useRef } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { __resetKeybindingsForTests } from '@/features/keybindings/store'
import { FindBar } from './FindBar'
import { useDomFind } from './useDomFind'

afterEach(() => {
  __resetKeybindingsForTests()
})

function Harness({ body }: { body?: string } = {}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const find = useDomFind(rootRef, { scopeRef: paneRef })
  return (
    <div ref={paneRef}>
      {find.open ? <FindBar controller={find} /> : null}
      <div ref={rootRef} tabIndex={-1} data-testid="doc">
        <p>{body ?? 'alpha beta alpha gamma alpha'}</p>
      </div>
    </div>
  )
}

/** The chord, dispatched from inside the scope the way a real keypress is. */
async function openFind(user: ReturnType<typeof userEvent.setup>) {
  screen.getByTestId('doc').focus()
  await user.keyboard('{Meta>}f{/Meta}')
}

describe('useDomFind', () => {
  it('opens on the chord and reports the match count', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    expect(screen.queryByRole('search')).toBeNull()

    await openFind(user)
    const input = await screen.findByPlaceholderText('Find…')
    await user.type(input, 'alpha')

    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('steps forward and wraps at the end', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openFind(user)
    await user.type(await screen.findByPlaceholderText('Find…'), 'alpha')

    await user.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('2/3')).toBeInTheDocument()
    await user.click(screen.getByLabelText('Next match'))
    await user.click(screen.getByLabelText('Next match'))
    expect(screen.getByText('1/3')).toBeInTheDocument()
  })

  it('steps backward, wrapping to the last match', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openFind(user)
    await user.type(await screen.findByPlaceholderText('Find…'), 'alpha')

    await user.click(screen.getByLabelText('Previous match'))
    expect(screen.getByText('3/3')).toBeInTheDocument()
  })

  it('says so when nothing matches, instead of showing 0/0', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openFind(user)
    await user.type(await screen.findByPlaceholderText('Find…'), 'nothing-here')

    expect(screen.getByText('No results')).toBeInTheDocument()
    expect(screen.getByLabelText('Next match')).toBeDisabled()
  })

  it('does not search the find bar itself', async () => {
    // The bar renders inside the pane; without `data-find-skip` the query in
    // its own input would count as a match against itself.
    const user = userEvent.setup()
    render(<Harness body="only one alpha" />)
    await openFind(user)
    await user.type(await screen.findByPlaceholderText('Find…'), 'alpha')

    expect(screen.getByText('1/1')).toBeInTheDocument()
  })

  it('closes on Escape and clears the query', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openFind(user)
    const input = await screen.findByPlaceholderText('Find…')
    await user.type(input, 'alpha')
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('search')).toBeNull()
    // Reopening has to work, which it only does if focus came back to the
    // surface — the chord is scoped by `contains`, and an unmounting bar
    // otherwise drops focus onto <body>.
    await user.keyboard('{Meta>}f{/Meta}')
    expect(await screen.findByPlaceholderText('Find…')).toHaveValue('')
  })

  it('closes on Escape from the navigation buttons, not just the input', async () => {
    // Stepping through matches moves focus onto a button; binding Escape to
    // the input alone left it dead exactly there.
    const user = userEvent.setup()
    render(<Harness />)
    await openFind(user)
    await user.type(await screen.findByPlaceholderText('Find…'), 'alpha')
    await user.click(screen.getByLabelText('Next match'))
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('search')).toBeNull()
  })

  it('closes on Escape from the document itself', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await openFind(user)
    await user.type(await screen.findByPlaceholderText('Find…'), 'alpha')
    screen.getByTestId('doc').focus()
    await user.keyboard('{Escape}')

    expect(screen.queryByRole('search')).toBeNull()
  })

  it('ignores the chord when the keypress comes from outside its scope', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    document.body.focus()
    await user.keyboard('{Meta>}f{/Meta}')

    expect(screen.queryByRole('search')).toBeNull()
  })
})
