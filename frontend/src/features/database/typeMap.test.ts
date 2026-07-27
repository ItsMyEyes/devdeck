/**
 * Plain assertion-based tests, matching dbTabs.test.ts's convention (no
 * Vitest/Jest configured in this project). Run manually with:
 *
 *   npx tsx src/features/database/typeMap.test.ts
 */

import { buildTransferTablePlan, mapColumnType } from './typeMap'
import type { DBColumnMeta, DBObjectRef } from '@/lib/api'

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

function col(name: string, dataType: string, extra: Partial<DBColumnMeta> = {}): DBColumnMeta {
  return {
    name,
    dataType,
    nullable: true,
    default: null,
    isPrimaryKey: false,
    ordinalPosition: 1,
    isLob: false,
    comparable: true,
    ...extra,
  }
}

// ---- identity ----

check('the same engine returns the input unchanged', () => {
  assertEqual(mapColumnType('postgres', 'postgres', 'timestamptz'), 'timestamptz', 'pg -> pg')
  assertEqual(mapColumnType('mysql', 'mysql', 'tinyint(1)'), 'tinyint(1)', 'mysql -> mysql')
  assertEqual(mapColumnType('sqlite', 'sqlite', 'INTEGER'), 'INTEGER', 'sqlite -> sqlite')
  assertEqual(mapColumnType('POSTGRES', 'postgres', 'weird_custom_type'), 'weird_custom_type', 'engine names are case-insensitive')
})

// ---- postgres -> mysql ----

check('pg -> mysql: identity / uuid / json / binary', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'uuid'), 'char(36)', 'uuid')
  assertEqual(mapColumnType('postgres', 'mysql', 'json'), 'json', 'json')
  assertEqual(mapColumnType('postgres', 'mysql', 'jsonb'), 'json', 'jsonb')
  assertEqual(mapColumnType('postgres', 'mysql', 'bytea'), 'longblob', 'bytea')
})

check('pg -> mysql: text and character types', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'text'), 'longtext', 'text')
  assertEqual(mapColumnType('postgres', 'mysql', 'character varying(255)'), 'varchar(255)', 'character varying keeps length')
  assertEqual(mapColumnType('postgres', 'mysql', 'varchar(64)'), 'varchar(64)', 'varchar keeps length')
  assertEqual(mapColumnType('postgres', 'mysql', 'character varying'), 'varchar(255)', 'unbounded varchar gets a default length')
})

check('pg -> mysql: temporal types', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'timestamp'), 'datetime', 'timestamp')
  assertEqual(mapColumnType('postgres', 'mysql', 'timestamptz'), 'datetime', 'timestamptz')
  assertEqual(mapColumnType('postgres', 'mysql', 'timestamp with time zone'), 'datetime', 'spelled-out timestamptz')
  assertEqual(mapColumnType('postgres', 'mysql', 'date'), 'date', 'date')
})

check('pg -> mysql: boolean', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'boolean'), 'tinyint(1)', 'boolean')
  assertEqual(mapColumnType('postgres', 'mysql', 'bool'), 'tinyint(1)', 'bool alias')
})

check('pg -> mysql: numeric types', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'double precision'), 'double', 'double precision')
  assertEqual(mapColumnType('postgres', 'mysql', 'real'), 'float', 'real')
  assertEqual(mapColumnType('postgres', 'mysql', 'numeric(10,2)'), 'decimal(10,2)', 'numeric keeps precision/scale')
  assertEqual(mapColumnType('postgres', 'mysql', 'numeric'), 'decimal', 'bare numeric')
  assertEqual(mapColumnType('postgres', 'mysql', 'integer'), 'int', 'integer')
  assertEqual(mapColumnType('postgres', 'mysql', 'smallint'), 'smallint', 'smallint')
  assertEqual(mapColumnType('postgres', 'mysql', 'bigint'), 'bigint', 'bigint')
})

