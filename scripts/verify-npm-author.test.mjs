import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EXPECTED_AUTHOR, verifyAuthor } from './verify-npm-author.mjs';

test('accepts the exact approved author object', () => {
  assert.doesNotThrow(() => verifyAuthor({ author: EXPECTED_AUTHOR }, 'fixture'));
});

test('rejects missing, string, partial, and drifted author metadata', () => {
  for (const author of [
    undefined,
    'jiacheng <jiacheng@botiverse.dev>',
    { name: 'jiacheng' },
    { email: 'jiacheng@botiverse.dev' },
    { name: 'Jiacheng', email: 'jiacheng@botiverse.dev' },
    { name: 'jiacheng', email: 'other@example.com' },
  ]) {
    assert.throws(
      () => verifyAuthor({ author }, 'fixture'),
      /publishable package must use an author object|author must be/,
    );
  }
});

test('ignores private workspace packages', () => {
  assert.doesNotThrow(() => verifyAuthor({ private: true }, 'fixture'));
});
