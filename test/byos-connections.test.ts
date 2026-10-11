import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BYOS_ENGINES, ByosConnections, extractJsonObject, type ByosEngine, type ByosKeyStore } from '../src/byos-connections.js';
import { buildCommandTargets, LocalAgentService, type LocalAgentJob } from '../src/local-agent.js';
import type { WorkspaceDocument } from '../src/workspace-types.js';

const KEY = 'sk-synthetic-test-key';
function memoryStore(): ByosKeyStore & { keys: Map<ByosEngine, string> } {
  const keys = new Map<ByosEngine, string>();
  return { keys, read: async engine => keys.get(engine) ?? null, write: async (engine, key) => { keys.set(engine, key); }, remove: async engine => { keys.delete(engine); } };
}
function sse(chunks: unknown[]): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
function stubFetch(t: TestContext, handler: (url: string, init: RequestInit) => Response) {
  const original = globalThis.fetch; const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => { calls.push({ url: String(input), init }); return handler(String(input), init); }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

test('every BYOS key provider is listed with its state, and a checked key is stored but never returned', async t => {
  const store = memoryStore(), byos = new ByosConnections(store);
  const before = await byos.engines();
  assert.deepEqual(before.map(engine => engine.id), [...BYOS_ENGINES]);
  assert.ok(before.every(engine => !engine.available && engine.keyHint && engine.setup?.length));
  const calls = stubFetch(t, url => url.endsWith('/models') ? Response.json({ data: [{ id: 'grok-4', name: 'Grok 4' }, { id: 'grok-3-mini' }] }) : new Response('{}', { status: 404 }));
  const models = await byos.connect('grok', `  ${KEY}  `);
  assert.deepEqual(models.map(model => model.id), ['grok-4', 'grok-3-mini']);
  assert.equal(store.keys.get('grok'), KEY);
  assert.equal(calls[0]!.url, 'https://api.x.ai/v1/models');
  const after = await byos.engines();
  assert.equal(after.find(engine => engine.id === 'grok')?.available, true);
  assert.ok(!JSON.stringify(after).includes(KEY) && !JSON.stringify(models).includes(KEY));
  await byos.disconnect('grok');
  assert.equal(store.keys.has('grok'), false);
  assert.equal((await byos.engines()).find(engine => engine.id === 'grok')?.available, false);
});

test('a rejected key is not saved and the provider error text is not echoed', async t => {
  const store = memoryStore(), byos = new ByosConnections(store);
  stubFetch(t, () => Response.json({ error: { message: `bad key ${KEY} secret-detail` } }, { status: 401 }));
  await assert.rejects(byos.connect('groq', KEY), (error: Error) => /did not accept this key/.test(error.message) && !error.message.includes('secret-detail') && !error.message.includes(KEY));
  assert.equal(store.keys.size, 0);
  await assert.rejects(byos.connect('groq', 'two words'), /single Groq key/);
});

test('generation streams through the BYOS provider and returns only model text', async t => {
  const store = memoryStore(); store.keys.set('openrouter', KEY);
  const byos = new ByosConnections(store);
  const calls = stubFetch(t, () => sse([{ choices: [{ delta: { content: '{"a":' } }] }, { choices: [{ delta: { content: '1}' } }] }]));
  const progress: number[] = [];
  const text = await byos.generate({ engine: 'openrouter', model: 'openai/gpt-5', instructions: 'Return JSON', input: 'Draft', onProgress: event => progress.push(event.outputChars) });
  assert.equal(text, '{"a":1}');
  assert.equal(calls[0]!.url, 'https://openrouter.ai/api/v1/chat/completions');
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, 'openai/gpt-5');
  assert.deepEqual(body.messages.map((message: { role: string }) => message.role), ['system', 'user']);
  assert.ok(progress.includes(7));
});

test('JSON is extracted from fenced or wrapped model output', () => {
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('Here you go: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => extractJsonObject('no json here'));
});

test('local assistant lists BYOS providers beside the CLIs and drafts with a connected one', async t => {
  const root = await mkdtemp(join(tmpdir(), 'jev-byos-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const prompts: string[] = [];
  const byos = {
    engines: async () => (await new ByosConnections(memoryStore()).engines()).map(engine => engine.id === 'claude-api' ? { ...engine, available: true, authenticated: true, message: 'Ready' } : engine),
    generate: async ({ engine, model, input }: { engine: ByosEngine; model: string; input: string }) => {
      prompts.push(`${engine}:${model}:${input.length > 0}`);
      return '```json\n' + JSON.stringify({ documentJson: JSON.stringify({ kind: 'search', query: 'projects' }), explanation: 'Searching.' }) + '\n```';
    },
  };
  const spawn = (() => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); }) as never;
  const service = new LocalAgentService({ byos, spawn, temporaryRoot: root }); t.after(() => service.close());
  const availability = await service.availability();
  assert.deepEqual(availability.engines.map(engine => engine.id), ['codex', 'claude', ...BYOS_ENGINES]);
  assert.equal(availability.engines.find(engine => engine.id === 'claude-api')?.available, true);
  const document: WorkspaceDocument = { version: 1, cohorts: [], pipelines: [] };
  assert.throws(() => service.start({ engine: 'claude-api', prompt: 'Find projects', revision: 1, document, command: true, commandTargets: buildCommandTargets(document, undefined) }), /Choose a drafting model/);
  let job: LocalAgentJob = service.start({ engine: 'claude-api', model: 'claude-opus-5-5', prompt: 'Find projects', revision: 1, document, command: true, commandTargets: buildCommandTargets(document, undefined) });
  assert.equal(job.model, 'claude-opus-5-5');
  for (let index = 0; index < 100 && job.status === 'running'; index++) { await new Promise(resolve => setTimeout(resolve, 5)); job = service.get(job.id)!; }
  assert.equal(job.status, 'completed');
  assert.equal(prompts[0], 'claude-api:claude-opus-5-5:true');
});
