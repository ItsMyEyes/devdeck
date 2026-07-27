/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/dbTree.test.ts
 */

import { childCollections } from './dbTree'
import type { DBCaps } from '@/lib/api'

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

const POSTGRES_CAPS: DBCaps = {
  schemas: true,
  matViews: true,
  functions: true,
  multiDatabase: true,
  rowIdentifier: 'ctid',
  sizeStats: true,
  quoteChar: '"',
  explainPrefix: 'EXPLAIN',
}

const MYSQL_CAPS: DBCaps = {
  schemas: false,
  matViews: false,
  functions: true,
  multiDatabase: true,
  rowIdentifier: 'pk',
  sizeStats: true,
  quoteChar: '`',
  explainPrefix: 'EXPLAIN',
}

const SQLITE_CAPS: DBCaps = {
  schemas: false,
  matViews: false,
  functions: false,
  multiDatabase: false,
  rowIdentifier: 'rowid',
  sizeStats: false,
  quoteChar: '"',
  explainPrefix: 'EXPLAIN QUERY PLAN',
}

check('postgres root lists databases (multiDatabase wins over schemas)', () => {
  assertEqual(childCollections(POSTGRES_CAPS, ''), ['databases'], 'root')
})

check('postgres: expanding a database node (singular node.kind) lists schemas', () => {
  assertEqual(childCollections(POSTGRES_CAPS, 'database'), ['schemas'], 'database -> schemas')
})

check('postgres: expanding a schema node (singular node.kind) lists tables/views/matviews/functions', () => {
  assertEqual(childCollections(POSTGRES_CAPS, 'schema'), ['tables', 'views', 'matviews', 'functions'], 'schema children')
})

check('postgres: the plural collection kind itself has no further children (only nodes do)', () => {
  assertEqual(childCollections(POSTGRES_CAPS, 'databases'), [], 'no match for plural')
  assertEqual(childCollections(POSTGRES_CAPS, 'schemas'), [], 'no match for plural')
})

check('mysql: expanding a database node skips schemas straight to tables/views (no schema layer)', () => {
  assertEqual(childCollections(MYSQL_CAPS, 'database'), ['tables', 'views'], 'database -> tables/views')
})

check('sqlite: root skips straight to tables/views (single file, no databases or schemas)', () => {
  assertEqual(childCollections(SQLITE_CAPS, ''), ['tables', 'views'], 'root')
})

check('leaf kinds (table/view/matview/function) have no children', () => {
  assertEqual(childCollections(POSTGRES_CAPS, 'table'), [], 'table')
  assertEqual(childCollections(POSTGRES_CAPS, 'view'), [], 'view')
  assertEqual(childCollections(POSTGRES_CAPS, 'matview'), [], 'matview')
  assertEqual(childCollections(POSTGRES_CAPS, 'function'), [], 'function')
})

console.log(`\n${passed} tests passed`)
