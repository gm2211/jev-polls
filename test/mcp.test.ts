import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createResearchMcpServer } from '../src/mcp.js';
import { startWorkspaceServer } from '../src/workspace.js';
import { createProvider } from '../src/provider.js';
import { WorkspaceStore } from '../src/workspace-store.js';
import type { Cohort, Pipeline, RunRecord } from '../src/types.js';
import type { WorkspacePlan, WorkspaceRun, WorkspaceSaved, WorkspaceSnapshot } from '../src/workspace-types.js';

const cohort: Cohort = {
  version: 1, id: 'customers', name: 'Customer panel', description: 'Synthetic test fixture', population: 'Adult customers', createdAt: '2026-10-04T12:00:00Z',
  sources: [], assumptions: ['Test fixture; no observed people or sourced population weights'],
  segments: [{ id: 'regular', label: 'Regular customers', description: 'Test segment', weight: 1, weightBasis: 'assumed', sourceIds: [] }],
  personas: [{ id: 'alex', label: 'Alex', age: 30, segment: 'regular', background: 'Works full time and uses delivery services', attributes: { deliveryFrequency: 'weekly' }, sourceIds: [], syntheticFields: ['background', 'attributes'], weight: 1 }],
};
const pipeline: Pipeline = {
  version: 1, id: 'support', name: 'Customer support study', description: 'Compare service approaches', context: { goal: 'Choose customer support hours' }, cohorts: { audience: 'customers' },
  stages: [
    { id: 'panel', kind: 'poll', label: 'Customer panel', cohort: 'audience', dependsOn: [], questions: { preference: { type: 'choice', label: 'Support preference', instructions: 'Which support approach best fits this customer?', criteria: { phone: 'Telephone support during business hours', chat: 'Chat support every evening' } } } },
    { id: 'decision', kind: 'decision', label: 'Recommendation', dependsOn: ['panel'], from: { stage: 'panel', question: 'preference' }, outputQuestion: 'recommendation' },
  ],
};

