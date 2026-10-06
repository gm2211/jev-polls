import { MAX_COHORT_PERSONAS } from '../src/limits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceServer, type WorkspaceServerOptions } from '../src/workspace.js';
import type { LocalAgentJob } from '../src/local-agent.js';
import { emptyWorkspaceDocument } from '../src/workspace-store.js';

test('local assistant proposals require explicit application at the original saved revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-assistant-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = new Map<string, LocalAgentJob>();
  let starts = 0; let closed = false; let inference = 0;
  const localAgents: NonNullable<WorkspaceServerOptions['localAgents']> = {
    availability: async () => ({ engines: [{ id: 'codex', label: 'Codex', available: true, installed: true, authenticated: true, message: 'Ready' }] }),
    start(input) {
      starts++;
      assert.deepEqual(input.document, emptyWorkspaceDocument(), 'server supplies the saved document');
      const job: LocalAgentJob = { id: randomUUID(), engine: input.engine, revision: input.revision, status: 'running', message: 'Drafting', ...(input.cohort ? { cohort: { ...input.cohort, prompt: input.prompt } } : {}) };
      jobs.set(job.id, job); return structuredClone(job);
    },
    get: id => jobs.get(id),
    cancel(id) { const job = jobs.get(id); if (job?.status === 'running') job.status = 'cancelled'; return job; },
    close: async () => { closed = true; },
  };
  const server = await startWorkspaceServer({ directory, localAgents,
    getAuthStatus: async () => ({ configured: false, source: 'none' }),
    providerFactory: () => { inference++; throw Error('Drafting must never run TypeSafe'); },
  });
  t.after(() => server.close());
  const csrf = (await (await fetch(server.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)![1]!;
  const post = (path: string, value: unknown, token = csrf) => fetch(new URL(path, server.url), { method: 'POST', headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': token }, body: JSON.stringify(value) });
  const snapshot = async () => (await fetch(new URL('/api/workspace', server.url))).json();
  const engines = await (await fetch(new URL('/api/local-agents', server.url))).json();
  assert.equal(engines.engines[0].available, true);
  const input = { engine: 'codex', prompt: 'Prepare a synthetic customer pool.', revision: 0 };
  assert.equal((await post('/api/agent/jobs', input, 'wrong')).status, 403);
  assert.equal((await post('/api/agent/jobs', { ...input, revision: 8 })).status, 409);
  assert.equal((await post('/api/agent/jobs', { ...input, document: {} })).status, 400);
  assert.equal((await post('/api/agent/jobs', { ...input, cohort: { id: '__proto__', size: 2 } })).status, 400);
  assert.equal((await post('/api/agent/jobs', { ...input, cohort: { id: 'fresh-panel', size: MAX_COHORT_PERSONAS + 1 } })).status, 400);
  assert.equal(starts, 0);
  const created = await post('/api/agent/jobs', { ...input, cohort: { id: 'fresh-panel', size: 100 } });
  assert.equal(created.status, 202);
  const job = jobs.get((await created.json()).id)!;
  assert.deepEqual(job.cohort, { id: 'fresh-panel', size: 100, prompt: input.prompt });
  assert.equal((await post(`/api/agent/jobs/${job.id}/apply`, { revision: 0 })).status, 409);
  job.status = 'completed';
  job.proposal = { explanation: 'Proposed empty research pipeline for editing.', document: { version: 1, cohorts: [], pipelines: [{ version: 1, id: 'new-study', name: 'Customer study', description: '', context: {}, cohorts: {}, stages: [] }] } };
  assert.equal((await snapshot()).revision, 0, 'a finished task never saves automatically');
  const read = await (await fetch(new URL(`/api/agent/jobs/${job.id}`, server.url))).json();
  assert.equal(read.proposal.document.pipelines[0].id, 'new-study');
  assert.equal((await post(`/api/agent/jobs/${job.id}/apply`, { revision: 1 })).status, 409);
  const applied = await post(`/api/agent/jobs/${job.id}/apply`, { revision: 0 });
  assert.equal(applied.status, 200);
  assert.equal((await applied.json()).revision, 1);
  assert.equal((await post(`/api/agent/jobs/${job.id}/apply`, { revision: 0 })).status, 409, 'cannot apply the same proposal twice');
  assert.equal((await post('/api/workspace', { document: emptyWorkspaceDocument(), revision: 1 })).status, 200);
  const staleJob = await (await post('/api/agent/jobs', { ...input, revision: 2 })).json();
  const stale = jobs.get(staleJob.id)!;
  stale.status = 'completed'; stale.proposal = job.proposal;
  assert.equal((await post('/api/workspace', { document: emptyWorkspaceDocument(), revision: 2 })).status, 200);
  assert.equal((await post(`/api/agent/jobs/${stale.id}/apply`, { revision: 2 })).status, 409, 'concurrent saved changes cannot be overwritten');
  assert.deepEqual((await snapshot()).document, emptyWorkspaceDocument());
  const pending = await (await post('/api/agent/jobs', { ...input, revision: 3 })).json();
  assert.equal((await (await post(`/api/agent/jobs/${pending.id}/cancel`, {})).json()).status, 'cancelled');
  assert.equal((await post(`/api/agent/jobs/${pending.id}/apply`, { revision: 3 })).status, 409);
  assert.equal(inference, 0);
  await server.close(); assert.equal(closed, true);
});
