import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authStatus, readApiKey, setApiKey } from '../src/auth.js';

test('environment credentials are readable while status reveals only their source', async () => {
  const oldValue = process.env.TYPESAFE_API_KEY;
  const secret = 'fake-auth-secret-that-must-not-leak';
  try {
    process.env.TYPESAFE_API_KEY = secret;
    assert.equal(await readApiKey(), secret);
    assert.deepEqual(await authStatus(), { configured: true, source: 'environment' });
    assert.equal(JSON.stringify(await authStatus()).includes(secret), false);
    assert.equal(process.argv.some((arg) => arg.includes(secret)), false);
  } finally {
    if (oldValue === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldValue;
  }
});

test('blank environment values do not count as configured off macOS', async (t) => {
  if (process.platform === 'darwin') {
    t.skip('A blank environment override falls through to Keychain on macOS.');
    return;
  }
  const oldValue = process.env.TYPESAFE_API_KEY;
  try {
    process.env.TYPESAFE_API_KEY = '  ';
    assert.equal(await readApiKey(), undefined);
    const status = await authStatus();
    assert.equal(status.configured, false);
    assert.equal(status.source, 'none');
  } finally {
    if (oldValue === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = oldValue;
  }
});

test('setting credentials refuses blank values and does not place the supplied value in errors', async () => {
  await assert.rejects(setApiKey('  '), /cannot be empty/);
  if (process.platform !== 'darwin') {
    const secret = 'fake-keychain-secret-that-must-not-leak';
    await assert.rejects(setApiKey(secret), (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message.includes(secret), false);
      assert.equal(process.argv.some((arg) => arg.includes(secret)), false);
      return true;
    });
  }
});
