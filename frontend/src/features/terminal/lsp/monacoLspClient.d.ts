/** Types for the `monaco-lsp-client` Vite alias (see vite.config.ts). Monaco
 *  exports this client only from its root entry, which would drag in the 12 MB
 *  TypeScript language feature, so it is imported by path instead. */
declare module 'monaco-lsp-client' {
  export class MonacoLspClient {
    constructor(transport: {
      readonly state: unknown
      send(message: unknown): Promise<void>
      setListener(listener: ((message: unknown) => void) | undefined): void
      toString(): string
    })
  }
}
