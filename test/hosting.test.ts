import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { startWorkspaceServer } from '../src/workspace.js';
import { hostedFromEnvironment } from '../src/hosting.js';
import { environmentKeyStore, type ByosKeyStore } from '../src/byos-connections.js';
import type { LocalAgentService } from '../src/local-agent.js';

const PASSWORD = 'correct horse battery';
const HOST = 'jev.example.test';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function call(port: number, path: string, headers: Record<string, string>, method = 'GET', body?: string): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject); if (body) req.write(body); req.end();
  });
}
const basic = (password: string) => `Basic ${Buffer.from(`any:${password}`).toString('base64')}`;

test('hosted mode needs a long password and reads the public URL Render provides', () => {
  assert.equal(hostedFromEnvironment({}), undefined);
  assert.throws(() => hostedFromEnvironment({ RENDER_EXTERNAL_URL: 'https://jev.onrender.com', JEV_POLLS_PASSWORD: 'short' }), /at least 12/);
  assert.deepEqual(hostedFromEnvironment({ RENDER_EXTERNAL_URL: 'https://jev.onrender.com', JEV_POLLS_PASSWORD: PASSWORD }), { publicUrl: 'https://jev.onrender.com', password: PASSWORD });
  assert.equal(hostedFromEnvironment({ RENDER_EXTERNAL_URL: 'https://a.onrender.com', JEV_POLLS_PUBLIC_URL: 'https://b.example', JEV_POLLS_PASSWORD: PASSWORD })?.publicUrl, 'https://b.example');
});

test('hosted workspace serves only its public host behind the shared password', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-hosted-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const localAgents: Pick<LocalAgentService, 'availability'|'start'|'get'|'cancel'|'close'> = { availability: async () => ({ engines: [] }), start: () => { throw Error('No draft expected'); }, get: () => undefined, cancel: () => undefined, close: async () => {} };
  const port = await freePort();
  const server = await startWorkspaceServer({ directory, port, demo: true, localAgents, hosted: { publicUrl: `https://${HOST}/`, password: PASSWORD }, getAuthStatus: async () => ({ configured: false, source: 'none' }) });
  t.after(() => server.close());
  assert.equal(server.url, `https://${HOST}/`);

  assert.equal((await call(port, '/healthz', { host: '10.0.0.5:10000' })).status, 200);
  const anonymous = await call(port, '/', { host: HOST });
  assert.equal(anonymous.status, 401);
  assert.match(String(anonymous.headers['www-authenticate']), /^Basic /);
  assert.equal((await call(port, '/api/workspace', { host: HOST, authorization: basic('wrong password!!') })).status, 401);
  assert.equal((await call(port, '/', { host: 'evil.example', authorization: basic(PASSWORD) })).status, 403);

  const page = await call(port, '/', { host: HOST, authorization: basic(PASSWORD) });
  assert.equal(page.status, 200);
  const csrf = /[0-9a-f]{64}/.exec(page.text)?.[0];
  assert.ok(csrf, 'page carries a CSRF token');
  const workspace = await call(port, '/api/workspace', { host: HOST, authorization: basic(PASSWORD) });
  assert.equal(workspace.status, 200);
  assert.equal(JSON.parse(workspace.text).demo, true);

  // Mutations still need the public Origin and the CSRF token.
  const foreign = await call(port, '/api/workspace', { host: HOST, authorization: basic(PASSWORD), origin: 'https://evil.example', 'content-type': 'application/json', 'x-jev-csrf': csrf! }, 'POST', '{}');
  assert.equal(foreign.status, 403);
});

test('BYOS keys from the environment win over the credential store and cannot be overwritten from the page', async () => {
  const saved = new Map<string, string>();
  const fallback: ByosKeyStore = { read: async engine => saved.get(engine) ?? null, write: async (engine, key) => { saved.set(engine, key); }, remove: async engine => { saved.delete(engine); } };
  const store = environmentKeyStore(fallback, { ANTHROPIC_API_KEY: ' sk-env ' });
  assert.equal(await store.read('claude-api'), 'sk-env');
  await assert.rejects(store.write('claude-api', 'sk-page'), /ANTHROPIC_API_KEY/);
  assert.equal(await store.read('groq'), null);
  await store.write('groq', 'gsk-page');
  assert.equal(await store.read('groq'), 'gsk-page');
});
