import { describe, expect, it, vi } from 'vitest'
import { createModelRegistry } from './modelRegistry'

function fakeHost() {
  const created: Array<{ value: string; disposed: boolean }> = []
  return {
    created,
    createModel(value: string) {
      const model = {
        value,
        disposed: false,
        getValue: () => model.value,
        setValue: (v: string) => {
          model.value = v
        },
        dispose: () => {
          model.disposed = true
        },
      }
      created.push(model)
      return model
    },
  }
}

describe('createModelRegistry', () => {
  it('creates a model once and reuses it for the same key', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const a = registry.acquire('k', 'hello', 'go', 'file:///k')
    const b = registry.acquire('k', 'ignored', 'go', 'file:///k')
    expect(a).toBe(b)
    expect(host.created).toHaveLength(1)
    // The second acquire must NOT clobber live edits with its stale value.
    expect(a.getValue()).toBe('hello')
  })

  it('keeps the model alive while any holder remains', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const model = registry.acquire('k', 'v', 'go', 'file:///k')
    registry.acquire('k', 'v', 'go', 'file:///k')
    registry.release('k')
    expect(model.disposed).toBe(false)
    expect(registry.size()).toBe(1)
  })

  it('disposes only when the last holder releases', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const model = registry.acquire('k', 'v', 'go', 'file:///k')
    registry.acquire('k', 'v', 'go', 'file:///k')
    registry.release('k')
    registry.release('k')
    expect(model.disposed).toBe(true)
    expect(registry.size()).toBe(0)
  })

  it('ignores releases beyond zero', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    registry.acquire('k', 'v', 'go', 'file:///k')
    registry.release('k')
    expect(() => registry.release('k')).not.toThrow()
    expect(registry.size()).toBe(0)
  })

  it('survives a pane remount: re-acquiring after a balanced release/acquire pair keeps one model', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const first = registry.acquire('k', 'v', 'go', 'file:///k')
    registry.acquire('k', 'v', 'go', 'file:///k') // remount acquires before unmount releases
    registry.release('k')
    const second = registry.get('k')
    expect(second).toBe(first)
    expect(host.created).toHaveLength(1)
  })

  it('notifies a dispose listener so the LSP can send didClose', () => {
    const host = fakeHost()
    const registry = createModelRegistry(host)
    const onDispose = vi.fn()
    registry.acquire('k', 'v', 'go', 'file:///k', onDispose)
    registry.release('k')
    expect(onDispose).toHaveBeenCalledTimes(1)
  })
})