check('pg -> mysql: serial types lose their sequence and become plain ints', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'serial'), 'int', 'serial')
  assertEqual(mapColumnType('postgres', 'mysql', 'bigserial'), 'bigint', 'bigserial')
})

check('pg -> mysql: an unknown type falls back to longtext', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'tsvector'), 'longtext', 'tsvector')
  assertEqual(mapColumnType('postgres', 'mysql', 'my_custom_enum'), 'longtext', 'user-defined type')
})

check('pg -> mysql matching is case-insensitive', () => {
  assertEqual(mapColumnType('postgres', 'mysql', 'UUID'), 'char(36)', 'UUID')
  assertEqual(mapColumnType('postgres', 'mysql', 'Boolean'), 'tinyint(1)', 'Boolean')
  assertEqual(mapColumnType('postgres', 'mysql', 'TIMESTAMPTZ'), 'datetime', 'TIMESTAMPTZ')
})

// ---- mysql -> postgres ----

check('mysql -> pg: temporal types', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'datetime'), 'timestamp', 'datetime')
  assertEqual(mapColumnType('mysql', 'postgres', 'timestamp'), 'timestamp', 'timestamp')
  assertEqual(mapColumnType('mysql', 'postgres', 'date'), 'date', 'date')
})

check('mysql -> pg: tinyint(1) is a boolean, other tinyints are smallints', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'tinyint(1)'), 'boolean', 'tinyint(1)')
  assertEqual(mapColumnType('mysql', 'postgres', 'tinyint(4)'), 'smallint', 'tinyint(4)')
  assertEqual(mapColumnType('mysql', 'postgres', 'tinyint'), 'smallint', 'bare tinyint')
  assertEqual(mapColumnType('mysql', 'postgres', 'smallint'), 'smallint', 'smallint')
})

check('mysql -> pg: integer widths', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'int'), 'integer', 'int')
  assertEqual(mapColumnType('mysql', 'postgres', 'int(11)'), 'integer', 'display width dropped')
  assertEqual(mapColumnType('mysql', 'postgres', 'bigint'), 'bigint', 'bigint')
  assertEqual(mapColumnType('mysql', 'postgres', 'bigint(20)'), 'bigint', 'bigint display width dropped')
})

check('mysql -> pg: the unsigned suffix is dropped', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'int unsigned'), 'integer', 'int unsigned')
  assertEqual(mapColumnType('mysql', 'postgres', 'bigint(20) unsigned'), 'bigint', 'bigint unsigned')
  assertEqual(mapColumnType('mysql', 'postgres', 'INT UNSIGNED'), 'integer', 'uppercase')
})

check('mysql -> pg: every text width collapses to text', () => {
  for (const t of ['longtext', 'mediumtext', 'tinytext', 'text']) {
    assertEqual(mapColumnType('mysql', 'postgres', t), 'text', t)
  }
})

check('mysql -> pg: json becomes jsonb', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'json'), 'jsonb', 'json')
})

check('mysql -> pg: blob and binary variants become bytea', () => {
  for (const t of ['blob', 'longblob', 'mediumblob', 'tinyblob', 'binary', 'binary(16)', 'varbinary(255)']) {
    assertEqual(mapColumnType('mysql', 'postgres', t), 'bytea', t)
  }
})

check('mysql -> pg: floating point and decimal', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'double'), 'double precision', 'double')
  assertEqual(mapColumnType('mysql', 'postgres', 'float'), 'real', 'float')
  assertEqual(mapColumnType('mysql', 'postgres', 'decimal(10,2)'), 'decimal(10,2)', 'decimal keeps precision/scale')
  assertEqual(mapColumnType('mysql', 'postgres', 'decimal'), 'decimal', 'bare decimal')
})

check('mysql -> pg: enum becomes varchar(255)', () => {
  assertEqual(mapColumnType('mysql', 'postgres', "enum('a','b','c')"), 'varchar(255)', 'enum')
  assertEqual(mapColumnType('mysql', 'postgres', "ENUM('x')"), 'varchar(255)', 'uppercase enum')
})

