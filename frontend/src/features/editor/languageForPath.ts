/** Replaces CodeMirror's `LanguageDescription.matchFilename(languages, path)`.
 *  Monaco's own `languages.getLanguages()` could be queried instead, but that
 *  requires the monaco namespace and therefore a browser; a static table keeps
 *  this pure and unit-testable, and the set of languages DevDeck opens is
 *  well-known. Unlisted extensions fall back to 'plaintext', which still gives
 *  a working editor — just no tokenizer. */
const BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
}

const BY_EXTENSION: Record<string, string> = {
  go: 'go', mod: 'go', sum: 'plaintext',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python',
  rs: 'rust', java: 'java', kt: 'kotlin', scala: 'scala',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', php: 'php', rb: 'ruby', swift: 'swift', dart: 'dart',
  lua: 'lua', r: 'r', pl: 'perl', ex: 'elixir', exs: 'elixir',
  erl: 'erlang', clj: 'clojure', hs: 'plaintext',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', bat: 'bat',
  sql: 'sql',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  graphql: 'graphql', gql: 'graphql', proto: 'proto',
  vue: 'html', svelte: 'html',
  dockerfile: 'dockerfile',
}

export function languageForPath(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  if (!name) return 'plaintext'

  const byName = BY_FILENAME[name]
  if (byName) return byName

  const dot = name.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return BY_EXTENSION[name.slice(dot + 1)] ?? 'plaintext'
}
