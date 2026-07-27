/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/sqlEditorSupport.test.ts
 *
 * Covers the pure logic behind the SQL editor's Format button (engine →
 * formatter dialect), its history rows (first line of a statement), and its
 * schema-aware autocomplete (react-query cache → CodeMirror SQLNamespace).
 * The autocomplete builder is the interesting one: it must never fire a
 * request, so everything it knows has to come out of whatever the object tree
 * and inspector already cached.
 */

import { buildSQLSchema, firstSQLLine, parseExecutedAt, sqlFormatterLanguage } from './sqlEditorSupport'
import type { DBColumnMeta, DBTreeNode } from '@/lib/api'

let passed = 0

function check(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`ok - ${name}`)
}

function assertEqual<T>(actual: T, expected: T, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
  }
}

// ---- sqlFormatterLanguage ----

check('each engine maps to its sql-formatter dialect', () => {
  assertEqual(sqlFormatterLanguage('postgres'), 'postgresql', 'postgres')
  assertEqual(sqlFormatterLanguage('mysql'), 'mysql', 'mysql')
  assertEqual(sqlFormatterLanguage('sqlite'), 'sqlite', 'sqlite')
})

// ---- firstSQLLine ----

check('firstSQLLine returns a one-line statement unchanged', () => {
  assertEqual(firstSQLLine('SELECT 1'), 'SELECT 1', 'unchanged')
})

check('firstSQLLine takes only the first non-empty line', () => {
  assertEqual(firstSQLLine('\n\nSELECT a\nFROM t\nWHERE x = 1'), 'SELECT a…', 'first line plus ellipsis')
})

check('firstSQLLine handles CRLF', () => {
  assertEqual(firstSQLLine('SELECT a\r\nFROM t'), 'SELECT a…', 'crlf')
})

check('firstSQLLine trims surrounding whitespace', () => {
  assertEqual(firstSQLLine('   SELECT 1   '), 'SELECT 1', 'trimmed')
})

check('firstSQLLine truncates a long single line', () => {
  const long = `SELECT ${'x'.repeat(200)}`
  const out = firstSQLLine(long, 20)
  assertEqual(out.length, 21, 'max chars plus the ellipsis')
  assertEqual(out.endsWith('…'), true, 'ellipsis appended')
})

check('firstSQLLine on blank input is empty', () => {
  assertEqual(firstSQLLine('   \n  \n '), '', 'blank')
})

// ---- parseExecutedAt ----

check('parseExecutedAt reads the RFC3339 stamp the backend writes', () => {
  const d = parseExecutedAt('2026-07-27T09:15:00Z')
  assertEqual(d === null, false, 'parsed')
  assertEqual(d?.toISOString(), '2026-07-27T09:15:00.000Z', 'exact instant')
})

check('parseExecutedAt returns null for an unparseable stamp', () => {
  // date-fns formatDistanceToNow throws RangeError on an Invalid Date, which
  // would take the whole editor tab down; the caller needs a null to fall back
  // on instead.
  assertEqual(parseExecutedAt('not a date'), null, 'garbage')
  assertEqual(parseExecutedAt(''), null, 'empty')
})

// ---- buildSQLSchema ----

function treeKey(connectionId: string, database: string, schema: string, kind: string) {
  return ['db', connectionId, 'tree', { database, schema, kind }] as const
}

function columnsKey(connectionId: string, database: string, schema: string, name: string) {
  return ['db', connectionId, 'columns', { database, schema, name, kind: 'table' }] as const
}

function node(name: string, kind: string): DBTreeNode {
  return { name, kind, hasChildren: false }
}

function col(name: string): DBColumnMeta {
  return {
    name,
    dataType: 'text',
    nullable: true,
    default: null,
    isPrimaryKey: false,
    ordinalPosition: 1,
    isLob: false,
    comparable: true,
  }
}

check('an empty cache produces an empty schema (plain keyword completion)', () => {
  assertEqual(buildSQLSchema([], []), {}, 'empty')
})