check('mysql -> pg: char/varchar keep their length', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'char(36)'), 'char(36)', 'char(36)')
  assertEqual(mapColumnType('mysql', 'postgres', 'varchar(255)'), 'varchar(255)', 'varchar(255)')
})

check('mysql -> pg: an unknown type falls back to text', () => {
  assertEqual(mapColumnType('mysql', 'postgres', 'geometry'), 'text', 'geometry')
  assertEqual(mapColumnType('mysql', 'postgres', 'set(\'a\')'), 'text', 'set')
})

// ---- anything -> sqlite ----

check('-> sqlite: the integer family collapses to INTEGER', () => {
  assertEqual(mapColumnType('postgres', 'sqlite', 'integer'), 'INTEGER', 'pg integer')
  assertEqual(mapColumnType('postgres', 'sqlite', 'bigint'), 'INTEGER', 'pg bigint')
  assertEqual(mapColumnType('postgres', 'sqlite', 'serial'), 'INTEGER', 'pg serial')
  assertEqual(mapColumnType('mysql', 'sqlite', 'int(11)'), 'INTEGER', 'mysql int')
  assertEqual(mapColumnType('mysql', 'sqlite', 'tinyint(1)'), 'INTEGER', 'mysql boolean-ish')
  assertEqual(mapColumnType('postgres', 'sqlite', 'boolean'), 'INTEGER', 'pg boolean stores as 0/1')
})

check('-> sqlite: the float/decimal family collapses to REAL', () => {
  for (const t of ['real', 'double precision', 'numeric(10,2)', 'decimal(8,3)', 'float']) {
    assertEqual(mapColumnType('postgres', 'sqlite', t), 'REAL', t)
  }
  assertEqual(mapColumnType('mysql', 'sqlite', 'double'), 'REAL', 'mysql double')
})

check('-> sqlite: the blob family collapses to BLOB', () => {
  assertEqual(mapColumnType('postgres', 'sqlite', 'bytea'), 'BLOB', 'bytea')
  assertEqual(mapColumnType('mysql', 'sqlite', 'longblob'), 'BLOB', 'longblob')
  assertEqual(mapColumnType('mysql', 'sqlite', 'varbinary(255)'), 'BLOB', 'varbinary')
})

check('-> sqlite: everything else is TEXT', () => {
  for (const t of ['text', 'varchar(255)', 'uuid', 'jsonb', 'timestamptz', 'date', 'tsvector']) {
    assertEqual(mapColumnType('postgres', 'sqlite', t), 'TEXT', t)
  }
  assertEqual(mapColumnType('mysql', 'sqlite', "enum('a','b')"), 'TEXT', 'enum')
})

// ---- sqlite -> others ----

check('sqlite -> pg: the five storage classes', () => {
  assertEqual(mapColumnType('sqlite', 'postgres', 'INTEGER'), 'bigint', 'INTEGER')
  assertEqual(mapColumnType('sqlite', 'postgres', 'REAL'), 'double precision', 'REAL')
  assertEqual(mapColumnType('sqlite', 'postgres', 'BLOB'), 'bytea', 'BLOB')
  assertEqual(mapColumnType('sqlite', 'postgres', 'TEXT'), 'text', 'TEXT')
  assertEqual(mapColumnType('sqlite', 'postgres', ''), 'text', 'an undeclared column is text')
})

check('sqlite -> mysql: the five storage classes', () => {
  assertEqual(mapColumnType('sqlite', 'mysql', 'INTEGER'), 'bigint', 'INTEGER')
  assertEqual(mapColumnType('sqlite', 'mysql', 'REAL'), 'double', 'REAL')
  assertEqual(mapColumnType('sqlite', 'mysql', 'BLOB'), 'longblob', 'BLOB')
  assertEqual(mapColumnType('sqlite', 'mysql', 'TEXT'), 'longtext', 'TEXT')
})

