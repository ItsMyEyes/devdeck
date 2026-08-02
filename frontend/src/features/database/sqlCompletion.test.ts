import { describe, expect, it } from 'vitest'
import { sqlCompletionItems } from './sqlCompletion'

import type { SQLSchemaMap } from './sqlEditorSupport'

/** Mirrors what buildSQLSchema emits for a Postgres connection: bare table
 *  names at the top level, plus a nested entry per named schema. */
const schema: SQLSchemaMap = {
  users: ['id', 'email'],
  orders: ['id', 'user_id', 'total'],
  public: { users: ['id', 'email'], orders: ['id', 'user_id', 'total'] },
}

describe('sqlCompletionItems', () => {
  it('offers bare tables and schemas when there is no prefix', () => {
    const items = sqlCompletionItems(schema, null)
    expect(items.map((i) => i.label).sort()).toEqual(['orders', 'public', 'users'])
    expect(items.find((i) => i.label === 'users')!.kind).toBe('table')
    expect(items.find((i) => i.label === 'public')!.kind).toBe('schema')
  })

  it('offers the columns of a bare table prefix', () => {
    const items = sqlCompletionItems(schema, 'users')
    expect(items.map((i) => i.label)).toEqual(['id', 'email'])
    expect(items.every((i) => i.kind === 'column')).toBe(true)
    expect(items[0].detail).toBe('users')
  })

  it('offers the tables of a schema prefix', () => {
    const items = sqlCompletionItems(schema, 'public')
    expect(items.map((i) => i.label).sort()).toEqual(['orders', 'users'])
    expect(items.every((i) => i.kind === 'table')).toBe(true)
    expect(items[0].detail).toBe('public')
  })

  it('is case-insensitive on the prefix', () => {
    expect(sqlCompletionItems(schema, 'USERS').map((i) => i.label)).toEqual(['id', 'email'])
  })

  it('returns nothing for an unknown prefix', () => {
    expect(sqlCompletionItems(schema, 'nope')).toEqual([])
  })

  it('handles an empty schema', () => {
    expect(sqlCompletionItems({}, null)).toEqual([])
  })
})
