import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startWorkspaceServer } from '../src/workspace.js';
import { emptyWorkspaceDocument } from '../src/workspace-store.js';
import type { LocalAgentInput, LocalAgentJob } from '../src/local-agent.js';
import type { WorkspaceDocument } from '../src/workspace-types.js';

async function commandServer(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'jev-command-api-'));
  const starts: LocalAgentInput[] = [];
  const jobs = new Map<string, LocalAgentJob>();
  const server = await startWorkspaceServer({ directory,
    getAuthStatus: async () => ({ configured: false, source: 'none' }),
    localAgents: {
      availability: async () => ({ engines: [] }),
      start: input => {
        starts.push(structuredClone(input));
        const job: LocalAgentJob = { id: randomUUID(), engine: input.engine, revision: input.revision,
          projectId: input.projectId, status: 'completed', message: 'Command inspected',
          commandResult: { kind: 'draft', target: 'project', prompt: input.prompt } };
        jobs.set(job.id, job); return job;
      },
      get: id => jobs.get(id), cancel: () => undefined, close: async () => {},
    },
    providerFactory: () => { assert.fail('Command navigation must not start model evaluations'); },
  });
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  const csrf = (await (await fetch(server.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]+)"/)![1]!;
  const post = (path: string, value: unknown) => fetch(new URL(path, server.url), { method: 'POST',
    headers: { origin: new URL(server.url).origin, 'content-type': 'application/json', 'x-jev-csrf': csrf }, body: JSON.stringify(value) });
  const snapshot = async () => (await fetch(new URL('/api/workspace', server.url))).json();
  return { starts, post, snapshot };
}

const savedDocument: WorkspaceDocument = { ...emptyWorkspaceDocument(), projects: [
  { id: 'research', name: 'Saved research', description: 'Saved brief', cohortIds: [], pipelineIds: [] },
] };

test('command API searches the unsaved document and does not save it or advance revision', async t => {
  const h = await commandServer(t);
  assert.equal((await h.post('/api/workspace', { document: savedDocument, revision: 0 })).status, 200);
  const before = await h.snapshot();
  const draft = structuredClone(savedDocument);
  draft.projects![0]!.name = 'Unsaved research name';
  draft.projects!.push({ id: 'draft-project', name: 'New unsaved project', description: 'Current draft', cohortIds: [], pipelineIds: [] });
  const response = await h.post('/api/agent/commands', { engine: 'codex', projectId: 'research', prompt: 'Find my new project', revision: before.revision, document: draft });
  assert.equal(response.status, 202);
  assert.equal(h.starts.length, 1); const input = h.starts[0]!;
  assert.equal(input.command, true); assert.deepEqual(input.document, draft);
  assert.equal(input.commandTargets?.find(target => target.id === 'project:research')?.label, 'Unsaved research name');
  assert.equal(input.commandTargets?.find(target => target.id === 'project:draft-project')?.label, 'New unsaved project');
  assert.ok(input.commandTargets?.some(target => target.id === 'new-study'));
  const after = await h.snapshot();
  assert.equal(after.revision, before.revision); assert.deepEqual(after.document, before.document); assert.deepEqual(after.runs, before.runs);
});

test('command API uses saved document when optional draft is absent', async t => {
  const h = await commandServer(t);
  assert.equal((await h.post('/api/workspace', { document: savedDocument, revision: 0 })).status, 200);
  const before = await h.snapshot();
  assert.equal((await h.post('/api/agent/commands', { engine: 'codex', projectId: 'research', prompt: 'Open research', revision: before.revision })).status, 202);
  assert.deepEqual(h.starts[0]!.document, before.document);
  assert.equal(h.starts[0]!.commandTargets?.find(target => target.id === 'project:research')?.label, 'Saved research');
  const after = await h.snapshot(); assert.equal(after.revision, before.revision); assert.deepEqual(after.document, before.document);
});

test('command API rejects stale revisions before starting any agent', async t => {
  const h = await commandServer(t);
  assert.equal((await h.post('/api/workspace', { document: savedDocument, revision: 0 })).status, 200);
  const response = await h.post('/api/agent/commands', { engine: 'codex', projectId: 'research', prompt: 'Open research', revision: 0, document: savedDocument });
  assert.equal(response.status, 409); assert.equal(h.starts.length, 0);
});

test('command API cannot accept caller-supplied destinations, tools or invalid document IDs', async t => {
  const h = await commandServer(t);
  const request = { engine: 'codex', prompt: 'Open a destination', revision: 0 };
  for (const extra of [
    { destination: 'https://example.com/' },
    { commandTargets: [{ id: 'external:unsafe', label: 'Arbitrary destination', detail: '' }] },
    { commandResult: { kind: 'navigate', destination: 'external:unsafe' } },
  ]) assert.equal((await h.post('/api/agent/commands', { ...request, ...extra })).status, 400);
  const document = structuredClone(savedDocument); document.projects![0]!.id = '../outside';
  const invalid = await h.post('/api/agent/commands', { ...request, document });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'INVALID_COMMAND_CONTEXT');
  assert.equal(h.starts.length, 0); assert.equal((await h.snapshot()).revision, 0);
});

test('global command requests can draft a project without any existing or selected project', async t => {
  const h = await commandServer(t);
  const before = await h.snapshot();
  const response = await h.post('/api/agent/commands', { engine: 'codex', prompt: 'Create a project to compare snack names', revision: before.revision });
  assert.equal(response.status, 202);
  const job = await response.json(); assert.equal(job.commandResult.target, 'project');
  assert.equal(h.starts.length, 1); assert.equal(h.starts[0]!.projectId, undefined); assert.equal(h.starts[0]!.command, true);
  assert.ok(h.starts[0]!.commandTargets?.some(target => target.id === 'new-project'));
  assert.equal(h.starts[0]!.commandTargets?.some(target => target.id === 'new-study'), false);
  const after = await h.snapshot(); assert.equal(after.revision, before.revision); assert.deepEqual(after.document, before.document);
});
