/** Cross-engine column type mapping for data transfer (postgres <-> mysql
 *  <-> sqlite), plus the CREATE TABLE plan the `ddl/preview` and `ddl/apply`
 *  endpoints already accept.
 *
 *  Pure functions — see `npx tsx src/features/database/typeMap.test.ts`.
 */

import type { DBColumnMeta, DBObjectRef, DBTablePlan } from '@/lib/api'

/** Splits `numeric(10,2)` into `{ base: 'numeric', args: '10,2' }`. A type
 *  with no parenthesized part yields `args: null`. Whitespace inside the
 *  args is squeezed so `decimal(10, 2)` and `decimal(10,2)` agree. */
function splitType(dataType: string): { base: string; args: string | null } {
  const t = dataType.trim().toLowerCase()
  const open = t.indexOf('(')
  if (open === -1 || !t.endsWith(')')) return { base: t, args: null }
  return {
    base: t.slice(0, open).trim(),
    args: t.slice(open + 1, -1).replace(/\s+/g, ''),
  }
}

function withArgs(base: string, args: string | null): string {
  return args === null ? base : `${base}(${args})`
}

/** MySQL spells widths and signedness in the type ("bigint(20) unsigned").
 *  Neither concept survives a transfer to postgres, so both are stripped
 *  before matching. */
function stripUnsigned(dataType: string): string {
  return dataType
    .trim()
    .toLowerCase()
    .replace(/\s+(unsigned|signed|zerofill)\b/g, '')
    .trim()
}

const PG_INT_BASES = new Set(['integer', 'int', 'int4', 'int8', 'int2', 'bigint', 'smallint', 'serial', 'bigserial', 'smallserial'])
const FLOAT_BASES = new Set(['real', 'double', 'double precision', 'float', 'float4', 'float8', 'numeric', 'decimal', 'dec', 'money'])
const BLOB_BASES = new Set(['bytea', 'blob', 'longblob', 'mediumblob', 'tinyblob', 'binary', 'varbinary', 'image'])

/** postgres -> mysql. Unknown types fall back to longtext: the transfer still
 *  succeeds and the value round-trips as its text representation. */
function pgToMySQL(dataType: string): string {
  const { base, args } = splitType(dataType)

  switch (base) {
    case 'uuid':
      return 'char(36)'
    case 'text':
      return 'longtext'
    case 'timestamp':
    case 'timestamptz':
    case 'timestamp with time zone':
    case 'timestamp without time zone':
      return 'datetime'
    case 'boolean':
    case 'bool':
      return 'tinyint(1)'
    case 'json':
    case 'jsonb':
      return 'json'
    case 'bytea':
      return 'longblob'
    case 'double precision':
    case 'float8':
      return 'double'
    case 'real':
    case 'float4':
      return 'float'
    case 'serial':
    case 'serial4':
      return 'int'
    case 'bigserial':
    case 'serial8':
      return 'bigint'
    case 'character varying':
    case 'varchar':
      // MySQL requires an explicit length on varchar; postgres does not.
      return withArgs('varchar', args ?? '255')
    case 'character':
    case 'char':
      return withArgs('char', args ?? '1')
    case 'numeric':
    case 'decimal':
      return withArgs('decimal', args)
    case 'integer':
    case 'int':
    case 'int4':
      return 'int'
    case 'smallint':
    case 'int2':
      return 'smallint'
    case 'bigint':
    case 'int8':
      return 'bigint'
    case 'date':
      return 'date'
    case 'time':
    case 'timetz':
    case 'time with time zone':
    case 'time without time zone':
      return 'time'
    default:
      return 'longtext'
  }
}

