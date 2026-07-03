import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../src/ringBuffer.js';

describe('RingBuffer', () => {
  it('returns everything appended while under the cap', () => {
    const buffer = new RingBuffer(1024);
    buffer.append('hello ');
    buffer.append('world');
    expect(buffer.contents()).toBe('hello world');
  });

  it('evicts the oldest chunks once the cap is exceeded', () => {
    const buffer = new RingBuffer(10);
    buffer.append('0123456789'); // exactly 10 bytes
    buffer.append('X'); // pushes total to 11 bytes, must evict the first chunk
    expect(buffer.contents()).toBe('X');
  });

  it('starts empty', () => {
    const buffer = new RingBuffer(1024);
    expect(buffer.contents()).toBe('');
  });
});