async function connect(t: TestContext, url: string) {
  const server = createResearchMcpServer(url);
  const client = new Client({ name: 'test-research-agent', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}, isError = false): Promise<T> {
  const response = await client.callTool({ name, arguments: args });
  assert.equal(response.isError === true, isError, JSON.stringify(response.content));
  return response.structuredContent as T;
}

async function fakeServer(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/`;
}

test('MCP agent edits shared drafts and explicitly reviews/runs, without inference during preparation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let evaluations = 0;
  const mock = createProvider('mock');
  const workspace = await startWorkspaceServer({ directory, getAuthStatus: async () => ({ configured: true, source: 'keychain' }), providerFactory: () => ({ name: 'typesafe', evaluate: async input => { evaluations++; return mock.evaluate(input); } }) });
  t.after(() => workspace.close());
  const client = await connect(t, workspace.url);
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['get_guide', 'get_run', 'get_run_record', 'get_schema', 'get_workspace', 'review_study', 'run_study', 'save_cohort', 'save_pipeline', 'save_project']);
  assert.equal(tools.find(tool => tool.name === 'run_study')?.annotations?.openWorldHint, true);
  assert.ok(!tools.some(tool => /key|auth/.test(tool.name)));
  assert.match((await call<{ guide: string }>(client, 'get_guide')).guide, /question-independent/);
  assert.match(JSON.stringify(await call(client, 'get_schema', { kind: 'cohort' })), /syntheticFields/);
  assert.match(JSON.stringify(await call(client, 'get_schema', { kind: 'pipeline' })), /saved workspace cohort IDs/);
  const prompt = await client.getPrompt({ name: 'prepare_study', arguments: { goal: 'Choose support hours' } });
  assert.match(JSON.stringify(prompt), /Choose support hours/); assert.match(JSON.stringify(prompt), /Do not run unless/);
  assert.equal((await call<WorkspaceSnapshot>(client, 'get_workspace')).revision, 0);
  await call(client, 'save_project', { project: { id: 'customer-research', name: 'Customer research', description: '' }, expectedRevision: 0 });
  assert.equal((await call<WorkspaceSaved>(client, 'save_cohort', { cohort, expectedRevision: 1 })).revision, 2);
  const unfinished = { ...cohort, id: 'unfinished', personas: [], segments: [] };
  assert.equal((await call<WorkspaceSaved>(client, 'save_cohort', { cohort: unfinished, expectedRevision: 2 })).revision, 3);
  const conflict = await call<{ error: { code: string } }>(client, 'save_cohort', { cohort, expectedRevision: 2 }, true);
  assert.equal(conflict.error.code, 'WORKSPACE_CONFLICT');
  const draft = { ...pipeline, stages: [] };
  assert.equal((await call<WorkspaceSaved>(client, 'save_pipeline', { pipeline: draft, expectedRevision: 3 })).revision, 4);
  assert.equal((await call<{ error: { code: string } }>(client, 'review_study', { pipelineId: pipeline.id }, true)).error.code, 'INVALID_STUDY');
  const saved = await call<WorkspaceSaved>(client, 'save_pipeline', { pipeline, expectedRevision: 4 });
  assert.equal(saved.revision, 5); assert.deepEqual(saved.document.cohorts, [cohort, unfinished]);
  const oldPlan = await call<WorkspacePlan>(client, 'review_study', { pipelineId: pipeline.id });
  assert.equal(oldPlan.maxRequests, 1); assert.equal(evaluations, 0);
  await call(client, 'save_pipeline', { pipeline: { ...pipeline, description: 'Reviewed customer support options' }, expectedRevision: 5 });
  const runArgs = (plan: WorkspacePlan) => ({ pipelineId: pipeline.id, revision: plan.revision, planToken: plan.planToken, seed: 'test', concurrency: 1, maxRequests: plan.maxRequests });
  assert.equal((await call<{ error: { code: string } }>(client, 'run_study', runArgs(oldPlan), true)).error.code, 'REVIEW_REQUIRED');
  assert.equal(evaluations, 0);
  const plan = await call<WorkspacePlan>(client, 'review_study', { pipelineId: pipeline.id });
  let job = await call<WorkspaceRun>(client, 'run_study', runArgs(plan));
  assert.equal((await call<{ error: { code: string } }>(client, 'run_study', runArgs(plan), true)).error.code, 'REVIEW_REQUIRED');
  for (let i = 0; i < 100 && job.status === 'running'; i++) {
    await new Promise(resolve => setTimeout(resolve, 10)); job = await call(client, 'get_run', { runId: job.id });
  }
  assert.equal(job.status, 'completed'); assert.equal(evaluations, 1);
  const record = await call<RunRecord>(client, 'get_run_record', { runId: job.id });
  assert.equal(record.pipeline.id, pipeline.id); assert.equal(record.provider, 'typesafe'); assert.deepEqual(record.cohorts.audience, cohort);
  assert.equal(record.stages.panel.status, 'completed');
  const snapshot = await call<WorkspaceSnapshot>(client, 'get_workspace');
  assert.equal(snapshot.runs[0].id, job.id); assert.equal(snapshot.activeRun, null);
  assert.deepEqual(snapshot.auth, { configured: true, source: 'keychain' });
});

test('MCP concurrent upserts preserve unrelated drafts and report conflicts instead of overwriting', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-concurrent-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await startWorkspaceServer({ directory, getAuthStatus: async () => ({ configured: false, source: 'none' }) }); t.after(() => workspace.close());
  const clientA = await connect(t, workspace.url); const clientB = await connect(t, workspace.url);
  await call(clientA, 'save_project', { project: { id: 'research', name: 'Research', description: '' }, expectedRevision: 0 });
  const responses = await Promise.all([
    clientA.callTool({ name: 'save_cohort', arguments: { cohort, expectedRevision: 1 } }),
    clientB.callTool({ name: 'save_pipeline', arguments: { pipeline, expectedRevision: 1 } }),
  ]);
  assert.equal(responses.filter(result => result.isError).length, 1);
  const conflict = responses.find(result => result.isError)!.structuredContent as { error: { code: string } };
  assert.equal(conflict.error.code, 'WORKSPACE_CONFLICT');
  const snapshot = await call<WorkspaceSnapshot>(clientA, 'get_workspace');
  assert.equal(snapshot.revision, 2); assert.equal(snapshot.document.cohorts.length + snapshot.document.pipelines.length, 1);
});

test('MCP accepts only explicit loopback workspace URLs and refuses redirects', async t => {
  for (const url of ['https://127.0.0.1:4180/', 'http://localhost:4180/', 'http://127.1:4180/', 'http://2130706433:4180/', 'http://127.0.0.1:0/', 'http://127.0.0.1:65536/', 'http://127.0.0.1:4180/path', 'http://secret@127.0.0.1:4180/', 'http://127.0.0.1:4180/?key=secret', 'http://127.0.0.1:4180/#secret', 'http://example.com:4180/']) {
    assert.throws(() => createResearchMcpServer(url), /Use http:\/\/127\.0\.0\.1:<port>/);
  }
  let requests = 0;
  const url = await fakeServer(t, (_req, res) => { requests++; res.writeHead(302, { location: 'https://example.com/private-secret' }); res.end(); });
  const client = await connect(t, url);
  const error = await call<{ error: { code: string } }>(client, 'get_workspace', {}, true);
  assert.equal(error.error.code, 'WORKSPACE_UNAVAILABLE'); assert.equal(requests, 1); assert.doesNotMatch(JSON.stringify(error), /private-secret/);
});

test('MCP refreshes an expired session once, but never retries an uncertain paid run', async t => {
  let roots = 0; let reviews = 0; let runs = 0;
  const url = await fakeServer(t, (req, res) => {
    if (req.url === '/') { roots++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<meta name="jev-csrf" content="${String(roots).repeat(64)}">`); return; }
    if (req.method === 'POST') assert.equal(req.headers.origin, new URL(url).origin);
    if (req.url === '/api/plan') {
      reviews++;
      assert.equal(req.headers['x-jev-csrf'], String(reviews).repeat(64));
      res.writeHead(reviews === 1 ? 403 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reviews === 1 ? { error: { code: 'SESSION_EXPIRED', message: 'Expired' } } : { maxRequests: 1 })); return;
    }
    if (req.url === '/api/run') { runs++; req.socket.destroy(); return; }
    res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'OTHER', message: 'private-provider-secret' } }));
  });
  const client = await connect(t, url);
  assert.equal((await call<{ maxRequests: number }>(client, 'review_study', { pipelineId: 'support' })).maxRequests, 1);
  assert.equal(roots, 2); assert.equal(reviews, 2);
  const failure = await call<{ error: { code: string } }>(client, 'run_study', { pipelineId: 'support', revision: 1, planToken: 'a'.repeat(48), seed: 'test', concurrency: 1, maxRequests: 1 }, true);
  assert.equal(failure.error.code, 'WORKSPACE_UNAVAILABLE'); assert.equal(runs, 1);
  const hidden = await call(client, 'get_run', { runId: '00000000-0000-4000-8000-000000000000' }, true);
  assert.doesNotMatch(JSON.stringify(hidden), /private-provider-secret/);
});


