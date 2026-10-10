import { MAX_COHORT_PERSONAS } from '../src/limits.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceServer, type WorkspaceServerOptions } from '../src/workspace.js';
import { LocalAgentService, type LocalAgentJob } from '../src/local-agent.js';
import { emptyWorkspaceDocument, validateWorkspaceDocument } from '../src/workspace-store.js';

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
  assert.equal((await post('/api/agent/jobs', { ...input, persona: { cohortId: 'customers', personaId: '__proto__' } })).status, 400);
  assert.equal((await post('/api/agent/jobs', { ...input, persona: { cohortId: 'customers', personaId: 'alex' }, cohort: { id: 'customers', size: 1 } })).status, 400);
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


test('persona regeneration HTTP proposals retain saved data and cannot replace a newer revision', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-persona-http-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const cohort = { version: 1 as const, id: 'customers', name: 'Customers', description: 'Synthetic adults', population: 'Adults', createdAt: '2026-10-04T12:00:00Z', sources: [], assumptions: ['Synthetic sample'], segments: [{ id: 'customers', label: 'Customers', description: 'Assumed audience', weight: 1, weightBasis: 'assumed' as const, sourceIds: [] }], personas: [{ id: 'alex', label: 'Alex', segment: 'customers', age: 35, background: 'Uses delivery services', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 1 }, { id: 'sam', label: 'Sam', segment: 'customers', age: 41, background: 'Uses grocery shops', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 2 }] };
  let calls = 0; let inference = 0;
  const chatgpt = { status: async () => ({ connected: true, planEnabled: true }), accounts: async () => [], generate: async ({ input }: { input: string }) => {
    calls++; assert.match(input, /selectedPersona/); assert.doesNotMatch(input, /Kept pipeline/);
    return { text: JSON.stringify({ documentJson: JSON.stringify({ ...cohort.personas[0], label: 'Jordan', age: 48, background: 'A new synthetic biography' }), explanation: 'New synthetic details for the selected persona.' }) };
  } } as import('../src/chatgpt.js').ChatGptDraftClient;
  const localAgents = new LocalAgentService({ chatgpt });
  const server = await startWorkspaceServer({ directory, chatgpt, localAgents, getAuthStatus: async () => ({ configured: false, source: 'none' }), providerFactory: () => { inference++; throw Error('No study inference'); } }); t.after(() => server.close());
  const csrf = (await (await fetch(server.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)![1]!;
  const post = (path: string, value: unknown) => fetch(new URL(path, server.url), { method: 'POST', headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': csrf }, body: JSON.stringify(value) });
  const document = { version: 1, cohorts: [cohort, { ...structuredClone(cohort), id: 'other' }], pipelines: [{ version: 1, id: 'study', name: 'Kept pipeline', description: '', context: {}, cohorts: {}, stages: [] }] };
  assert.equal((await post('/api/workspace', { revision: 0, document })).status, 200);
  const input = { projectId: 'existing-research', engine: 'chatgpt', model: 'draft-model', prompt: 'Regenerate this entire persona', revision: 1, persona: { cohortId: 'customers', personaId: 'alex' } };
  assert.equal((await post('/api/agent/jobs', { ...input, persona: { ...input.persona, personaId: 'missing' } })).status, 400);
  const response = await post('/api/agent/jobs', input); assert.equal(response.status, 202); const job = await response.json(); assert.deepEqual(job.persona, input.persona);
  for (let index = 0; index < 100 && localAgents.get(job.id)?.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const proposal = localAgents.get(job.id)!; assert.equal(proposal.status, 'completed');
  const actual = proposal.proposal!.document; assert.deepEqual(actual.cohorts[0]!.personas[1], cohort.personas[1]); assert.deepEqual(actual.cohorts[1], document.cohorts[1]); assert.deepEqual(actual.pipelines, document.pipelines);
  assert.equal((await (await fetch(new URL('/api/workspace', server.url))).json()).revision, 1);
  const edited = structuredClone(document); edited.cohorts[0]!.name = 'Newer saved edit';
  assert.equal((await post('/api/workspace', { revision: 1, document: edited })).status, 200);
  assert.equal((await post(`/api/agent/jobs/${job.id}/apply`, { revision: 1 })).status, 409);
  assert.deepEqual((await (await fetch(new URL('/api/workspace', server.url))).json()).document, validateWorkspaceDocument(edited));
  const retry = await (await post('/api/agent/jobs', { ...input, revision: 2 })).json();
  for (let index = 0; index < 100 && localAgents.get(retry.id)?.status === 'running'; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const applied = await post(`/api/agent/jobs/${retry.id}/apply`, { revision: 2 }); assert.equal(applied.status, 200);
  assert.equal((await applied.json()).document.cohorts[0].personas[0].label, 'Jordan');
  assert.equal(calls, 2); assert.equal(inference, 0);
});

test('drafting jobs can be listed per project, and a second tab is told when a proposal was already applied', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-recover-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobs = new Map<string, LocalAgentJob>(); const settled = new Map<string, 'applied' | 'discarded'>();
  const add = (job: Partial<LocalAgentJob>) => { const full = { id: randomUUID(), engine: 'codex', revision: 0, status: 'running', message: 'Working', ...job } as LocalAgentJob; jobs.set(full.id, full); return full; };
  const localAgents: NonNullable<WorkspaceServerOptions['localAgents']> = {
    availability: async () => ({ engines: [] }),
    start: () => { throw Error('not used'); },
    get: id => jobs.get(id),
    cancel: id => jobs.get(id),
    list: projectId => [...jobs.values()].filter(job => settled.get(job.id) === undefined && (projectId === undefined || job.projectId === projectId)),
    settle: (id, how) => { settled.set(id, how); return jobs.get(id); },
    disposition: id => settled.get(id),
    close: async () => {},
  };
  const server = await startWorkspaceServer({ directory, localAgents, getAuthStatus: async () => ({ configured: false, source: 'none' }) });
  t.after(() => server.close());
  const csrf = (await (await fetch(server.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)![1]!;
  const post = (path: string, value: unknown) => fetch(new URL(path, server.url), { method: 'POST', headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': csrf }, body: JSON.stringify(value) });
  const list = async (query: string) => (await fetch(new URL('/api/agent/jobs' + query, server.url))).json();
  const running = add({ projectId: 'mine', status: 'running', cohort: { id: 'panel', size: 1000, prompt: 'Gamers' }, progress: { phase: 'generating', completedPersonas: 375, totalPersonas: 1000 } });
  const other = add({ projectId: 'other', status: 'running' });
  const stale = add({ projectId: 'mine', status: 'completed', revision: 7, proposal: { document: emptyWorkspaceDocument(), explanation: 'Old' } });
  assert.deepEqual((await list('?projectId=mine')).jobs.map((job: LocalAgentJob) => job.id), [running.id], 'scoped to the project and omits proposals for an older revision');
  assert.deepEqual((await list('?projectId=other')).jobs.map((job: LocalAgentJob) => job.id), [other.id]);
  assert.equal((await list('?projectId=mine')).jobs[0].progress.completedPersonas, 375);
  assert.equal((await fetch(new URL('/api/agent/jobs?projectId=..%2Fx', server.url))).status, 400);
  jobs.delete(stale.id);
  const ready = add({ projectId: 'mine', status: 'completed', revision: 0, proposal: { document: emptyWorkspaceDocument(), explanation: 'Fresh' } });
  assert.ok((await list('?projectId=mine')).jobs.some((job: LocalAgentJob) => job.id === ready.id), 'a completed proposal at the saved revision is offered');
  const first = await post(`/api/agent/jobs/${ready.id}/apply`, { revision: 0 });
  assert.equal(first.status, 200);
  assert.equal(settled.get(ready.id), 'applied');
  const second = await post(`/api/agent/jobs/${ready.id}/apply`, { revision: 0 });
  assert.equal(second.status, 409);
  const error = (await second.json()).error;
  assert.equal(error.code, 'AGENT_PROPOSAL_APPLIED');
  assert.match(error.message, /already applied.*another tab/);
  assert.ok(!(await list('?projectId=mine')).jobs.some((job: LocalAgentJob) => job.id === ready.id));
  const discarded = add({ projectId: 'mine', status: 'completed', revision: 1, proposal: { document: emptyWorkspaceDocument(), explanation: 'Fresh' } });
  assert.equal((await post(`/api/agent/jobs/${discarded.id}/discard`, {})).status, 200);
  assert.equal(settled.get(discarded.id), 'discarded');
});
