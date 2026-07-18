'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseControlFrame } = require('../lib/control-frame');

test('parses a valid resize', () => {
  assert.deepEqual(parseControlFrame('{"type":"resize","cols":120,"rows":40}'), {
    type: 'resize',
    cols: 120,
    rows: 40,
  });
});

test('rejects resize with bad dimensions', () => {
  assert.equal(parseControlFrame('{"type":"resize","cols":0,"rows":40}').type, 'error');
  assert.equal(parseControlFrame('{"type":"resize","cols":-1,"rows":40}').type, 'error');
  assert.equal(parseControlFrame('{"type":"resize","cols":10,"rows":99999}').type, 'error');
  assert.equal(parseControlFrame('{"type":"resize","cols":"80","rows":24}').type, 'error');
});

test('parses ping and pong', () => {
  assert.deepEqual(parseControlFrame('{"type":"ping"}'), { type: 'ping' });
  assert.deepEqual(parseControlFrame('{"type":"pong"}'), { type: 'pong' });
});

test('malformed JSON does not throw and maps to error', () => {
  assert.equal(parseControlFrame('{not json').type, 'error');
  assert.equal(parseControlFrame('').type, 'error');
  assert.equal(parseControlFrame('null').type, 'error');
  assert.equal(parseControlFrame('[1,2,3]').type, 'error');
  assert.equal(parseControlFrame('"a string"').type, 'error');
});

test('unknown type maps to error', () => {
  assert.equal(parseControlFrame('{"type":"launch-missiles"}').type, 'error');
  assert.equal(parseControlFrame('{"nope":1}').type, 'error');
});
