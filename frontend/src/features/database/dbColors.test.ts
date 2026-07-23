/**
 * Plain assertion-based tests, matching dbTabs.test.ts's and dbTree.test.ts's
 * convention (no Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/dbColors.test.ts
 */

import { classifyDataType } from './dbColors'

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

check('postgres uuid classifies as uuid', () => {
  assertEqual(classifyDataType('uuid'), 'uuid', 'uuid')
})

check('postgres character varying classifies as text', () => {
  assertEqual(classifyDataType('character varying'), 'text', 'character varying')
})

check('postgres integer classifies as number', () => {
  assertEqual(classifyDataType('integer'), 'number', 'integer')
})

check('postgres bigint classifies as number', () => {
  assertEqual(classifyDataType('bigint'), 'number', 'bigint')
})

check('postgres boolean classifies as boolean', () => {
  assertEqual(classifyDataType('boolean'), 'boolean', 'boolean')
})

check('postgres timestamp without time zone classifies as datetime', () => {
  assertEqual(classifyDataType('timestamp without time zone'), 'datetime', 'timestamp without time zone')
})

check('postgres jsonb classifies as json', () => {
  assertEqual(classifyDataType('jsonb'), 'json', 'jsonb')
})

check('postgres bytea classifies as binary', () => {
  assertEqual(classifyDataType('bytea'), 'binary', 'bytea')
})

check('mysql varchar classifies as text', () => {
  assertEqual(classifyDataType('varchar'), 'text', 'varchar')
})

check('mysql tinyint classifies as number', () => {
  assertEqual(classifyDataType('tinyint'), 'number', 'tinyint')
})

check('mysql datetime classifies as datetime', () => {
  assertEqual(classifyDataType('datetime'), 'datetime', 'datetime')
})

check('mysql blob classifies as binary', () => {
  assertEqual(classifyDataType('blob'), 'binary', 'blob')
})

check('sqlite INTEGER (uppercase) classifies as number', () => {
  assertEqual(classifyDataType('INTEGER'), 'number', 'INTEGER')
})

check('sqlite VARCHAR(255) with a length classifies as text', () => {
  assertEqual(classifyDataType('VARCHAR(255)'), 'text', 'VARCHAR(255)')
})

check('an unrecognized type returns null (no badge)', () => {
  assertEqual(classifyDataType('point'), null, 'point')
})

console.log(`\n${passed} tests passed`)