test('MCP scopes creation and updates to project ownership without moving other research', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-projects-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await startWorkspaceServer({ directory, getAuthStatus: async () => ({ configured: false, source: 'none' }) }); t.after(() => workspace.close());
  const client = await connect(t, workspace.url);
  const failure = async (name: string, args: Record<string, unknown>, code: string) => {
    assert.equal((await call<{ error: { code: string } }>(client, name, args, true)).error.code, code);
  };
  await failure('save_cohort', { cohort, expectedRevision: 0 }, 'PROJECT_REQUIRED');
  await call(client, 'save_project', { project: { id: 'a', name: 'A', description: '' }, expectedRevision: 0 });
  await call(client, 'save_project', { project: { id: 'b', name: 'B', description: '' }, expectedRevision: 1 });
  await failure('save_cohort', { cohort, expectedRevision: 2 }, 'PROJECT_REQUIRED');
  await failure('save_cohort', { cohort, expectedRevision: 2, projectId: 'unknown' }, 'PROJECT_REQUIRED');
  let saved = await call<WorkspaceSaved>(client, 'save_cohort', { cohort, expectedRevision: 2, projectId: 'a' });
  assert.deepEqual(saved.document.projects?.find(project => project.id === 'a')?.cohortIds, [cohort.id]);
  await failure('save_cohort', { cohort: { ...cohort, name: 'Wrong owner' }, expectedRevision: 3, projectId: 'b' }, 'PROJECT_MISMATCH');
  saved = await call<WorkspaceSaved>(client, 'save_cohort', { cohort: { ...cohort, name: 'Updated' }, expectedRevision: 3 });
  assert.equal(saved.document.cohorts[0]!.name, 'Updated');
  await failure('save_pipeline', { pipeline, expectedRevision: 4, projectId: 'b' }, 'INVALID_DRAFT');
  await call(client, 'save_pipeline', { pipeline, expectedRevision: 4, projectId: 'a' });
  await failure('save_pipeline', { pipeline: { ...pipeline, id: 'second' }, expectedRevision: 5, projectId: 'a' }, 'PROJECT_PIPELINE_EXISTS');
  await failure('save_pipeline', { pipeline, expectedRevision: 5, projectId: 'b' }, 'PROJECT_MISMATCH');
  saved = await call<WorkspaceSaved>(client, 'save_project', { project: { id: 'a', name: 'Renamed', description: 'New purpose' }, expectedRevision: 5 });
  assert.deepEqual(saved.document.projects, [
    { id: 'a', name: 'Renamed', description: 'New purpose', cohortIds: [cohort.id], pipelineIds: [pipeline.id] },
    { id: 'b', name: 'B', description: '', cohortIds: [], pipelineIds: [] },
  ]);
  assert.equal(saved.revision, 6);
  assert.deepEqual(saved.document.pipelines, [pipeline]);
});


test('MCP preserves and updates multiple legacy pipelines inside their migrated project', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-legacy-project-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const second = { ...pipeline, id: 'other-study' };
  await new WorkspaceStore(directory).save({ version: 1, cohorts: [cohort], pipelines: [pipeline, second] }, 0);
  const workspace = await startWorkspaceServer({ directory, getAuthStatus: async () => ({ configured: false, source: 'none' }) }); t.after(() => workspace.close());
  const client = await connect(t, workspace.url);
  const saved = await call<WorkspaceSaved>(client, 'save_pipeline', { pipeline: { ...second, name: 'Updated study' }, expectedRevision: 1 });
  assert.deepEqual(saved.document.projects?.[0]?.pipelineIds, [pipeline.id, second.id]);
  assert.deepEqual(saved.document.pipelines[0], pipeline);
  assert.equal(saved.document.pipelines[1]!.name, 'Updated study');
});
