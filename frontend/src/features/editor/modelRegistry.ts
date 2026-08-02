export interface ModelLike {
  dispose(): void
  getValue(): string
  setValue(value: string): void
}

export interface ModelHost<M extends ModelLike = ModelLike> {
  createModel(value: string, language: string, uri: unknown): M
}

/**
 * Ref-counted cache of Monaco text models, living outside React.
 *
 * `PaneCanvas` remounts the leaf hosting an editor on every drag-to-split or
 * merge (`moveTab` always allocates a fresh leaf id — see paneTree.ts). If the
 * *model* were recreated on each of those remounts, the LSP `didOpen`/
 * `didChange` version counter would reset with no matching `didClose`, which
 * desyncs diagnostics and can make a server reject later `didChange` versions.
 * Keeping models here means a pane restructure recreates only the cheap editor
 * instance and reattaches the same model, preserving undo history too.
 *
 * This mirrors `sshTerminalRegistry.ts`, which keeps xterm sessions outside the
 * component tree for exactly the same reason.
 */
export function createModelRegistry<M extends ModelLike>(host: ModelHost<M>) {
  interface Entry {
    model: M
    refs: number
    onDispose?: () => void
  }
  const entries = new Map<string, Entry>()

  return {
    acquire(
      key: string,
      value: string,
      language: string,
      uri: unknown,
      onDispose?: () => void,
    ): M {
      const existing = entries.get(key)
      if (existing) {
        // Deliberately does NOT call setValue: `value` is the caller's initial
        // snapshot, which is stale for an already-open buffer with live edits.
        existing.refs += 1
        return existing.model
      }
      const model = host.createModel(value, language, uri)
      entries.set(key, { model, refs: 1, onDispose })
      return model
    },

    release(key: string) {
      const entry = entries.get(key)
      if (!entry) return
      entry.refs -= 1
      if (entry.refs > 0) return
      entries.delete(key)
      entry.onDispose?.()
      entry.model.dispose()
    },

    get(key: string) {
      return entries.get(key)?.model
    },

    size() {
      return entries.size
    },
  }
}