check('sqlite source types match case-insensitively and tolerate a declared length', () => {
  assertEqual(mapColumnType('sqlite', 'postgres', 'integer'), 'bigint', 'lowercase')
  assertEqual(mapColumnType('sqlite', 'postgres', 'varchar(255)'), 'text', 'sqlite declared varchar is still text affinity')
  assertEqual(mapColumnType('sqlite', 'mysql', 'real'), 'double', 'lowercase real')
})

// ---- buildTransferTablePlan ----

const TARGET: DBObjectRef = { database: 'app', schema: '', name: 'users_copy', kind: 'table' }

const SOURCE_COLS: DBColumnMeta[] = [
  col('id', 'bigserial', { nullable: false, isPrimaryKey: true, ordinalPosition: 1, default: "nextval('users_id_seq')" }),
  col('email', 'character varying(255)', { nullable: false, ordinalPosition: 2 }),
  col('active', 'boolean', { nullable: false, ordinalPosition: 3, default: 'true' }),
  col('avatar', 'bytea', { nullable: true, ordinalPosition: 4, isLob: true, comparable: false }),
  col('created_at', 'timestamptz', { nullable: false, ordinalPosition: 5, default: 'now()' }),
]

check('buildTransferTablePlan produces a create plan for the target object', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'mysql')
  assertEqual(plan.kind, 'create', 'kind')
  assertEqual(plan.object, TARGET, 'target object threaded through')
})

check('buildTransferTablePlan maps each column type across engines', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'mysql')
  assertEqual(plan.columns?.map((c) => c.dataType), ['bigint', 'varchar(255)', 'tinyint(1)', 'longblob', 'datetime'], 'mapped types')
})

check('buildTransferTablePlan preserves column names and order', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'mysql')
  assertEqual(plan.columns?.map((c) => c.name), ['id', 'email', 'active', 'avatar', 'created_at'], 'names in source order')
})

check('buildTransferTablePlan preserves nullability and primary keys', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'mysql')
  assertEqual(plan.columns?.map((c) => c.nullable), [false, false, false, true, false], 'nullability')
  assertEqual(plan.columns?.map((c) => c.isPrimaryKey), [true, false, false, false, false], 'primary key')
})

check('buildTransferTablePlan drops every default', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'mysql')
  assertEqual(plan.columns?.map((c) => c.default), [null, null, null, null, null], 'defaults dropped — they are engine-specific expressions')
})

check('buildTransferTablePlan INCLUDES LOB columns (they exist in the target even though row transfer skips them)', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'mysql')
  assertEqual(plan.columns?.length, 5, 'all five columns, LOB included')
  assertEqual(plan.columns?.[3], { name: 'avatar', dataType: 'longblob', nullable: true, default: null, isPrimaryKey: false }, 'the LOB column')
})

check('buildTransferTablePlan to sqlite collapses to storage classes', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'sqlite')
  assertEqual(plan.columns?.map((c) => c.dataType), ['INTEGER', 'TEXT', 'INTEGER', 'BLOB', 'TEXT'], 'sqlite types')
})

check('buildTransferTablePlan within one engine leaves types untouched', () => {
  const plan = buildTransferTablePlan(TARGET, SOURCE_COLS, 'postgres', 'postgres')
  assertEqual(plan.columns?.map((c) => c.dataType), ['bigserial', 'character varying(255)', 'boolean', 'bytea', 'timestamptz'], 'unchanged')
  assertEqual(plan.columns?.map((c) => c.default), [null, null, null, null, null], 'defaults still dropped')
})

check('buildTransferTablePlan on a table with no columns yields an empty column list', () => {
  const plan = buildTransferTablePlan(TARGET, [], 'postgres', 'mysql')
  assertEqual(plan.columns, [], 'empty')
})

console.log(`\n${passed} tests passed`)
