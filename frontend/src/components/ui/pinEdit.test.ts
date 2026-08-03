import { describe, expect, it } from 'vitest'
import { backspaceAt, digitsOnly, isWeakPin, PIN_LENGTH, pasteAt, typeAt } from './pinEdit'

describe('digitsOnly', () => {
  it('keeps only ASCII digits', () => {
    expect(digitsOnly('4a8-2 91')).toBe('48291')
  })

  it('caps at PIN_LENGTH', () => {
    expect(digitsOnly('1234567890')).toBe('123456')
  })

  it('drops non-ASCII digit lookalikes', () => {
    expect(digitsOnly('१२३')).toBe('')
  })
})

describe('typeAt', () => {
  it('appends at the end and advances the caret', () => {
    expect(typeAt('48', 2, '2')).toEqual({ value: '482', focus: 3 })
  })

  it('replaces a digit in place and keeps the tail', () => {
    expect(typeAt('482913', 1, '7')).toEqual({ value: '472913', focus: 2 })
  })

  it('clearing a box truncates from there, leaving no hole', () => {
    expect(typeAt('482913', 3, '')).toEqual({ value: '482', focus: 3 })
  })

  it('ignores a non-digit keystroke by treating the box as cleared', () => {
    expect(typeAt('48', 2, 'a')).toEqual({ value: '48', focus: 2 })
  })

  // Android autofill drops the whole code into whichever box has focus.
  it('absorbs a multi-digit value dropped into one box', () => {
    expect(typeAt('', 0, '482913')).toEqual({ value: '482913', focus: 6 })
  })

  it('never grows past PIN_LENGTH', () => {
    expect(typeAt('482913', 6, '7').value).toHaveLength(PIN_LENGTH)
  })
})

describe('backspaceAt', () => {
  it('removes the digit to the left when the box is empty', () => {
    expect(backspaceAt('482', 3)).toEqual({ value: '48', focus: 2 })
  })

  it('defers to the browser when the box still holds a digit', () => {
    expect(backspaceAt('482913', 2)).toBeNull()
  })

  it('does nothing at the first box', () => {
    expect(backspaceAt('', 0)).toBeNull()
  })

  it('walks the whole value back to empty one box at a time', () => {
    let value = '482'
    for (const expected of ['48', '4', '']) {
      const edit = backspaceAt(value, value.length)
      expect(edit).not.toBeNull()
      value = edit!.value
      expect(value).toBe(expected)
    }
  })
})

describe('pasteAt', () => {
  it('fills every box from a pasted code', () => {
    expect(pasteAt('', 0, '482913')).toEqual({ value: '482913', focus: 6 })
  })

  it('strips separators an SMS or password manager adds', () => {
    expect(pasteAt('', 0, '482 913')).toEqual({ value: '482913', focus: 6 })
  })

  it('replaces the tail rather than interleaving', () => {
    expect(pasteAt('482913', 2, '77')).toEqual({ value: '4877', focus: 4 })
  })

  it('is a no-op when the clipboard holds no digits', () => {
    expect(pasteAt('482', 3, 'hello')).toBeNull()
  })

  it('truncates an over-long paste', () => {
    expect(pasteAt('', 0, '4829137777')).toEqual({ value: '482913', focus: 6 })
  })
})

describe('isWeakPin', () => {
  it('rejects repeated digits and straight runs', () => {
    for (const pin of ['000000', '111111', '123456', '654321', '456789', '987654']) {
      expect(isWeakPin(pin)).toBe(true)
    }
  })

  it('accepts ordinary PINs', () => {
    for (const pin of ['482913', '571904', '102030', '123457']) {
      expect(isWeakPin(pin)).toBe(false)
    }
  })

  it('does not judge an incomplete PIN', () => {
    expect(isWeakPin('123')).toBe(false)
  })
})
