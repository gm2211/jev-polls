import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkspaceServer } from '../src/workspace.js';
import { createProvider } from '../src/provider.js';
import type { WorkspaceDocument, WorkspaceRun } from '../src/workspace-types.js';

const document: WorkspaceDocument = {
  version: 1,
  cohorts: [{ version: 1, id: 'adults', name: 'Adult panel', description: 'Synthetic test profiles', population: 'Adults', createdAt: '2026-10-04T12:00:00Z', sources: [], assumptions: ['Test fixture, not observed people'],
    segments: [{ id: 'players', label: 'Players', description: 'Test segment', weight: 1, weightBasis: 'assumed', sourceIds: [] }],
    personas: [{ id: 'alex', label: 'Alex', age: 30, segment: 'players', background: 'Enjoys strategy games', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 1 }],
  }],
  pipelines: [{ version: 1, id: 'study', name: 'My reviewed study', description: 'Compare options', context: 'User-provided brief', cohorts: { panel: 'adults' }, stages: [
    { id: 'audience', kind: 'poll', label: 'Audience', cohort: 'panel', dependsOn: [], questions: { choice: { type: 'choice', label: 'Preference', instructions: 'Which option fits?', criteria: { a: 'One', b: 'Two' } } } },
    { id: 'decision', kind: 'decision', label: 'Recommendation', dependsOn: ['audience'], from: { stage: 'audience', question: 'choice' }, outputQuestion: 'result' },
  ] }],
};

test('workspace never runs on connect/save/review and requires a fresh explicit run request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-workspace-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let configured = false; let evaluations = 0; let connections = 0;
  const mock = createProvider('mock');
  let server = await startWorkspaceServer({ directory,
    getAuthStatus: async () => ({ configured, source: configured ? 'keychain' : 'none' }),
    connectAccount: async key => { assert.equal(key, 'fake-key-for-transport-test'); configured = true; connections++; },
    providerFactory: () => ({ name: 'mock', evaluate: async request => { evaluations++; return mock.evaluate(request); } }),
  });
  t.after(() => server.close());
  const page = await fetch(server.url);
  const html = await page.text();
  assert.match(page.headers.get('content-security-policy') ?? '', /style-src 'nonce-[^']+'; style-src-attr 'unsafe-inline'/);
  const csrf = html.match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  const config = await (await fetch(new URL('/api/agent-config', server.url))).json();
  assert.equal(config.workspaceUrl, server.url);
  assert.deepEqual(config.args.slice(-3), ['mcp', '--workspace-url', server.url]);
  assert.doesNotMatch(JSON.stringify(config), /fake-key|TYPESAFE_API_KEY/);
  const post = (path: string, value: unknown, token = csrf) => fetch(new URL(path, server.url), { method: 'POST', headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': token! }, body: JSON.stringify(value) });
  const initial = await (await fetch(new URL('/api/workspace', server.url))).json();
  assert.equal(initial.document.cohorts.length, 0);
  assert.equal(initial.document.pipelines.length, 0);
  assert.equal(initial.runs.length, 0);
  assert.equal(evaluations, 0);
  assert.equal((await post('/api/workspace', { document, revision: 0 }, 'wrong')).status, 403);
  const connected = await post('/api/auth', { apiKey: 'fake-key-for-transport-test' });
  assert.equal(connected.status, 200);
  assert.doesNotMatch(await connected.text(), /fake-key/);
  assert.equal(connections, 1); assert.equal(evaluations, 0);
  const saved = await post('/api/workspace', { document, revision: 0 }); assert.equal(saved.status, 200);
  const firstPlan = await (await post('/api/plan', { pipelineId: 'study' })).json();
  assert.equal(firstPlan.maxRequests, 1); assert.equal(firstPlan.stages.length, 2);
  assert.equal(evaluations, 0);
  assert.equal((await post('/api/workspace', { document, revision: 1 })).status, 200);
  const run = (plan: { revision: number; planToken: string }) => post('/api/run', { pipelineId: 'study', revision: plan.revision, planToken: plan.planToken, seed: 'test', concurrency: 2, maxRequests: 1 });
  assert.equal((await run(firstPlan)).status, 409);
  assert.equal(evaluations, 0);
  const plan = await (await post('/api/plan', { pipelineId: 'study' })).json();
  const accepted = await run(plan); assert.equal(accepted.status, 202);
  let job = await accepted.json() as WorkspaceRun;
  assert.equal((await run(plan)).status, 409);
  for (let i = 0; i < 100 && job.status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
    job = await (await fetch(new URL(`/api/run/${job.id}`, server.url))).json() as WorkspaceRun;
  }
  assert.equal(job.status, 'completed'); assert.equal(evaluations, 1);
  assert.ok(job.reportUrl);
  const report = await fetch(new URL(job.reportUrl, server.url));
  assert.equal(report.status, 200); assert.match(await report.text(), /My reviewed study/);
  assert.doesNotMatch(await readFile(join(directory, 'workspace.json'), 'utf8'), /fake-key/);
  const runFolder = join(directory, 'runs', job.id);
  const savedRecord = JSON.parse(await readFile(join(runFolder, 'run.json'), 'utf8')) as { id: string };
  const apiRecord = await (await fetch(new URL(`/api/run/${job.id}/record`, server.url))).json();
  assert.equal(apiRecord.id, savedRecord.id);
  assert.equal(apiRecord.provider, 'mock');
  assert.equal((await fetch(new URL('/api/run/unknown/record', server.url))).status, 404);
  assert.notEqual(savedRecord.id, job.id, 'engine run IDs remain distinct from workspace folder IDs');
  assert.equal(JSON.parse(await readFile(join(runFolder, 'job.json'), 'utf8')).id, job.id);
  await server.close();
  server = await startWorkspaceServer({ directory,
    getAuthStatus: async () => ({ configured, source: configured ? 'keychain' : 'none' }),
    providerFactory: () => mock,
  });
  const recovered = await (await fetch(new URL('/api/workspace', server.url))).json() as { runs: WorkspaceRun[] };
  const recoveredJob = recovered.runs.find(item => item.id === job.id);
  assert.equal(recoveredJob?.id, job.id);
  assert.equal(recoveredJob?.reportUrl, job.reportUrl);
  assert.equal((await fetch(new URL(`/api/run/${job.id}`, server.url))).status, 200);
  assert.equal((await fetch(new URL(job.reportUrl, server.url))).status, 200);
});

test('invalid study review prevents calls and account errors never echo supplied credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-workspace-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let evaluations = 0;
  const server = await startWorkspaceServer({ directory, getAuthStatus: async () => ({ configured: false, source: 'none' }),
    connectAccount: async key => { throw Error(key); },
    providerFactory: () => ({ name: 'mock', evaluate: async () => { evaluations++; throw Error('Must not call'); } }),
  });
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const csrf = html.match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)?.[1];
  assert.ok(csrf);
  const post = (path: string, value: unknown, origin = new URL(server.url).origin) => fetch(new URL(path, server.url), { method: 'POST', headers: { origin, 'content-type': 'application/json', 'x-jev-csrf': csrf! }, body: JSON.stringify(value) });
  assert.equal((await post('/api/workspace', { document, revision: 0 }, 'https://elsewhere.example')).status, 403);
  const draft = structuredClone(document); draft.pipelines[0]!.stages = [];
  assert.equal((await post('/api/workspace', { document: draft, revision: 0 })).status, 200);
  assert.equal((await post('/api/plan', { pipelineId: 'study' })).status, 400);
  const failure = await post('/api/auth', { apiKey: 'fake-sensitive-input' });
  assert.equal(failure.status, 400); assert.doesNotMatch(await failure.text(), /fake-sensitive-input/);
  assert.equal(evaluations, 0);
});

