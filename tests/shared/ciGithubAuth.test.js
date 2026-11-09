'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { applyGithubAuth } = require('../../scripts/ci-github-auth');

function captureFetch() {
  const calls = [];
  const target = async (input, init) => {
    calls.push({ input, init });
    return { ok: true };
  };
  return { calls, target };
}

test('adds an Authorization header for github.com downloads', async () => {
  const { calls, target } = captureFetch();
  const patched = applyGithubAuth('tok', target);
  await patched('https://github.com/owner/repo/releases/download/x/bin');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer tok');
});

test('leaves non-github URLs untouched', async () => {
  const { calls, target } = captureFetch();
  const patched = applyGithubAuth('tok', target);
  await patched('https://example.com/file');
  assert.equal(calls[0].init.headers, undefined);
});

test('does not overwrite an existing Authorization header', async () => {
  const { calls, target } = captureFetch();
  const patched = applyGithubAuth('tok', target);
  await patched('https://github.com/x', { headers: { Authorization: 'Bearer existing' } });
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer existing');
});

test('returns the original fetch when no token is provided', () => {
  const target = async () => {};
  assert.equal(applyGithubAuth('', target), target);
  assert.equal(applyGithubAuth(null, target), target);
});

test('accepts a Request-like input with a url property', async () => {
  const { calls, target } = captureFetch();
  const patched = applyGithubAuth('tok', target);
  await patched({ url: 'https://github.com/x/y' });
  assert.equal(calls[0].init.headers.get('Authorization'), 'Bearer tok');
});
