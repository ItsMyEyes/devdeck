import { describe, expect, it } from 'vitest'
import { buildZip } from './testZip'
import { readZip, ZipFormatError } from './zip'

describe('readZip', () => {
  it('reads stored entries', async () => {
    const archive = readZip(await buildZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' }))
    expect(archive.names().sort()).toEqual(['a.txt', 'dir/b.txt'])
    expect(await archive.readText('a.txt')).toBe('hello')
    expect(await archive.readText('dir/b.txt')).toBe('world')
  })

  it('inflates deflated entries', async () => {
    // Repetitive content so deflate genuinely compresses rather than falling
    // back to a stored block — otherwise this would pass without inflating.
    const body = 'the quick brown fox '.repeat(200)
    const archive = readZip(await buildZip({ 'big.txt': body }, { deflate: true }))
    expect(await archive.readText('big.txt')).toBe(body)
  })

  it('preserves UTF-8 content through both paths', async () => {
    const text = 'héllo — ünïcode ✓ 日本語'
    const stored = readZip(await buildZip({ 'u.txt': text }))
    const deflated = readZip(await buildZip({ 'u.txt': text }, { deflate: true }))
    expect(await stored.readText('u.txt')).toBe(text)
    expect(await deflated.readText('u.txt')).toBe(text)
  })

  it('reports whether an entry exists and lists by prefix', async () => {
    const archive = readZip(
      await buildZip({
        'ppt/slides/slide1.xml': '<a/>',
        'ppt/slides/slide2.xml': '<b/>',
        'ppt/presentation.xml': '<c/>',
      }),
    )
    expect(archive.has('ppt/presentation.xml')).toBe(true)
    expect(archive.has('ppt/nope.xml')).toBe(false)
    expect(archive.namesUnder('ppt/slides/').sort()).toEqual([
      'ppt/slides/slide1.xml',
      'ppt/slides/slide2.xml',
    ])
  })

  it('resolves readOptional to null for a missing entry', async () => {
    const archive = readZip(await buildZip({ 'a.txt': 'x' }))
    expect(await archive.readOptional('missing.xml')).toBeNull()
    expect(await archive.readOptional('a.txt')).not.toBeNull()
  })

  it('rejects a missing entry from read', async () => {
    const archive = readZip(await buildZip({ 'a.txt': 'x' }))
    await expect(archive.read('missing.xml')).rejects.toThrow(ZipFormatError)
  })

  it('rejects data that is not a zip at all', () => {
    const notAZip = new TextEncoder().encode('%PDF-1.7 this is a pdf, not a zip'.repeat(4))
    expect(() => readZip(notAZip)).toThrow(ZipFormatError)
  })

  it('rejects an empty buffer', () => {
    expect(() => readZip(new Uint8Array(0))).toThrow(ZipFormatError)
  })

  it('finds the directory even when a trailing comment follows it', async () => {
    // A zip comment sits after the EOCD record, so the backwards scan has to
    // step past it rather than only checking the final 22 bytes.
    const base = await buildZip({ 'a.txt': 'commented' })
    const withComment = new Uint8Array(base.length + 5)
    withComment.set(base)
    withComment.set(new TextEncoder().encode('hello'), base.length)
    new DataView(withComment.buffer).setUint16(base.length - 2, 5, true)

    const archive = readZip(withComment)
    expect(await archive.readText('a.txt')).toBe('commented')
  })

  it('does not expose directory marker entries', async () => {
    const archive = readZip(await buildZip({ 'dir/': '', 'dir/a.txt': 'x' }))
    expect(archive.names()).toEqual(['dir/a.txt'])
  })
})
