import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDuration, parseBytes } from '../src/duration.mjs';

test('parseDuration', () => {
  assert.equal(parseDuration('300ms'), 300);
  assert.equal(parseDuration('15s'), 15000);
  assert.equal(parseDuration('20m'), 1200000);
  assert.equal(parseDuration('2h'), 7200000);
  assert.equal(parseDuration('45'), 45000); // bare number = seconds
  assert.equal(parseDuration(500), 500);
  assert.throws(() => parseDuration('abc'));
});

test('parseBytes', () => {
  assert.equal(parseBytes('3g'), 3 * 1024 ** 3);
  assert.equal(parseBytes('512m'), 512 * 1024 ** 2);
  assert.equal(parseBytes('1.5G'), 1.5 * 1024 ** 3);
  assert.equal(parseBytes('0'), 0);
  assert.throws(() => parseBytes('lots'));
});
