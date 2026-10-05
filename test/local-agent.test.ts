import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { LocalAgentError, LocalAgentService, type LocalAgentJob, type LocalAgentSpawner } from '../src/local-agent.js';
import type { WorkspaceDocument } from '../src/workspace-types.js';

const empty: WorkspaceDocument = { version: 1, cohorts: [], pipelines: [] };
const proposed: WorkspaceDocument = { version: 1, pipelines: [], cohorts: [{ version: 1, id: 'customers', name: 'Customers', description: 'Assumed adult profiles', population: 'Adult customers', createdAt: '2026-10-04T12:00:00Z', sources: [], assumptions: ['No source research supplied'], segments: [{ id: 'customers', label: 'Customers', description: 'Assumed segment', weight: 1, weightBasis: 'assumed', sourceIds: [] }], personas: [{ id: 'alex', label: 'Alex', segment: 'customers', age: 35, background: 'Uses delivery services weekly', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 1 }] }] };
const output = { documentJson: JSON.stringify(proposed), explanation: 'Added an adult synthetic customer panel. Weights are assumed.' };

class FakeChild extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); pid = undefined;
  signals: NodeJS.Signals[] = []; input = ''; ignoreTerm = false;
  constructor() { super(); this.stdin.on('data', chunk => { this.input += chunk.toString(); }); }
  kill(signal: NodeJS.Signals = 'SIGTERM') { this.signals.push(signal); if (!this.ignoreTerm || signal === 'SIGKILL') queueMicrotask(() => this.emit('close', null)); return true; }
  finish(code = 0) { this.emit('close', code); }
}
interface Invocation { command: string; args: readonly string[]; options: SpawnOptionsWithoutStdio; child: FakeChild }
function fakeSpawner(onDraft: (invocation: Invocation) => void | Promise<void>, invocationList: Invocation[] = []): LocalAgentSpawner {
  return (command, args, options) => {
    const child = new FakeChild(); const invocation = { command, args, options, child }; invocationList.push(invocation);
    child.stdin.once('finish', () => { void (async () => {
      if (args.includes('--version')) { child.stdout.write(`${command} test-version`); child.finish(); }
      else if (args[0] === 'login') { child.stderr.write('Logged in using ChatGPT'); child.finish(); }
      else if (args[0] === 'auth') { child.stdout.write(JSON.stringify({ loggedIn: true, ignored: 'fake-secret-from-auth' })); child.finish(); }
      else await onDraft(invocation);
    })().catch(error => child.emit('error', error)); });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}
async function setup(t: TestContext) { const root = await mkdtemp(join(tmpdir(), 'jev-local-agent-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
async function terminal(service: LocalAgentService, job: LocalAgentJob): Promise<LocalAgentJob> {
  for (let i = 0; i < 200; i++) { const current = service.get(job.id)!; if (current.status !== 'running') return current; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw Error('Test draft did not finish');
}

test('Codex draft uses existing login, stdin prompt, constrained cwd and validated proposal without saving', async t => {
  const root = await setup(t); const invocations: Invocation[] = [];
  const old = process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY = 'fake-private-env-key'; t.after(() => { if (old === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = old; });
  let draftDirectory = '';
  const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(async ({ args, options, child }) => {
    draftDirectory = String(options.cwd);
    assert.equal((await stat(draftDirectory)).mode & 0o777, 0o700);
    const schemaPath = args[args.indexOf('--output-schema') + 1]!; const resultPath = args[args.indexOf('--output-last-message') + 1]!;
    assert.equal((await stat(schemaPath)).mode & 0o777, 0o600); assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
    assert.match(await readFile(schemaPath, 'utf8'), /documentJson/);
    assert.ok(args.includes('--ignore-user-config')); assert.ok(args.includes('--ephemeral')); assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    assert.ok(args.includes('features.shell_tool=false')); assert.ok(args.includes('features.apps=false')); assert.ok(args.includes('features.plugins=false'));
    assert.ok(!args.some(arg => /bypass|full-access/.test(arg)));
    assert.ok(!JSON.stringify(args).includes('fake-private-prompt'));
    assert.equal(options.env?.TYPESAFE_API_KEY, undefined); assert.equal(options.env?.OPENAI_API_KEY, undefined);
    assert.match(child.input, /fake-private-prompt/); assert.match(child.input, /synthetic adults/); assert.match(child.input, /do not invent sources/);
    await writeFile(resultPath, JSON.stringify(output)); child.stderr.write('fake-private-diagnostic'); child.finish();
  }, invocations) });
  t.after(() => service.close());
  const available = await service.availability(); assert.equal(available.engines.length, 2); assert.ok(available.engines.every(engine => engine.available));
  assert.doesNotMatch(JSON.stringify(available), /fake-secret/);
  const job = service.start({ engine: 'codex', prompt: 'Make a pool for fake-private-prompt', revision: 4, document: empty });
  assert.equal(job.status, 'running');
  assert.throws(() => service.start({ engine: 'codex', prompt: 'Other', revision: 4, document: empty }), (error: unknown) => error instanceof LocalAgentError && error.code === 'AGENT_BUSY');
  const completed = await terminal(service, job); assert.equal(completed.status, 'completed'); assert.equal(completed.revision, 4); assert.deepEqual(completed.proposal?.document, proposed);
  assert.deepEqual(empty, { version: 1, cohorts: [], pipelines: [] }); assert.doesNotMatch(JSON.stringify(completed), /fake-private/);
  completed.proposal!.document.cohorts[0]!.name = 'Mutated caller copy'; assert.equal(service.get(job.id)?.proposal?.document.cohorts[0]?.name, 'Customers');
  await service.close(); assert.ok(draftDirectory.startsWith(root)); assert.deepEqual(await readdir(root), []);
  assert.equal(invocations.filter(item => item.args[0] === 'exec').length, 1);
});

test('Claude draft disables tools/customizations and reads structured result without new credentials', async t => {
  const root = await setup(t);
  const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(({ args, child }) => {
    assert.ok(args.includes('--safe-mode')); assert.ok(args.includes('--restricted')); assert.ok(args.includes('--strict-mcp-config')); assert.ok(args.includes('--no-session-persistence'));
    assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.ok(!args.includes('--bare')); assert.match(child.input, /Create a customer pool/);
    child.stdout.write(JSON.stringify({ type: 'result', is_error: false, structured_output: output, diagnostic: 'fake-sensitive-ignored-field' })); child.finish();
  }) }); t.after(() => service.close());
  const completed = await terminal(service, service.start({ engine: 'claude', prompt: 'Create a customer pool', revision: 0, document: empty }));
  assert.equal(completed.status, 'completed'); assert.deepEqual(completed.proposal?.document, proposed); assert.doesNotMatch(JSON.stringify(completed), /fake-sensitive/);
  await service.close(); assert.deepEqual(await readdir(root), []);
});

test('cohort draft replaces only its requested cohort, preserves unrelated workspace data, and records the prompt', async t => {
  const root = await setup(t);
  const current: WorkspaceDocument = { version: 1, cohorts: [structuredClone(proposed.cohorts[0]!), { ...structuredClone(proposed.cohorts[0]!), id: 'other', name: 'Keep this cohort' }], pipelines: [{ version: 1, id: 'study', name: 'Keep this study', description: '', context: {}, cohorts: {}, stages: [] }] };
  const generated = structuredClone(proposed);
  generated.cohorts[0]!.personas.push({ ...structuredClone(generated.cohorts[0]!.personas[0]!), id: 'sam', label: 'Sam', age: 42 });
  const data = { ...output, documentJson: JSON.stringify({ ...current, cohorts: [generated.cohorts[0]!, current.cohorts[1]!] }) };
  const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(async ({ args, child }) => {
    assert.match(child.input, /Never run a study, invoke TypeSafe/);
    assert.match(child.input, /do not invent sources/);
    assert.match(child.input, /Create or replace only the cohort whose ID is customers/);
    await writeFile(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify(data)); child.finish();
  }) });
  t.after(() => service.close());
  const request = 'Create adults who compare budget meal kits';
  const started = service.start({ engine: 'codex', prompt: request, revision: 7, document: current, cohort: { id: 'customers', size: 2 } });
  assert.deepEqual(started.cohort, { id: 'customers', size: 2, prompt: request });
  const completed = await terminal(service, started);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.proposal?.document.cohorts[1], current.cohorts[1]);
  assert.deepEqual(completed.proposal?.document.pipelines, current.pipelines);
  assert.equal(completed.proposal?.document.cohorts[0]?.personas.length, 2);
  assert.equal(completed.proposal?.document.cohorts[0]?.generationPrompt, request);
});