test('rechecks the reviewed revision after asynchronous auth before starting a run', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-workspace-review-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let configured = true; let evaluations = 0; let shouldBlockAuth = false;
  let notifyAuthStarted!: () => void; let releaseAuth!: () => void;
  const authStarted = new Promise<void>(resolve => { notifyAuthStarted = resolve; });
  const authGate = new Promise<void>(resolve => { releaseAuth = resolve; });
  const source = createProvider('mock');
  const serverA = await startWorkspaceServer({ directory,
    getAuthStatus: async () => {
      if (shouldBlockAuth) { shouldBlockAuth = false; notifyAuthStarted(); await authGate; }
      return { configured, source: 'keychain' };
    },
    providerFactory: () => ({ name: 'mock', evaluate: async request => { evaluations++; return source.evaluate(request); } }),
  });
  const serverB = await startWorkspaceServer({ directory, getAuthStatus: async () => ({ configured, source: 'keychain' }) });
  t.after(() => Promise.all([serverA.close(), serverB.close()]));
  const post = (base: string, path: string, value: unknown, csrf: string) => fetch(new URL(path, base), { method: 'POST', headers: { origin: new URL(base).origin, 'content-type': 'application/json', 'x-jev-csrf': csrf }, body: JSON.stringify(value) });
  const csrfA = (await (await fetch(serverA.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)?.[1]!;
  const csrfB = (await (await fetch(serverB.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)?.[1]!;
  assert.equal((await post(serverA.url, '/api/workspace', { document, revision: 0 }, csrfA)).status, 200);
  const plan = await (await post(serverA.url, '/api/plan', { pipelineId: 'study' }, csrfA)).json() as { revision: number; planToken: string };
  shouldBlockAuth = true;
  const pendingRun = post(serverA.url, '/api/run', { pipelineId: 'study', revision: plan.revision, planToken: plan.planToken, seed: 'test', concurrency: 1, maxRequests: 1 }, csrfA);
  await authStarted;
  const changed = structuredClone(document); changed.pipelines[0]!.description = 'A later revision from a second server';
  assert.equal((await post(serverB.url, '/api/workspace', { document: changed, revision: 1 }, csrfB)).status, 200);
  releaseAuth();
  const response = await pendingRun;
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'REVIEW_REQUIRED');
  assert.equal(evaluations, 0);
});

test('rejects concurrent credential connections while the first verification is pending', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-workspace-auth-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0; let release!: () => void; let notifyStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { notifyStarted = resolve; });
  const server = await startWorkspaceServer({ directory,
    getAuthStatus: async () => ({ configured: true, source: 'keychain' }),
    connectAccount: async () => { calls++; notifyStarted(); await gate; },
  });
  t.after(() => server.close());
  const csrf = (await (await fetch(server.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)?.[1]!;
  const post = () => fetch(new URL('/api/auth', server.url), { method: 'POST', headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': csrf }, body: JSON.stringify({ apiKey: 'fake-test-key' }) });
  const first = post(); await started;
  const second = await post();
  assert.equal(second.status, 409); assert.equal((await second.json()).error.code, 'CONNECTING');
  release();
  const accepted = await first;
  assert.equal(accepted.status, 200); assert.equal(calls, 1);
  assert.doesNotMatch(await accepted.text(), /fake-test-key/);
});
