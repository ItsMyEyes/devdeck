import { createCodePlugin } from '@streamdown/code'
import { oneDarkProDarkerShikiTheme } from '@/lib/oneDarkProDarker'

/**
 * The shiki plugin every Streamdown surface highlights fenced code with.
 *
 * Vendored AI Elements ships `code`, a plugin pre-built on `github-light` /
 * `github-dark`. This swaps the dark half for One Dark Pro Darker so a fenced
 * block in the chat reads in the same colours as the monaco editor next to it
 * (`features/editor/editorTheme.ts` maps the same palette onto monaco's token
 * names). The light half stays on `github-light` — One Dark has no light
 * variant, and the app runs dark by default.
 *
 * It is a module-level singleton on purpose. `createCodePlugin` caches one
 * shiki highlighter per (language, theme-pair), so building a plugin per
 * component would mean a second highlighter — and a second copy of every
 * loaded grammar — for the reasoning pane alone.
 */
export const codeHighlighter = createCodePlugin({
  themes: ['github-light', oneDarkProDarkerShikiTheme],
})
