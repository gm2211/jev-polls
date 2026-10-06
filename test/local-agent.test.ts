import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process';
import { LocalAgentError, LocalAgentService, type LocalAgentJob, type LocalAgentSpawner } from '../src/local-agent.js';
import type { ChatGptDraftClient } from '../src/chatgpt.js';
import type { Cohort, DistributionTargetBucket, Persona } from '../src/types.js';
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
function cohortBatchResponse(input: string): string {
  const marker = 'Request data:\n';
  const request = JSON.parse(input.slice(input.lastIndexOf(marker) + marker.length)) as { batch: { size: number; firstPosition: number; number: number } };
  const cohort = structuredClone(proposed.cohorts[0]!);
  cohort.personas = Array.from({ length: request.batch.size }, (_, index) => ({
    ...structuredClone(proposed.cohorts[0]!.personas[0]!),
    id: `batch-${request.batch.number}-${index + 1}`,
    label: `Persona ${request.batch.firstPosition + index}`,
    background: `Distinct synthetic adult profile ${request.batch.firstPosition + index}`,
  }));
  return JSON.stringify({ ...output, documentJson: JSON.stringify(cohort) });
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
  const data = { ...output, documentJson: JSON.stringify(generated.cohorts[0]!) };
  const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(async ({ args, child }) => {
    assert.match(child.input, /Never run a study, invoke TypeSafe/);
    assert.match(child.input, /do not invent sources/);
    assert.match(child.input, /cohort customers/);
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

test('cohort drafts reject wrong batch counts and invalid cohort output', async t => {
  const root = await setup(t);
  const current: WorkspaceDocument = { version: 1, cohorts: [{ ...structuredClone(proposed.cohorts[0]!), id: 'other' }], pipelines: [] };
  const wrongCount = structuredClone(proposed.cohorts[0]!);
  const wrongId = structuredClone(proposed.cohorts[0]!); wrongId.id = 'unexpected';
  const invalid = structuredClone(proposed.cohorts[0]!); invalid.segments = [];
  const cases: Array<{ name: string; cohort: unknown }> = [
    { name: 'wrong target count', cohort: wrongCount },
    { name: 'wrong target ID', cohort: wrongId },
    { name: 'invalid target cohort', cohort: invalid },
  ];
  for (const item of cases) {
    const service = new LocalAgentService({ temporaryRoot: root, spawn: fakeSpawner(async ({ args, child }) => { await writeFile(args[args.indexOf('--output-last-message') + 1]!, JSON.stringify({ ...output, documentJson: JSON.stringify(item.cohort) })); child.finish(); }) });
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
    generate: async (request: { input: string; model: string; signal?: AbortSignal }) => {
      calls.push(request);
      const documentJson = request.input.includes('Request data:\n') ? JSON.stringify(proposed.cohorts[0]) : output.documentJson;
      return { text: JSON.stringify({ ...output, documentJson }) };
    },
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

test('ChatGPT cohort drafts batch 100 and 101 personas with a custom model and reject counts above the workspace limit', async t => {
  const calls: Array<{ model: string; input: string }> = [];
  const chatgpt = {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async (request: { input: string; model: string }) => {
      calls.push(request);
      return { text: cohortBatchResponse(request.input) };
    },
  } as ChatGptDraftClient;
  const service = new LocalAgentService({ chatgpt, spawn: () => { throw Error('CLI must not start'); } });
  t.after(() => service.close());

  const hundred = await terminal(service, service.start({ engine: 'chatgpt', model: 'gpt-6.1-sol', prompt: 'Create one hundred adults', document: empty, revision: 12, cohort: { id: 'customers', size: 100 } }));
  assert.equal(hundred.status, 'completed');
  assert.equal(hundred.proposal?.document.cohorts[0]?.personas.length, 100);
  assert.equal(hundred.proposal?.document.cohorts[0]?.generationPrompt, 'Create one hundred adults');
  assert.equal(hundred.proposal?.document.cohorts[0]?.personas[99]?.id, 'persona-00100');
  assert.equal(calls.slice(0, 4).length, 4);
  assert.ok(calls.slice(0, 4).every(call => call.model === 'gpt-6.1-sol'));
  assert.match(calls[0]?.input ?? '', /batch 1 of 4/);
  assert.match(calls[3]?.input ?? '', /exactly 25 new personas/);

  const hundredOne = await terminal(service, service.start({ engine: 'chatgpt', model: 'gpt-6.1-sol', prompt: 'Create one hundred and one adults', document: empty, revision: 13, cohort: { id: 'customers', size: 101 } }));
  assert.equal(hundredOne.status, 'completed');
  assert.equal(hundredOne.proposal?.document.cohorts[0]?.personas.length, 101);
  assert.ok(calls.slice(4).every(call => call.model === 'gpt-6.1-sol'));
  assert.match(calls[8]?.input ?? '', /exactly 1 new personas/);
  assert.throws(
    () => service.start({ engine: 'chatgpt', model: 'gpt-6.1-sol', prompt: 'Too many', document: empty, revision: 14, cohort: { id: 'customers', size: 20_001 } }),
    (error: unknown) => error instanceof LocalAgentError && error.code === 'INVALID_AGENT_REQUEST',
  );
});

test('cohort batch failures and cancellation never publish partial proposals', async t => {
  const root = await setup(t);
  let failedCalls = 0;
  const failing = new LocalAgentService({ chatgpt: {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async ({ input }: { input: string }) => {
      failedCalls++;
      if (failedCalls === 2) throw Object.assign(Error('private quota detail'), { code: 'quota' });
      return { text: cohortBatchResponse(input) };
    },
  } as ChatGptDraftClient });
  const failed = await terminal(failing, failing.start({ engine: 'chatgpt', model: 'gpt-6.1-sol', prompt: 'Create 30 adults', document: empty, revision: 1, cohort: { id: 'customers', size: 30 } }));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.proposal, undefined);
  assert.match(failed.message, /usage limit/);
  assert.equal(failedCalls, 2);
  await failing.close();

  let secondBatchStarted!: () => void;
  const secondBatch = new Promise<void>(resolve => { secondBatchStarted = resolve; });
  let cancelCalls = 0;
  const cancelling = new LocalAgentService({ chatgpt: {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async ({ input, signal }: { input: string; signal?: AbortSignal }) => {
      cancelCalls++;
      if (cancelCalls === 1) return { text: cohortBatchResponse(input) };
      secondBatchStarted();
      return new Promise(resolve => signal!.addEventListener('abort', () => resolve({ text: cohortBatchResponse(input) }), { once: true }));
    },
  } as ChatGptDraftClient });
  const job = cancelling.start({ engine: 'chatgpt', model: 'gpt-6.1-sol', prompt: 'Create 30 adults', document: empty, revision: 2, cohort: { id: 'customers', size: 30 } });
  await secondBatch;
  assert.match(cancelling.get(job.id)?.message ?? '', /25\/30 personas/);
  assert.equal(cancelling.get(job.id)?.proposal, undefined);
  assert.equal(cancelling.cancel(job.id)?.status, 'cancelled');
  await cancelling.close();
  assert.equal(cancelling.get(job.id)?.proposal, undefined);
  assert.equal(cancelCalls, 2);
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


function personaWorkspace(size = 4): WorkspaceDocument {
  const document = structuredClone(proposed);
  const cohort = document.cohorts[0]!;
  cohort.generationPrompt = 'Saved question-independent audience brief';
  cohort.personas = Array.from({ length: size }, (_, index) => ({ ...structuredClone(cohort.personas[0]!), id: `saved-${index}`, label: `Saved person ${index}`, attributes: { preserved: index }, background: `Saved background ${index}`, weight: index + 1 }));
  document.cohorts.push({ ...structuredClone(cohort), id: 'unrelated', name: 'Keep exact cohort' });
  document.pipelines.push({ version: 1, id: 'study', name: 'Keep exact pipeline', description: '', context: { retained: true }, cohorts: { audience: cohort.id }, stages: [] });
  return document;
}

function nativeDraft(generate: (input: string, signal?: AbortSignal) => Promise<string> | string): ChatGptDraftClient {
  return { status: async () => ({ connected: true, planEnabled: true }), generate: async ({ input, signal }: { input: string; signal?: AbortSignal }) => ({ text: await generate(input, signal) }) } as ChatGptDraftClient;
}
const personaRequest = { engine: 'chatgpt' as const, model: 'draft-model', prompt: 'Regenerate this whole synthetic persona', revision: 19, persona: { cohortId: 'customers', personaId: 'saved-1' } };

function requestData(input: string): any { const marker = 'Request data:\n'; return JSON.parse(input.slice(input.lastIndexOf(marker) + marker.length)); }

test('whole-person regeneration replaces only the selected persona and supplies bounded context for large cohorts', async t => {
  const original = personaWorkspace(800);
  const replacement: Persona = { ...structuredClone(original.cohorts[0]!.personas[1]!), label: 'New synthetic person', age: 52, background: 'A newly assumed and neutral background', attributes: { work: { schedule: 'evenings' } }, syntheticFields: ['label', 'age', 'background', 'attributes'] };
  let calls = 0;
  const service = new LocalAgentService({ chatgpt: nativeDraft(input => {
    calls++;
    const context = requestData(input);
    assert.equal(context.selectedPersona.id, 'saved-1');
    assert.ok(context.neighboringExamples.length <= 4);
    assert.equal(context.cohortMetadata.personas, undefined);
    assert.doesNotMatch(input, /saved-799|Keep exact pipeline|Keep exact cohort/);
    assert.ok(Buffer.byteLength(input) < 120_000);
    return JSON.stringify({ documentJson: JSON.stringify(replacement), explanation: 'Replaced this whole synthetic persona with new assumed details.' });
  }) }); t.after(() => service.close());
  const job = service.start({ ...personaRequest, document: original });
  assert.deepEqual(job.persona, personaRequest.persona);
  const completed = await terminal(service, job);
  assert.equal(completed.status, 'completed'); assert.equal(completed.revision, 19); assert.equal(calls, 1);
  const expected = structuredClone(original); expected.cohorts[0]!.personas[1] = replacement;
  assert.deepEqual(completed.proposal?.document, expected);
  assert.equal(original.cohorts[0]!.personas[1]!.label, 'Saved person 1');
});

test('persona regeneration rejects malformed, underage, mismatched and unrelated responses without proposals', async t => {
  const original = personaWorkspace();
  const selected = original.cohorts[0]!.personas[1]!;
  const cases: unknown[] = [null, original, original.cohorts[0], { ...selected, id: 'another' }, { ...selected, segment: 'other' }, { ...selected, weight: 9 }, { ...selected, age: 17 }, { ...selected, age: 122 }, { ...selected, sourceIds: ['invented'] }, { ...selected, cohorts: [] }];
  for (const candidate of cases) {
    const service = new LocalAgentService({ chatgpt: nativeDraft(() => JSON.stringify({ documentJson: JSON.stringify(candidate), explanation: 'Replacement proposal' })) });
    const completed = await terminal(service, service.start({ ...personaRequest, document: original }));
    assert.equal(completed.status, 'failed', JSON.stringify(candidate)); assert.equal(completed.proposal, undefined);
    await service.close();
  }
  const service = new LocalAgentService({ chatgpt: nativeDraft(() => { throw Error('must not run'); }) }); t.after(() => service.close());
  assert.throws(() => service.start({ ...personaRequest, document: original, cohort: { id: 'customers', size: 4 } }), /valid cohort metadata/);
  assert.throws(() => service.start({ ...personaRequest, document: original, persona: { cohortId: 'missing', personaId: 'saved-1' } }), /existing persona/);
  assert.throws(() => service.start({ ...personaRequest, document: original, persona: { cohortId: 'customers', personaId: 'missing' } }), /existing persona/);
});

test('persona regeneration accepts existing evidence and rejects provider failure and late cancellation output', async t => {
  const document = personaWorkspace();
  document.cohorts[0]!.sources = [{ id: 'existing', title: 'Existing evidence', url: 'https://example.org/evidence', retrievedAt: '2026-10-04T12:00:00Z', notes: 'Supports this supplied context only.' }];
  const selected = { ...document.cohorts[0]!.personas[1]!, sourceIds: ['existing'] };
  const service = new LocalAgentService({ chatgpt: nativeDraft(() => JSON.stringify({ documentJson: JSON.stringify(selected), explanation: 'Reuses supplied evidence without a research claim.' })) }); t.after(() => service.close());
  assert.equal((await terminal(service, service.start({ ...personaRequest, document }))).status, 'completed');
  const failing = new LocalAgentService({ chatgpt: nativeDraft(() => { throw Object.assign(Error('private account detail'), { code: 'quota' }); }) });
  const failed = await terminal(failing, failing.start({ ...personaRequest, document }));
  assert.equal(failed.status, 'failed'); assert.match(failed.message, /usage limit/); assert.doesNotMatch(JSON.stringify(failed), /private account/); assert.equal(failed.proposal, undefined); await failing.close();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const cancelled = new LocalAgentService({ chatgpt: nativeDraft((_input, signal) => new Promise(resolve => { signal!.addEventListener('abort', () => resolve(JSON.stringify({ documentJson: JSON.stringify(selected), explanation: 'Late output' })), { once: true }); started(); })) });
  const job = cancelled.start({ ...personaRequest, document }); await ready; cancelled.cancel(job.id); await cancelled.close();
  assert.equal(cancelled.get(job.id)?.status, 'cancelled'); assert.equal(cancelled.get(job.id)?.proposal, undefined);
});

function targetedBatchResponse(input: string, mutate?: (cohort: Cohort, data: any) => void): string {
  const data = requestData(input);
  const cohort = { ...structuredClone(data.originalCohortMetadata), personas: [] } as Cohort;
  cohort.personas = data.distributionAssignments.map((slot: any, index: number) => {
    const persona = { ...structuredClone(proposed.cohorts[0]!.personas[0]!), id: `batch-${data.batch.number}-${index}`, attributes: {} } as Persona;
    slot.assignments.forEach(({ field, kind, bucket }: { field: string; kind: string; bucket: DistributionTargetBucket }) => {
      const value = kind === 'numeric' ? (bucket.min ?? ((bucket.max ?? 100) - 1)) : bucket.value;
      if (field === 'age') persona.age = value as number;
      else if (field === 'segment') persona.segment = value as string;
      else { const parts = field.slice('attributes.'.length).split('.'); let target: any = persona.attributes; for (const part of parts.slice(0, -1)) target = target[part] ??= {}; target[parts.at(-1)!] = value; }
    });
    return persona;
  });
  mutate?.(cohort, data);
  return JSON.stringify({ documentJson: JSON.stringify(cohort), explanation: 'Synthetic personas follow supplied slots.' });
}

test('cohort regeneration honors exact categorical and numeric target quotas across batches and preserves provenance', async t => {
  const document = personaWorkspace();
  const cohort = document.cohorts[0]!;
  cohort.segments.push({ ...cohort.segments[0]!, id: 'occasional', label: 'Occasional', weight: 0.3, weightBasis: 'user' });
  cohort.sources = [{ id: 'existing', title: 'Existing evidence', url: 'https://example.org/evidence', retrievedAt: '2026-10-04T12:00:00Z', notes: 'Supplied source limitations remain.' }];
  cohort.distributionTargets = [
    { field: 'age', kind: 'numeric', buckets: [{ label: 'Younger', percent: 33.3, min: 18, max: 40 }, { label: 'Older', percent: 66.7, min: 40, max: 121 }] },
    { field: 'segment', kind: 'categorical', buckets: [{ label: 'Customers', percent: 70, value: 'customers' }, { label: 'Occasional', percent: 30, value: 'occasional' }] },
    { field: 'attributes.location.region', kind: 'categorical', buckets: [{ label: 'East', percent: 50, value: 'east' }, { label: 'West', percent: 50, value: 'west' }] },
  ];
  const calls: any[] = [];
  const service = new LocalAgentService({ chatgpt: nativeDraft(input => { calls.push(requestData(input)); return targetedBatchResponse(input); }) }); t.after(() => service.close());
  const completed = await terminal(service, service.start({ ...personaRequest, persona: undefined, cohort: { id: 'customers', size: 101 }, document }));
  assert.equal(completed.status, 'completed', completed.message); assert.equal(calls.length, 5);
  const result = completed.proposal!.document.cohorts[0]!;
  assert.equal(result.personas.length, 101); assert.equal(result.personas.filter(p => p.age < 40).length, 34);
  assert.equal(result.personas.filter(p => p.segment === 'customers').length, 71); assert.equal(result.personas.filter(p => p.segment === 'occasional').length, 30);
  assert.equal(result.personas.filter(p => (p.attributes.location as any).region === 'east').length, 51);
  assert.deepEqual(result.sources, cohort.sources); assert.deepEqual(result.segments, cohort.segments); assert.deepEqual(result.distributionTargets, cohort.distributionTargets);
  assert.deepEqual(completed.proposal!.document.cohorts[1], document.cohorts[1]); assert.deepEqual(completed.proposal!.document.pipelines, document.pipelines);
  assert.match(completed.proposal!.explanation, /whole-person quotas/);
  assert.deepEqual(calls.flatMap(data => data.distributionAssignments.map((slot: any) => slot.position)), Array.from({ length: 101 }, (_, index) => index + 1));
});

test('cohort regeneration rejects target mismatches, changed provenance and exclusive numeric upper bounds', async t => {
  const document = personaWorkspace();
  document.cohorts[0]!.distributionTargets = [{ field: 'age', kind: 'numeric', buckets: [{ label: 'Young', percent: 100, min: 18, max: 40 }] }];
  const mutations = [
    (cohort: Cohort) => { cohort.personas[0]!.age = 40; },
    (cohort: Cohort) => { cohort.sources = [{ id: 'invented', title: 'Invented', url: 'https://example.org/imaginary', retrievedAt: '2026-10-04T12:00:00Z', notes: 'Invented claims' }]; },
    (cohort: Cohort) => { cohort.segments[0]!.weightBasis = 'user'; },
    (cohort: Cohort) => { cohort.distributionTargets = []; },
  ];
  for (const mutate of mutations) {
    const service = new LocalAgentService({ chatgpt: nativeDraft(input => targetedBatchResponse(input, mutate)) });
    const failed = await terminal(service, service.start({ ...personaRequest, persona: undefined, document, cohort: { id: 'customers', size: 30 } }));
    assert.equal(failed.status, 'failed'); assert.equal(failed.proposal, undefined); assert.match(failed.message, /distribution target|metadata or provenance/); await service.close();
  }
});


test('targeted cohort regeneration never publishes partial quotas after later provider failure or cancellation', async () => {
  const document = personaWorkspace();
  document.cohorts[0]!.distributionTargets = [{ field: 'age', kind: 'numeric', buckets: [{ label: 'Adults', percent: 100, min: 18, max: 121 }] }];
  let calls = 0;
  const failing = new LocalAgentService({ chatgpt: nativeDraft(input => { calls++; if (calls === 2) throw Object.assign(Error('private transport detail'), { code: 'quota' }); return targetedBatchResponse(input); }) });
  const failed = await terminal(failing, failing.start({ ...personaRequest, persona: undefined, document, cohort: { id: 'customers', size: 30 } }));
  assert.equal(failed.status, 'failed'); assert.equal(calls, 2); assert.equal(failed.proposal, undefined); assert.match(failed.message, /usage limit/); await failing.close();
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; }); let cancelCalls = 0;
  const cancelled = new LocalAgentService({ chatgpt: nativeDraft((input, signal) => { cancelCalls++; if (cancelCalls === 1) return targetedBatchResponse(input); started(); return new Promise(resolve => signal!.addEventListener('abort', () => resolve(targetedBatchResponse(input)), { once: true })); }) });
  const job = cancelled.start({ ...personaRequest, persona: undefined, document, cohort: { id: 'customers', size: 30 } }); await ready;
  assert.match(cancelled.get(job.id)!.message, /25\/30 personas/); cancelled.cancel(job.id); await cancelled.close();
  assert.equal(cancelled.get(job.id)?.status, 'cancelled'); assert.equal(cancelled.get(job.id)?.proposal, undefined); assert.equal(cancelCalls, 2);
});


test('segment target quotas fail before provider drafting when positive segments receive zero people or unknown IDs', async () => {
  const document = personaWorkspace();
  const cohort = document.cohorts[0]!;
  cohort.segments.push({ ...cohort.segments[0]!, id: 'second', label: 'Second', weight: 1 });
  const cases = [
    { size: 2, buckets: [{ label: 'Only first', value: 'customers', percent: 100 }], message: /positive-weight segment "second".*target share or cohort size/ },
    { size: 2, buckets: [{ label: 'First', value: 'customers', percent: 99 }, { label: 'Second', value: 'second', percent: 1 }], message: /positive-weight segment "second"/ },
    { size: 2, buckets: [{ label: 'Unknown', value: 'unknown', percent: 100 }], message: /existing segment IDs/ },
    { size: 1, buckets: [{ label: 'First', value: 'customers', percent: 50 }, { label: 'Second', value: 'second', percent: 50 }], message: /smaller than.*positive-weight segments/ },
  ];
  for (const item of cases) {
    cohort.distributionTargets = [{ field: 'segment', kind: 'categorical', buckets: item.buckets }]; let calls = 0;
    const service = new LocalAgentService({ chatgpt: nativeDraft(() => { calls++; throw Error('No provider request for impossible quotas'); }) });
    const failed = await terminal(service, service.start({ ...personaRequest, persona: undefined, document, cohort: { id: 'customers', size: item.size } }));
    assert.equal(failed.status, 'failed'); assert.equal(failed.proposal, undefined); assert.match(failed.message, item.message); assert.equal(calls, 0); await service.close();
  }
});

test('final missing positive segment reports how to fix the cohort instead of an opaque parse failure', async () => {
  const document = personaWorkspace(); document.cohorts[0]!.segments.push({ ...document.cohorts[0]!.segments[0]!, id: 'second', label: 'Second', weight: 1 });
  const service = new LocalAgentService({ chatgpt: nativeDraft(input => targetedBatchResponse(input)) });
  const failed = await terminal(service, service.start({ ...personaRequest, persona: undefined, document, cohort: { id: 'customers', size: 2 } }));
  assert.equal(failed.status, 'failed'); assert.equal(failed.proposal, undefined); assert.match(failed.message, /No personas were generated for positive-weight segment "second"/); assert.match(failed.message, /Increase.*revise segment target shares/); await service.close();
});