check('cached tables become top-level completions with no columns yet', () => {
  const schema = buildSQLSchema(
    [[treeKey('c1', '', '', 'tables'), [node('users', 'table'), node('orders', 'table')]]],
    [],
  )
  assertEqual(schema, { users: [], orders: [] }, 'two tables')
})

check('views and matviews are completable too, but databases/schemas levels are not tables', () => {
  const schema = buildSQLSchema(
    [
      [treeKey('c1', '', '', 'databases'), [node('app', 'database')]],
      [treeKey('c1', 'app', '', 'schemas'), [node('public', 'schema')]],
      [treeKey('c1', 'app', 'public', 'views'), [node('v_active', 'view')]],
      [treeKey('c1', 'app', 'public', 'matviews'), [node('mv_daily', 'matview')]],
      [treeKey('c1', 'app', 'public', 'functions'), [node('now_utc', 'function')]],
    ],
    [],
  )
  assertEqual(Object.keys(schema).sort(), ['mv_daily', 'public', 'v_active'], 'relations only, plus the schema level')
})

check('a table in a named schema is completable bare and schema-qualified', () => {
  const schema = buildSQLSchema([[treeKey('c1', 'app', 'public', 'tables'), [node('users', 'table')]]], [])
  assertEqual(schema, { users: [], public: { users: [] } }, 'both forms')
})

check('cached columns attach to their table', () => {
  const schema = buildSQLSchema(
    [[treeKey('c1', 'app', 'public', 'tables'), [node('users', 'table')]]],
    [[columnsKey('c1', 'app', 'public', 'users'), [col('id'), col('email')]]],
  )
  assertEqual(schema, { users: ['id', 'email'], public: { users: ['id', 'email'] } }, 'columns attached')
})

check('a cached column list for a table the tree never listed still completes', () => {
  // The inspector can populate columns for a table opened from a saved query
  // before that branch of the tree was ever expanded.
  const schema = buildSQLSchema([], [[columnsKey('c1', 'app', 'public', 'events'), [col('id')]]])
  assertEqual(schema, { events: ['id'], public: { events: ['id'] } }, 'columns-only table')
})

check('a same-named table in two schemas keeps the column-bearing one at top level', () => {
  const schema = buildSQLSchema(
    [
      [treeKey('c1', 'app', 'billing', 'tables'), [node('users', 'table')]],
      [treeKey('c1', 'app', 'public', 'tables'), [node('users', 'table')]],
    ],
    [[columnsKey('c1', 'app', 'public', 'users'), [col('id')]]],
  )
  assertEqual(schema.users, ['id'], 'the known columns win over the empty duplicate')
  assertEqual(schema.billing, { users: [] }, 'billing still qualified')
  assertEqual(schema.public, { users: ['id'] }, 'public still qualified')
})

check('undefined cache data (a query that has not resolved) is skipped, not thrown on', () => {
  const schema = buildSQLSchema(
    [
      [treeKey('c1', '', '', 'tables'), undefined],
      [treeKey('c1', '', '', 'views'), [node('v', 'view')]],
    ],
    [[columnsKey('c1', '', '', 'v'), undefined]],
  )
  assertEqual(schema, { v: [] }, 'only the resolved entry')
})

check('a malformed key (no descriptor object) is ignored rather than crashing autocomplete', () => {
  const schema = buildSQLSchema(
    [[['db', 'c1', 'tree'], [node('users', 'table')]]],
    [[['db', 'c1', 'columns'], [col('id')]]],
  )
  assertEqual(schema, {}, 'ignored')
})

check('a table whose name collides with a schema name does not clobber the schema map', () => {
  // "public" as both a schema and a table in another schema: the schema
  // container must survive, otherwise `public.` completion breaks.
  const schema = buildSQLSchema(
    [
      [treeKey('c1', 'app', 'public', 'tables'), [node('users', 'table')]],
      [treeKey('c1', 'app', 'other', 'tables'), [node('public', 'table')]],
    ],
    [],
  )
  assertEqual(schema.public, { users: [] }, 'schema container preserved')
  assertEqual(schema.other, { public: [] }, 'the table is still reachable qualified')
})

console.log(`\n${passed} tests passed`)
