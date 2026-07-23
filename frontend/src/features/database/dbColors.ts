export type DBEngineKey = 'postgres' | 'mysql' | 'sqlite'
export type DBKindKey = 'table' | 'view' | 'matview' | 'function' | 'folder'
export type DBTypeBadgeKey = 'uuid' | 'number' | 'text' | 'boolean' | 'datetime' | 'json' | 'binary'

/** Per-engine identity color — connection gallery cards, the connection
 *  dialog header, and the tree root. */
export const DB_ENGINE_COLOR: Record<DBEngineKey, string> = {
  postgres: '#5b8def',
  mysql: '#e0894a',
  sqlite: '#a385e0',
}

/** Per-object-kind identity color — tree row icons and tab icons share this
 *  map, so a tab visually matches its tree row. */
export const DB_KIND_COLOR: Record<DBKindKey, string> = {
  table: '#5aa9e6',
  view: '#b28ce0',
  matview: '#e07fb0',
  // Deliberately darker/more saturated than devdeck-green (#56d58a, a light
  // mint) — separated by lightness/saturation, not hue alone, so it reads as
  // distinct even placed next to a success-state green.
  function: '#1f9d6b',
  folder: '#c9a06a',
}

/** Tiny colored abbreviation shown next to each column name in the grid
 *  header. json intentionally reuses devdeck-green's hex value — a grid
 *  header badge is a different visual context from where that token carries
 *  success meaning elsewhere in the app. binary reuses devdeck-muted's hex
 *  (not devdeck-gray's #6b7280, which only clears ~3.3:1 against the grid
 *  header background — below the 4.5:1 WCAG AA text-contrast bar); the
 *  literal hex is required here rather than `var(--devdeck-muted)` since
 *  Pill appends alpha suffixes (`${color}18`/`${color}33`) to this value. */
export const DB_TYPE_BADGE: Record<DBTypeBadgeKey, { color: string; label: string }> = {
  uuid: { color: '#4fb8c9', label: 'uuid' },
  number: { color: '#e0713f', label: '#' },
  text: { color: '#b28ce0', label: 'abc' },
  boolean: { color: '#e07fb0', label: 'bool' },
  datetime: { color: '#5b8def', label: 'date' },
  json: { color: '#56d58a', label: '{}' },
  binary: { color: '#a4a8aa', label: 'hex' },
}

/** Classifies a raw, engine-specific SQL data-type string (postgres's
 *  "character varying", mysql's "varchar", sqlite's declared "INTEGER")
 *  into a grid-header badge category. Case-insensitive substring match,
 *  since the three engines never agree on exact type names. Returns null
 *  for a type that doesn't map to any badge (grid renders no badge). */
export function classifyDataType(dataType: string): DBTypeBadgeKey | null {
  const t = dataType.toLowerCase()
  if (t.includes('uuid')) return 'uuid'
  if (t.includes('bool')) return 'boolean'
  if (t.includes('json')) return 'json'
  if (t.includes('blob') || t.includes('bytea') || t.includes('binary')) return 'binary'
  if (t.includes('date') || t.includes('time')) return 'datetime'
  if (t.includes('char') || t.includes('text') || t.includes('clob')) return 'text'
  if (
    // Excludes 'point' (postgres geometric type) — a plain substring check
    // for "int" would otherwise misclassify it as a number, since "point"
    // contains "int".
    (t.includes('int') && !t.includes('point')) ||
    t.includes('numeric') ||
    t.includes('decimal') ||
    t.includes('real') ||
    t.includes('double') ||
    t.includes('float') ||
    t.includes('serial')
  ) {
    return 'number'
  }
  return null
}
