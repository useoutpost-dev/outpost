'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractBearer, tokenMatches } = require('../lib/token');

test('extractBearer pulls the token', () => {
  assert.equal(extractBearer('Bearer abc123'), 'abc123');
  assert.equal(extractBearer('Bearer   abc123  '), 'abc123');
});

test('extractBearer returns null for missing/malformed headers', () => {
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer(''), null);
  assert.equal(extractBearer('Basic abc'), null);
  assert.equal(extractBearer('Bearer '), null);
  assert.equal(extractBearer('bearerabc'), null);
});

test('tokenMatches is true only for identical tokens', () => {
  assert.equal(tokenMatches('s3cret', 's3cret'), true);
  assert.equal(tokenMatches('s3cret', 's3cre7'), false);
  assert.equal(tokenMatches('short', 'a-much-longer-token'), false);
});

test('tokenMatches rejects empty/non-string inputs', () => {
  assert.equal(tokenMatches('', ''), false);
  assert.equal(tokenMatches('x', ''), false);
  assert.equal(tokenMatches(undefined, 'x'), false);
  assert.equal(tokenMatches('x', null), false);
});
