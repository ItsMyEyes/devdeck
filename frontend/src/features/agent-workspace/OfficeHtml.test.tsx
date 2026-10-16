import { useLayoutEffect } from 'react'
import { act, render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createOfficeLabel } from '@/features/agent-workspace/OfficeHtml'
it('detaches an independent label root during parent commit without synchronous unmount warnings', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const error = vi.spyOn(console, 'error')
  function Owner() {
    useLayoutEffect(() => {
      const label = createOfficeLabel(host)
      label.render(<button>Agent</button>)
      return () => {
        label.dispose()
        label.dispose()
      }
    }, [])
    return null
  }
  const owner = render(<Owner />)
  await act(async () => {
    await Promise.resolve()
  })
  expect(host.textContent).toBe('Agent')
  await act(async () => {
    owner.unmount()
    expect(host.childElementCount).toBe(0)
    await Promise.resolve()
  })
  expect(error).not.toHaveBeenCalled()
  error.mockRestore()
  host.remove()
})
