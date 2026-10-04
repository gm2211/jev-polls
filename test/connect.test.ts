import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { startConnectServer } from '../src/connect.js';

const secret = 'fake_typesafe_secret_7c1d_not_real';

async function tokenFrom(url: string): Promise<{ token: string; html: string }> {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  const token = html.match(/<meta name="jev-csrf" content="([a-f0-9]+)">/)?.[1];
  assert.ok(token);
  return { token, html };
}

function post(url: string, token: string, body: unknown, options: { origin?: string; host?: string } = {}) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: options.origin ?? new URL(url).origin,
    'x-jev-csrf': token,
  };
  if (options.host) headers.host = options.host;
  return fetch(new URL('/connect', url), { method: 'POST', headers, body: JSON.stringify(body) });
}

function postWithHost(url: string, token: string, body: unknown, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL('/connect', url), { method: 'POST', headers: {
      host, origin: new URL(url).origin, 'x-jev-csrf': token, 'content-type': 'application/json',
    } }, (response) => {
      let data = '';
      response.setEncoding('utf8');response.on('data', (chunk: string) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: data }));
    });
    request.on('error', reject);request.end(JSON.stringify(body));
  });
}

async function waitForStatus(url: string, expected: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const response = await fetch(new URL('/status', url));
    const status = await response.json() as Record<string, unknown>;
    if (status.status === expected) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${expected} status`);
}

test('serves a secure connection form, runs callback, and returns an intact standalone report without echoing secrets', async (t) => {
  const reportHtml = '<!doctype html><html><body>' + 'x'.repeat(5000) + '</body></html>';
  let receivedKey: string | undefined;
  const handle = await startConnectServer({
    title: 'Album test', detail: 'A small live study.', hasCredential: false,
    connect: async (apiKey, progress) => {
      receivedKey = apiKey;
      progress('Checking key ' + secret);
      return { model: 'jev-' + secret, message: 'Completed ' + secret, reportPath: '/tmp/' + secret, reportHtml };
    },
  });
  t.after(() => handle.close());

  const { token, html } = await tokenFrom(handle.url);
  assert.match(html, /nonce="[A-Za-z0-9+/=]+"/);
  assert.match(html, /https:\/\/console\.typesafe\.ai/);
  assert.match(html, /Live model requests are billed by TypeSafe/);
  assert.match(html, /Connect and run/);
  assert.doesNotMatch(html, new RegExp(secret));
  const accepted = await post(handle.url, token, { apiKey: secret });
  assert.equal(accepted.status, 202);
  assert.doesNotMatch(await accepted.text(), new RegExp(secret));
  assert.equal(receivedKey, secret);

  const status = await waitForStatus(handle.url, 'completed');
  assert.equal(status.model, 'jev-[redacted]');
  assert.equal(status.message, 'Completed [redacted]');
  assert.equal(status.reportPath, '/tmp/[redacted]');
  assert.equal(status.reportAvailable, true);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));

  const report = await fetch(new URL('/report', handle.url));
  assert.equal(report.status, 200);
  assert.match(report.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  assert.match(report.headers.get('cache-control') ?? '', /no-store/);
  assert.equal(await report.text(), reportHtml);
});

test('rejects wrong origin, host, and CSRF token before calling the connection callback', async (t) => {
  let calls = 0;
  const handle = await startConnectServer({ hasCredential: false, connect: async () => { calls += 1; return { model: 'jev' }; } });
  t.after(() => handle.close());
  const { token } = await tokenFrom(handle.url);
  const badOrigin = await post(handle.url, token, { apiKey: secret }, { origin: 'https://attacker.example' });
  const badCsrf = await post(handle.url, '0'.repeat(64), { apiKey: secret });
  const badHost = await postWithHost(handle.url, token, { apiKey: secret }, 'attacker.example');
  assert.deepEqual([badOrigin.status, badCsrf.status, badHost.status], [403, 403, 403]);
  for (const response of [badOrigin, badCsrf]) assert.doesNotMatch(await response.text(), new RegExp(secret));
  assert.doesNotMatch(badHost.body, new RegExp(secret));
  const badStatusOrigin = await fetch(new URL('/status', handle.url), { headers: { origin: 'https://attacker.example' } });
  assert.equal(badStatusOrigin.status, 403);
  assert.equal(badStatusOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal(calls, 0);
});

test('bounds request bodies, requires a key when none is saved, and rejects concurrent or repeated connections', async (t) => {
  let calls = 0;
  let release!: (value: { model: string }) => void;
  const handle = await startConnectServer({ hasCredential: false, connect: async () => { calls += 1; return new Promise((resolve) => { release = resolve; }); } });
  t.after(() => handle.close());
  const { token } = await tokenFrom(handle.url);
  const missing = await post(handle.url, token, {});
  assert.equal(missing.status, 400);
  const oversized = await post(handle.url, token, { apiKey: 'x'.repeat(16 * 1024) });
  assert.equal(oversized.status, 413);
  const responses = await Promise.all([post(handle.url, token, { apiKey: secret }), post(handle.url, token, { apiKey: secret })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
  assert.equal(calls, 1);
  release({ model: 'jev' });
  await waitForStatus(handle.url, 'completed');
  const repeated = await post(handle.url, token, { apiKey: secret });
  assert.equal(repeated.status, 409);
  assert.equal(calls, 1);
});

test('shows fixed actionable provider errors, hides unknown errors, and permits retry after failure', async (t) => {
  let calls = 0;
  const handle = await startConnectServer({ hasCredential: false, connect: async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error(secret), { code: 'TYPESAFE_AUTHENTICATION_FAILED' });
    if (calls === 2) throw Object.assign(new Error(secret), { code: 'UNRECOGNIZED_PRIVATE_FAILURE' });
    return { model: 'jev', message: 'Connected.' };
  } });
  t.after(() => handle.close());
  const { token } = await tokenFrom(handle.url);
  await post(handle.url, token, { apiKey: secret });
  const authFailure = await waitForStatus(handle.url, 'failed');
  assert.equal(authFailure.message, 'TypeSafe rejected the API key. Check it and try again.');
  assert.doesNotMatch(JSON.stringify(authFailure), new RegExp(secret));
  await post(handle.url, token, { apiKey: secret });
  const unknownFailure = await waitForStatus(handle.url, 'failed');
  assert.equal(unknownFailure.message, 'Connection failed. Check the API key and try again.');
  await post(handle.url, token, { apiKey: secret });
  const complete = await waitForStatus(handle.url, 'completed');
  assert.equal(complete.message, 'Connected.');
  assert.equal(calls, 3);
});
