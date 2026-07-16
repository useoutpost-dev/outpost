'use strict';

// Byte-bounded, drop-oldest ring buffer of PTY output chunks.
// Stores Buffer chunks and evicts the oldest whole chunks once the total byte
// count exceeds `maxBytes`. A single chunk larger than maxBytes is truncated to
// its trailing maxBytes so the invariant (size <= maxBytes) always holds.
class RingBuffer {
  constructor(maxBytes) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('RingBuffer: maxBytes must be a positive integer');
    }
    this.maxBytes = maxBytes;
    this._chunks = [];
    this._size = 0;
  }

  get size() {
    return this._size;
  }

  // Append a Buffer chunk, evicting oldest chunks to stay within maxBytes.
  push(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      throw new Error('RingBuffer.push: chunk must be a Buffer');
    }
    if (chunk.length === 0) return;

    let toStore = chunk;
    // A single oversized chunk: keep only its trailing maxBytes.
    if (toStore.length > this.maxBytes) {
      toStore = toStore.subarray(toStore.length - this.maxBytes);
    }

    this._chunks.push(toStore);
    this._size += toStore.length;

    while (this._size > this.maxBytes && this._chunks.length > 0) {
      const evicted = this._chunks.shift();
      this._size -= evicted.length;
    }
  }

  // Return a copy of the buffered chunks as an array of Buffers (oldest first).
  snapshot() {
    return this._chunks.slice();
  }

  clear() {
    this._chunks = [];
    this._size = 0;
  }
}

module.exports = { RingBuffer };