test('cohort drafts reject scope changes, wrong counts, and invalid targets', async t => {
  const root = await setup(t);
  const current: WorkspaceDocument = { version: 1, cohorts: [{ ...structuredClone(proposed.cohorts[0]!), id: 'other' }], pipelines: [] };
  const expectedTarget = structuredClone(proposed.cohorts[0]!);
  expectedTarget.personas.push({ ...structuredClone(expectedTarget.personas[0]!), id: 'sam', label: 'Sam', age: 42 });
  const cases: Array<{ name: string; document: WorkspaceDocument }> = [
    { name: 'unrelated cohort mutation', document: { ...current, cohorts: [{ ...current.cohorts[0]!, name: 'Changed' }, expectedTarget] } },
    { name: 'extra cohort', document: { ...current, cohorts: [...current.cohorts, expectedTarget, { ...expectedTarget, id: 'unexpected' }] } },
    { name: 'pipeline mutation', document: { ...current, cohorts: [...current.cohorts, expectedTarget], pipelines: [{ version: 1, id: 'study', name: 'Changed', description: '', context: {}, cohorts: {}, stages: [] }] } },
    { name: 'missing target', document: current },
    { name: 'wrong target count', document: { ...current, cohorts: [...current.cohorts, { ...expectedTarget, personas: expectedTarget.personas.slice(0, 1) }] } },
    { name: 'invalid target cohort', document: { ...current, cohorts: [...current.cohorts, { ...expectedTarget, segments: [] }] } },
  ];
  for (const item of cases) {
    const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(async ({ args, child }) => { await writeFile(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify({ ...output, documentJson: JSON.stringify(item.document) })); child.finish(); }) });
    const started = service.start({ engine: 'codex', prompt: 'Create two people', revision: 0, document: current, cohort: { id: 'customers', size: 2 } });
    const completed = await terminal(service, started);
    assert.equal(completed.status, 'failed', item.name);
    assert.equal(completed.proposal, undefined, item.name);
    await service.close();
  }
});

