import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceServer } from '../src/workspace.js';
import type { ChatGptDraftClient } from '../src/chatgpt.js';
import type { LocalAgentService } from '../src/local-agent.js';

test('ChatGPT connection endpoints enforce local session and keep TypeSafe and saved workspace separate', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-chatgpt-test-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let connected = false; let signIns = 0; let selected = 'first'; let cancelled = false; let inference = 0;
  let finish: (() => void) | undefined;
  let finishSelect: (() => void) | undefined; let blockSelect = false;
  const client: ChatGptDraftClient = {
    status: async () => ({ connected, planEnabled: connected, ...(connected ? { account: { id: selected, label: 'Test account', connected: true } } : {}), privateToken: 'fake-secret-never-export' }),
    accounts: async () => connected ? [{ id: selected, label: 'Test account', connected: true, privateToken: 'fake-secret-never-export' }] : [],
    signIn: async ({ signal, enablePlan } = {}) => { signIns++; assert.equal(enablePlan, true); await new Promise<void>(resolve => { finish = resolve; signal?.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }); }); if (!cancelled) connected = true; return client.status(); },
    disconnect: async () => { connected = false; return { revoked: true }; },
    selectAccount: async id => { if (blockSelect) await new Promise<void>(resolve => { finishSelect = resolve; }); selected = id; return client.status(); },
    listModels: async () => [{ id: 'model-one', name: 'Model One', privateToken: 'fake-secret-never-export' }],
    generate: async () => { throw Error('Connection must not draft'); },
  };
  const localAgents: Pick<LocalAgentService, 'availability'|'start'|'get'|'cancel'|'close'> = { availability: async () => ({ engines: [] }), start: () => { throw Error('No draft expected'); }, get: () => undefined, cancel: () => undefined, close: async () => {} };
  const server = await startWorkspaceServer({ directory, chatgpt: client, localAgents, getAuthStatus: async () => ({ configured: false, source: 'none' }), providerFactory: () => { inference++; throw Error('No study expected'); } }); t.after(() => server.close());
  const csrf = (await (await fetch(server.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)![1]!;
  const post = (path: string, value: unknown = {}, token = csrf) => fetch(new URL(path, server.url), { method: 'POST', headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': token }, body: JSON.stringify(value) });
  assert.equal((await post('/api/chatgpt/connect', {}, 'wrong')).status, 403); assert.equal(signIns, 0);
  const foreign = await fetch(new URL('/api/chatgpt/status', server.url), { headers: { origin: 'https://attacker.invalid' } }); assert.equal(foreign.status, 403);
  assert.equal((await post('/api/chatgpt/connect')).status, 202); assert.equal(signIns, 1);
  assert.equal((await (await fetch(new URL('/api/chatgpt/status', server.url))).json()).signingIn, true);
  finish!(); await new Promise(resolve => setImmediate(resolve));
  const status = await (await fetch(new URL('/api/chatgpt/status', server.url))).json(); assert.equal(status.connected, true); assert.doesNotMatch(JSON.stringify(status), /fake-secret/);
  const models = await (await fetch(new URL('/api/chatgpt/models', server.url))).json(); assert.deepEqual(models, { models: [{ id: 'model-one', name: 'Model One' }] });
  assert.equal((await post('/api/chatgpt/select', { accountId: 'second' })).status, 200); assert.equal(selected, 'second');
  blockSelect = true;
  const changing = post('/api/chatgpt/select', { accountId: 'first' });
  for (let i = 0; i < 100 && !finishSelect; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(finishSelect);
  assert.equal((await post('/api/agent/jobs', { engine: 'chatgpt', model: 'model-one', prompt: 'Draft', revision: 0 })).status, 409);
  assert.equal((await post('/api/chatgpt/disconnect')).status, 409);
  finishSelect!(); assert.equal((await changing).status, 200);
  assert.equal((await post('/api/chatgpt/disconnect')).status, 200); assert.equal(connected, false);
  await post('/api/chatgpt/connect'); await post('/api/chatgpt/cancel'); assert.equal(cancelled, true);
  const workspace = await (await fetch(new URL('/api/workspace', server.url))).json(); assert.equal(workspace.revision, 0); assert.equal(workspace.auth.configured, false); assert.equal(workspace.document.cohorts.length, 0); assert.equal(inference, 0);
});
