import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useRollingSamples } from './useRollingSamples'

describe('useRollingSamples', () => {
  it('starts empty when there is no sample yet', () => {
    const { result } = renderHook(() => useRollingSamples(undefined, 3))
    expect(result.current).toEqual([])
  })

  it('appends each new sample in order', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useRollingSamples(v, 5), {
      initialProps: { v: 1 as number | undefined },
    })
    rerender({ v: 2 })
    rerender({ v: 3 })
    expect(result.current).toEqual([1, 2, 3])
  })

  it('evicts the oldest past the cap', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useRollingSamples(v, 3), {
      initialProps: { v: 1 as number | undefined },
    })
    rerender({ v: 2 })
    rerender({ v: 3 })
    rerender({ v: 4 })
    expect(result.current).toEqual([2, 3, 4])
  })

  it('ignores a re-render that carries the same sample object', () => {
    const sample = { cpu: 1 }
    const { result, rerender } = renderHook(({ v }: { v: object | undefined }) => useRollingSamples(v, 5), {
      initialProps: { v: sample as object | undefined },
    })
    rerender({ v: sample })
    rerender({ v: sample })
    expect(result.current).toEqual([sample])
  })

  it('drops the sample when it becomes undefined without clearing history', () => {
    const { result, rerender } = renderHook(({ v }: { v: number | undefined }) => useRollingSamples(v, 5), {
      initialProps: { v: 1 as number | undefined },
    })
    rerender({ v: undefined })
    expect(result.current).toEqual([1])
  })
})