test('Failed or invalid CLI output never leaks diagnostics and always removes temporary files', async t => {
  const root = await setup(t);
  for (const mode of ['exit', 'invalid', 'underage'] as const) {
    const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(async ({ args, child }) => {
      child.stderr.write('Authorization: fake-private-provider-key');
      if (mode === 'exit') { child.stdout.write('fake-private-provider-key'); child.finish(1); return; }
      const data = structuredClone(output);
      if (mode === 'invalid') data.documentJson = 'fake-private-provider-key';
      else { const document = structuredClone(proposed); document.cohorts[0]!.personas[0]!.age = 17; data.documentJson = JSON.stringify(document); }
      await writeFile(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify(data)); child.finish();
    }) });
    const failed = await terminal(service, service.start({ engine: 'codex', prompt: 'Prepare personas', revision: 0, document: empty }));
    assert.equal(failed.status, 'failed'); assert.equal(failed.proposal, undefined); assert.doesNotMatch(JSON.stringify(failed), /fake-private|Authorization/);
    await service.close(); assert.deepEqual(await readdir(root), []);
  }
});

test('Cancellation escalates ignored TERM, stops work promptly, and cleans temporary files', async t => {
  const root = await setup(t); let running: FakeChild | undefined;
  const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(({ child }) => { running = child; child.ignoreTerm = true; }) });
  const job = service.start({ engine: 'codex', prompt: 'Prepare pool', revision: 0, document: empty });
  for (let i = 0; i < 100 && !running; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(running); const began = Date.now();
  assert.equal(service.cancel(job.id)?.status, 'cancelled');
  assert.throws(() => service.start({ engine: 'codex', prompt: 'Other', revision: 0, document: empty }), /already in progress/);
  const keepAlive = setInterval(() => undefined, 50);
  try { await service.close(); } finally { clearInterval(keepAlive); }
  assert.ok(Date.now() - began < 1800); assert.deepEqual(running.signals, ['SIGTERM', 'SIGTERM', 'SIGKILL']);
  assert.equal(service.get(job.id)?.status, 'cancelled'); assert.deepEqual(await readdir(root), []);
  assert.throws(() => service.start({ engine: 'codex', prompt: 'Other', revision: 0, document: empty }), /stopped/);
});

