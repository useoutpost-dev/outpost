'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RingBuffer } = require('../lib/ring-buffer');

test('rejects non-positive maxBytes', () => {
  assert.throws(() => new RingBuffer(0));
  assert.throws(() => new RingBuffer(-1));
  assert.throws(() => new RingBuffer(1.5));
});

test('accumulates chunks under the bound', () => {
  const rb = new RingBuffer(100);
  rb.push(Buffer.from('abc'));
  rb.push(Buffer.from('def'));
  assert.equal(rb.size, 6);
  assert.equal(Buffer.concat(rb.snapshot()).toString(), 'abcdef');
});

test('drops oldest whole chunks past the bound', () => {
  const rb = new RingBuffer(10);
  rb.push(Buffer.from('aaaaa')); // 5
  rb.push(Buffer.from('bbbbb')); // 10, at bound
  rb.push(Buffer.from('ccccc')); // 15 -> evict first
  assert.ok(rb.size <= 10);
  assert.equal(Buffer.concat(rb.snapshot()).toString(), 'bbbbbccccc');
});

test('truncates a single oversized chunk to trailing maxBytes', () => {
  const rb = new RingBuffer(4);
  rb.push(Buffer.from('0123456789'));
  assert.equal(rb.size, 4);
  assert.equal(Buffer.concat(rb.snapshot()).toString(), '6789');
});

test('ignores empty chunks and rejects non-buffers', () => {
  const rb = new RingBuffer(10);
  rb.push(Buffer.alloc(0));
  assert.equal(rb.size, 0);
  assert.throws(() => rb.push('not a buffer'));
});

test('clear empties the buffer', () => {
  const rb = new RingBuffer(10);
  rb.push(Buffer.from('xy'));
  rb.clear();
  assert.equal(rb.size, 0);
  assert.deepEqual(rb.snapshot(), []);
});