/** mysql -> postgres. Unknown types fall back to text. */
function mySQLToPG(dataType: string): string {
  const { base, args } = splitType(stripUnsigned(dataType))

  switch (base) {
    case 'datetime':
    case 'timestamp':
      return 'timestamp'
    case 'tinyint':
      // MySQL's boolean is tinyint(1); any other width is a real small int.
      return args === '1' ? 'boolean' : 'smallint'
    case 'bool':
    case 'boolean':
      return 'boolean'
    case 'smallint':
    case 'mediumint':
      return 'smallint'
    case 'int':
    case 'integer':
      return 'integer'
    case 'bigint':
      return 'bigint'
    case 'longtext':
    case 'mediumtext':
    case 'tinytext':
    case 'text':
      return 'text'
    case 'json':
      return 'jsonb'
    case 'blob':
    case 'longblob':
    case 'mediumblob':
    case 'tinyblob':
    case 'binary':
    case 'varbinary':
      return 'bytea'
    case 'double':
    case 'double precision':
      return 'double precision'
    case 'float':
      return 'real'
    case 'decimal':
    case 'numeric':
    case 'dec':
      return withArgs('decimal', args)
    case 'enum':
      // Recreating the value list as a postgres enum type would need a
      // separate CREATE TYPE; a plain varchar accepts every existing value.
      return 'varchar(255)'
    case 'char':
      return withArgs('char', args)
    case 'varchar':
      return withArgs('varchar', args)
    case 'date':
      return 'date'
    case 'time':
      return 'time'
    case 'year':
      return 'smallint'
    default:
      return 'text'
  }
}

/** anything -> sqlite. SQLite has four usable storage classes, so this is a
 *  deliberate collapse rather than a lookup: booleans store as INTEGER 0/1,
 *  and dates/uuid/json all store as TEXT. */
function toSQLite(dataType: string): string {
  const { base } = splitType(stripUnsigned(dataType))
  if (BLOB_BASES.has(base)) return 'BLOB'
  if (FLOAT_BASES.has(base)) return 'REAL'
  if (PG_INT_BASES.has(base) || base === 'tinyint' || base === 'mediumint' || base === 'serial8' || base === 'serial4') return 'INTEGER'
  if (base === 'boolean' || base === 'bool') return 'INTEGER'
  return 'TEXT'
}

/** sqlite -> postgres. SQLite columns carry a *declared* type whose only
 *  meaning is its affinity, so anything that is not one of the three
 *  non-text storage classes is text. */
function sqliteToPG(dataType: string): string {
  const { base } = splitType(dataType)
  if (base === 'integer' || base === 'int') return 'bigint'
  if (base === 'real') return 'double precision'
  if (base === 'blob') return 'bytea'
  return 'text'
}

/** sqlite -> mysql. Same affinity logic as `sqliteToPG`. */
function sqliteToMySQL(dataType: string): string {
  const { base } = splitType(dataType)
  if (base === 'integer' || base === 'int') return 'bigint'
  if (base === 'real') return 'double'
  if (base === 'blob') return 'longblob'
  return 'longtext'
}

/** Maps a source column's engine-specific type to the closest type in the
 *  target engine. Matching is case-insensitive and tolerates parenthesized
 *  lengths/precisions, which are preserved where the target supports them.
 *  Transferring within one engine is always the identity. */
export function mapColumnType(srcEngine: string, tgtEngine: string, dataType: string): string {
  const src = srcEngine.trim().toLowerCase()
  const tgt = tgtEngine.trim().toLowerCase()
  if (src === tgt) return dataType

  if (tgt === 'sqlite') return toSQLite(dataType)
  if (src === 'sqlite') return tgt === 'mysql' ? sqliteToMySQL(dataType) : sqliteToPG(dataType)
  if (src === 'postgres' && tgt === 'mysql') return pgToMySQL(dataType)
  if (src === 'mysql' && tgt === 'postgres') return mySQLToPG(dataType)
  return dataType
}

/** Builds the CREATE TABLE plan for the target side of a data transfer.
 *
 *  Column names, order, nullability and primary-key flags carry over; types
 *  are mapped through `mapColumnType`. Defaults are dropped — they are
 *  engine-specific expressions (`nextval(...)`, `now()`) that rarely parse on
 *  the other side, and a transfer copies literal values anyway.
 *
 *  LOB columns are deliberately INCLUDED: the row-transfer step skips their
 *  *values*, but the column must still exist in the target table, or every
 *  later insert against it would fail on a NOT NULL LOB.
 */
export function buildTransferTablePlan(
  targetObject: DBObjectRef,
  sourceColumns: DBColumnMeta[],
  srcEngine: string,
  tgtEngine: string,
): DBTablePlan {
  return {
    object: targetObject,
    kind: 'create',
    columns: sourceColumns.map((c) => ({
      name: c.name,
      dataType: mapColumnType(srcEngine, tgtEngine, c.dataType),
      nullable: c.nullable,
      default: null,
      isPrimaryKey: c.isPrimaryKey,
    })),
  }
}