test('Draft time/output/input limits fail safely without unbounded subprocesses', async t => {
  const root = await setup(t);
  for (const mode of ['timeout', 'output'] as const) {
    const service = new LocalAgentService({ temporaryRoot: root, timeoutMs: 20, maxOutputBytes: 1000, spawn: fakeSpawner(({ child }) => { if (mode === 'output') child.stdout.write('X'.repeat(2000)); }) });
    const failed = await terminal(service, service.start({ engine: 'claude', prompt: 'Prepare pool', revision: 0, document: empty }));
    assert.equal(failed.status, 'failed'); assert.match(failed.message, /limit/); await service.close(); assert.deepEqual(await readdir(root), []);
  }
  let calls = 0; const service = new LocalAgentService({ spawn: () => { calls++; throw Error('Must not spawn'); } });
  assert.throws(() => service.start({ engine: 'codex', prompt: 'x'.repeat(10_001), revision: 0, document: empty }), /10,000/);
  assert.throws(() => service.start({ engine: 'codex', prompt: 'Draft', revision: -1, document: empty }), /valid workspace/);
  assert.equal(calls, 0); await service.close();
});

test('Missing CLI and unauthenticated status expose only fixed availability guidance', async () => {
  const service = new LocalAgentService({ spawn: (command, args) => {
    const child = new FakeChild(); child.stdin.once('finish', () => {
      if (command === 'codex') queueMicrotask(() => child.emit('error', Object.assign(Error('fake-private-path'), { code: 'ENOENT' })));
      else if (args.includes('--version')) { child.stdout.write('version'); child.finish(); }
      else { child.stdout.write(JSON.stringify({ loggedIn: false, secret: 'fake-private-secret' })); child.finish(1); }
    }); return child as unknown as ChildProcessWithoutNullStreams;
  } });
  const availability = await service.availability(); assert.equal(availability.engines[0]!.installed, false); assert.equal(availability.engines[1]!.installed, true); assert.ok(availability.engines.every(item => !item.available)); assert.doesNotMatch(JSON.stringify(availability), /fake-private/);
  await service.close();
});

test('ChatGPT drafts use native transport, preserve validation, and never start CLI processes', async t => {
  const calls: unknown[] = [];
  const chatgpt = {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async (request: { input: string; model: string; signal?: AbortSignal }) => { calls.push(request); return { text: JSON.stringify(output) }; },
  } as import('../src/chatgpt.js').ChatGptDraftClient;
  const service = new LocalAgentService({ chatgpt, spawn: () => { throw Error('CLI must not start'); } });
  t.after(() => service.close());
  assert.throws(() => service.start({ engine: 'chatgpt', prompt: 'Draft', document: empty, revision: 0 }), /Choose a model/);
  const completed = await terminal(service, service.start({ engine: 'chatgpt', model: 'eligible-model', prompt: 'Prepare synthetic adults', document: empty, revision: 7, cohort: { id: 'customers', size: 1 } }));
  assert.equal(completed.status, 'completed'); assert.equal(completed.revision, 7);
  assert.equal(completed.proposal?.document.cohorts[0]?.generationPrompt, 'Prepare synthetic adults');
  assert.equal(empty.cohorts.length, 0); assert.equal(calls.length, 1);
  assert.match(JSON.stringify(calls), /do not invent sources/);
  chatgpt.generate = async () => ({ text: JSON.stringify(output) });
  const wrongSize = await terminal(service, service.start({ engine: 'chatgpt', model: 'eligible-model', prompt: 'Prepare two', document: empty, revision: 7, cohort: { id: 'customers', size: 2 } }));
  assert.equal(wrongSize.status, 'failed'); assert.equal(wrongSize.proposal, undefined);
  chatgpt.generate = async () => { throw Object.assign(Error('private-token'), { code: 'quota' }); };
  const limited = await terminal(service, service.start({ engine: 'chatgpt', model: 'eligible-model', prompt: 'Prepare', document: empty, revision: 7 }));
  assert.equal(limited.status, 'failed'); assert.match(limited.message, /usage limit/); assert.doesNotMatch(JSON.stringify(limited), /private-token/);
});

test('ChatGPT cancellation aborts request and discards partial output', async t => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  let aborted = false;
  const chatgpt = {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async ({ signal }: { signal?: AbortSignal }) => new Promise<{ text: string }>((resolve) => { signal!.addEventListener('abort', () => { aborted = true; resolve({ text: JSON.stringify(output) }); }, { once: true }); started(); }),
  } as import('../src/chatgpt.js').ChatGptDraftClient;
  const service = new LocalAgentService({ chatgpt }); t.after(() => service.close());
  const job = service.start({ engine: 'chatgpt', model: 'eligible-model', prompt: 'Draft', document: empty, revision: 0 });
  await ready; service.cancel(job.id); await service.close();
  assert.equal(aborted, true); assert.equal(service.get(job.id)?.status, 'cancelled'); assert.equal(service.get(job.id)?.proposal, undefined);
});
