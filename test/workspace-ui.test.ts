import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderWorkspace } from '../src/workspace-ui.js';

test('the served workspace client parses and embeds its session token safely', () => {
  const csrf = 'session-token</script><script>unsafe()</script>';
  const html = renderWorkspace('nonce-test', csrf);
  const scripts = [...html.matchAll(/<script nonce="nonce-test">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0]![1]!));
  assert.doesNotMatch(html, /<script>unsafe/);
  assert.match(html, /session-token\\u003c/);
  assert.match(html, /name="jev-csrf" content="session-token&lt;/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

function browserHarness() {
  const documentValue = { version: 1, cohorts: [{ id: 'cohort', name: 'Original cohort', population: 'Adults', description: '', assumptions: [], sources: [], segments: [], personas: [{ id: 'person', label: 'Adult participant', age: 30, segment: 'general', weight: 1, background: 'Independent background', attributes: {}, sourceIds: [], syntheticFields: ['background'] }] }], pipelines: [{ id: 'study', name: 'Original study', description: '', stages: [{ id: 'panel', label: 'First question', kind: 'poll', cohort: 'audience', questions: { answer: { type: 'choice', label: 'Which option fits?', instructions: 'Choose an option.', criteria: { a: 'A', b: 'B' } } }, inputs: {}, dependsOn: [] }], cohorts: { audience: 'cohort' } }] };
  let snapshot = { revision: 1, document: documentValue, auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null };
  const elements = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const intervals: Function[] = [];
  const timeouts: Function[] = [];
  const requests: string[] = [];
  const bodies: Array<{ path: string; body: unknown }> = [];
  const responses = new Map<string, unknown>();
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, inert: false, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {}, open: false, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  }
  const context = {
    document: { getElementById: element, querySelectorAll: () => [], visibilityState: 'visible', addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    fetch: async (path: string, options?: { body?: string }) => { requests.push(path); if (options?.body) bodies.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => JSON.parse(JSON.stringify(await (responses.get(path) ?? snapshot))) }; },
    setTimeout: (fn: Function) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {}, setInterval: (fn: Function) => { intervals.push(fn); return 1; },
    navigator: {}, confirm: () => { throw new Error('Unexpected native confirmation'); },
  };
  const html = renderWorkspace('test', 'token');
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.clientTest={S,refresh,reloadSaved,applySnapshot,agents,copyAgentText,act,freshPipeline,addNextPhase,addPhaseInput,projectionOptions,dataInputOptions,startLocalJob,applyLocalProposal,proposalReview,graphEdgePath,drawStageEdges,cohortGenerator,startCohortJob,adoptCohortProposal,cohortProposalReview,canGenerateCohort,pollLocalJob,cancelLocalJob};})();');
  const sandbox = new Script(exposed).runInNewContext(context) as undefined;
  void sandbox;
  return {
    client: (context as typeof context & { clientTest: any }).clientTest,
    element, listeners, intervals, timeouts, requests, bodies, respond: (path: string, value: unknown) => responses.set(path, value),
    setSnapshot: (value: typeof snapshot) => { snapshot = value; },
    snapshot: () => structuredClone(snapshot),
    document: context.document,
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('agent saves refresh clean drafts and preserve valid editor selection without redrawing unchanged forms', async () => {
  const browser = browserHarness();
  await settle();
  const { S, refresh } = browser.client;
  S.tab = 'agents'; S.cohortId = 'cohort'; S.personId = 'person'; S.pipelineId = 'study'; S.stageId = 'panel';
  const snapshot = browser.snapshot();
  snapshot.revision = 2; snapshot.document.cohorts[0]!.name = 'Agent edited cohort';
  browser.setSnapshot(snapshot);
  await refresh();
  assert.equal(S.doc.cohorts[0].name, 'Agent edited cohort');
  assert.equal(S.revision, 2);
  assert.equal(S.cohortId, 'cohort'); assert.equal(S.personId, 'person');
  assert.equal(S.pipelineId, 'study'); assert.equal(S.stageId, 'panel');
  browser.element('app').innerHTML = 'current DOM including cursor and input state';
  await refresh();
  assert.equal(browser.element('app').innerHTML, 'current DOM including cursor and input state');
  snapshot.revision = 3; snapshot.document.cohorts = []; snapshot.document.pipelines = [];
  browser.setSnapshot(snapshot);
  await refresh();
  assert.equal(S.cohortId, null); assert.equal(S.personId, null);
  assert.equal(S.pipelineId, null); assert.equal(S.stageId, null);
});

test('agent saves preserve unsaved browser edits and require confirmation before replacing them', async () => {
  const browser = browserHarness();
  await settle();
  const { S, refresh, reloadSaved } = browser.client;
  S.dirty = true; S.doc.cohorts[0].name = 'My unsaved cohort';
  browser.element('app').innerHTML = 'typed fields not yet applied';
  const snapshot = browser.snapshot();
  snapshot.revision = 2; snapshot.document.cohorts[0]!.name = 'Agent edited cohort';
  browser.setSnapshot(snapshot);
  await refresh();
  assert.equal(S.revision, 1); assert.equal(S.doc.cohorts[0].name, 'My unsaved cohort');
  assert.equal(browser.element('app').innerHTML, 'typed fields not yet applied');
  assert.equal(browser.element('workspaceSync').hidden, false);
  assert.match(browser.element('workspaceSyncMessage').textContent, /Export your draft/);
  await reloadSaved();
  assert.equal(S.dirty, true); assert.equal(S.doc.cohorts[0].name, 'My unsaved cohort');
  assert.equal(browser.element('reloadDialog').open, true);
  browser.client.act(null, { dataset: { act: 'reload-saved-close' } });
  assert.equal(browser.element('reloadDialog').open, false);
  assert.equal(S.dirty, true); assert.equal(S.doc.cohorts[0].name, 'My unsaved cohort');
  await reloadSaved();
  browser.client.act(null, { dataset: { act: 'reload-saved-confirm' } });
  await settle();
  assert.equal(browser.element('reloadDialog').open, false);
  assert.equal(S.dirty, false); assert.equal(S.revision, 2);
  assert.equal(S.doc.cohorts[0].name, 'Agent edited cohort');
  assert.equal(browser.element('workspaceSync').hidden, true);
});

test('background sync pauses while hidden and agent configuration remains escaped and selectable', async () => {
  const browser = browserHarness();
  await settle();
  const requests = browser.requests.length;
  browser.document.visibilityState = 'hidden';
  browser.intervals[0]!();
  await settle();
  assert.equal(browser.requests.length, requests);
  browser.document.visibilityState = 'visible';
  browser.intervals[0]!();
  await settle();
  assert.equal(browser.requests.length, requests + 1);
  browser.client.S.agentConfig = { codexCommand: 'codex mcp add jev -- node </textarea><script>bad()</script>', claudeCommand: 'claude setup', mcpConfig: { mcpServers: {} }, guidePrompt: 'Prepare <personas> with sources.' };
  const html = browser.client.agents();
  assert.match(html, /Your agent prepares\. Jev evaluates\./);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  const field = browser.element('agentSetup');
  field.value = 'setup command'; let selected = false;
  field.select = () => { selected = true; };
  await browser.client.copyAgentText('agentSetup');
  assert.equal(selected, true, 'clipboard-denied fallback selects the setup text');
});

test('next phase wires a named output, keeps one question, and excludes downstream cycles from input choices', async () => {
  const browser = browserHarness();
  await settle();
  const { S, freshPipeline, addNextPhase, dataInputOptions, projectionOptions } = browser.client;
  const pipeline = freshPipeline('Which customer-support approach should we use?');
  S.doc.pipelines = [pipeline]; S.pipelineId = pipeline.id; S.stageId = pipeline.stages[0].id; S.tab = 'studies';
  addNextPhase();
  const next = pipeline.stages[1];
  assert.equal(pipeline.stages.length, 2);
  assert.equal(Object.keys(next.questions).length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(next.dependsOn)), ['panel']);
  assert.deepEqual(JSON.parse(JSON.stringify(next.inputs)), { previous_result: { stage: 'panel', question: 'preference', select: 'summary' } });
  assert.equal(next.cohort, pipeline.stages[0].cohort);
  assert.equal(dataInputOptions(pipeline, pipeline.stages[0]).length, 0, 'a later dependent phase cannot feed its ancestor');
  assert.equal(dataInputOptions(pipeline, next)[0].id, 'panel');
  assert.deepEqual(Array.from(projectionOptions(pipeline, next.inputs.previous_result), (x: any) => x.value), ['summary', 'responses', 'winner', 'probabilities']);
  assert.match(browser.element('app').innerHTML, /previous_result/);
  assert.match(browser.element('app').innerHTML, /Cohort of virtual people/);
  assert.match(browser.element('app').innerHTML, /Which customer-support approach/);
  pipeline.stages[0].questions.preference = { type: 'noul', label: 'Would this work?', instructions: 'Answer yes or no.' };
  assert.deepEqual(Array.from(projectionOptions(pipeline, next.inputs.previous_result), (x: any) => x.value), ['summary', 'responses', 'mean']);
});

test('local assistant submits saved revision and keeps proposal separate until explicit apply', async () => {
  const browser = browserHarness();
  await settle();
  const { S, startLocalJob, applyLocalProposal } = browser.client;
  S.tab = 'agents';
  S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', label: 'Codex', available: true }];
  S.localPrompt = 'Draft a pool for customer-support research using the facts I provided.';
  const proposal = browser.snapshot().document;
  proposal.cohorts[0]!.name = 'Proposed support pool';
  const job = { id: 'job-one', engine: 'codex', status: 'completed', revision: 1, message: 'Ready', proposal: { document: proposal, explanation: 'Added a proposal with explicit assumptions.' } };
  browser.respond('/api/agent/jobs', job);
  browser.respond('/api/agent/jobs/job-one/apply', { revision: 2, document: proposal });
  await startLocalJob();
  assert.equal(S.doc.cohorts[0].name, 'Original cohort', 'preparation never writes the draft');
  assert.equal(S.localJob.proposal.document.cohorts[0].name, 'Proposed support pool');
  assert.deepEqual(browser.bodies[0], { path: '/api/agent/jobs', body: { engine: 'codex', prompt: S.localPrompt, revision: 1 } });
  assert.equal(browser.requests.includes('/api/agent/jobs/job-one/apply'), false);
  assert.match(browser.element('app').innerHTML, /Apply proposal/);
  await applyLocalProposal();
  assert.equal(S.doc.cohorts[0].name, 'Proposed support pool');
  assert.equal(S.revision, 2);
  assert.equal(S.proposalApplied, true);
  assert.deepEqual(browser.bodies[1], { path: '/api/agent/jobs/job-one/apply', body: { revision: 1 } });
  assert.equal(browser.requests.some(path => path === '/api/run'), false, 'drafting and apply never run TypeSafe polls');
});

test('local assistant refuses unsaved work and stale proposals without posting mutations', async () => {
  const browser = browserHarness();
  await settle();
  const { S, startLocalJob, applyLocalProposal } = browser.client;
  S.localEngines = [{ id: 'codex', available: true }]; S.localPrompt = 'Prepare a pool'; S.dirty = true;
  await assert.rejects(startLocalJob(), /Save your changes/);
  S.dirty = false;
  S.localJob = { id: 'stale', engine: 'codex', status: 'completed', revision: 0, proposal: { document: browser.snapshot().document, explanation: 'Old proposal' } };
  await assert.rejects(applyLocalProposal(), /Workspace changed/);
  assert.equal(browser.bodies.length, 0);
  assert.match(browser.client.proposalReview(S.localJob), /Prepare a new proposal/);
});

test('proposal review itemizes removed cohorts and pipelines plus removals inside changed entities', async () => {
  const browser = browserHarness();
  await settle();
  const { S, proposalReview } = browser.client;
  const originalPool = S.doc.cohorts[0];
  const originalPipeline = S.doc.pipelines[0];
  S.doc.cohorts.push({ ...structuredClone(originalPool), id: 'removed-pool', name: 'Archived <audience>' });
  S.doc.pipelines.push({ ...structuredClone(originalPipeline), id: 'removed-pipeline', name: 'Retired study' });
  originalPool.personas.push({ ...structuredClone(originalPool.personas[0]), id: 'removed-person' });
  originalPipeline.stages.push({ ...structuredClone(originalPipeline.stages[0]), id: 'removed-phase' });
  const proposed = JSON.parse(JSON.stringify(S.doc));
  proposed.cohorts = [proposed.cohorts[0], { ...structuredClone(originalPool), id: 'added-pool', name: 'New audience' }];
  proposed.pipelines = [proposed.pipelines[0]];
  proposed.cohorts[0].personas.pop();
  proposed.pipelines[0].stages.pop();
  const html = proposalReview({ status: 'completed', revision: S.revision, proposal: { document: proposed, explanation: 'Reshape the audience and flow.' } });
  assert.match(html, /Cohorts: 1 added · 1 changed · 1 removed/);
  assert.match(html, /Pipelines: 0 added · 1 changed · 1 removed/);
  assert.match(html, /Removed cohort: <strong>Archived &lt;audience&gt;<\/strong> <code>\(removed-pool\)<\/code> · 1 personas removed/);
  assert.match(html, /Removed pipeline: <strong>Retired study<\/strong> <code>\(removed-pipeline\)<\/code> · 1 phases removed/);
  assert.match(html, /Changed cohort:.*1 personas removed/);
  assert.match(html, /Changed pipeline:.*1 phases removed/);
  assert.match(html, /including the removals listed below/);
  assert.match(html, /Apply proposal/);
  assert.equal(S.doc.cohorts.length, 2, 'review preserves original workspace until explicit apply');
});

test('skip-phase edges cross reserved gutter above intermediate cards and finish outside target border', async () => {
  const browser = browserHarness();
  await settle();
  const box = { left: 10, top: 20 };
  const source = { left: 10, right: 258, top: 64, bottom: 244, width: 248, height: 180 };
  const middle = { left: 306, right: 554, top: 64, bottom: 244, width: 248, height: 180 };
  const target = { left: 602, right: 850, top: 64, bottom: 244, width: 248, height: 180 };
  const path = browser.client.graphEdgePath(source, target, box, 0);
  const points = [...path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map(match => ({ x: Number(match[1]) + box.left, y: Number(match[2]) + box.top }));
  assert.equal(points.length, 6);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const intersectsX = Math.max(a.x, b.x) > middle.left && Math.min(a.x, b.x) < middle.right;
    const intersectsY = Math.max(a.y, b.y) > middle.top && Math.min(a.y, b.y) < middle.bottom;
    assert.equal(intersectsX && intersectsY, false, 'skip route must not run behind intermediate phase');
  }
  assert.ok(points[2]!.y < middle.top && points[3]!.y < middle.top);
  assert.equal(points.at(-1)!.x, target.left - 3, 'arrowhead remains visible before the destination border');
  assert.match(browser.client.graphEdgePath(source, middle, box), / C /, 'adjacent phases retain curved direct edges');
});

test('cohort prompt generation scopes the request and previews personas without saving', async () => {
  const browser = browserHarness(); await settle();
  const { S, startCohortJob, adoptCohortProposal, cohortProposalReview } = browser.client;
  S.tab = 'cohorts'; S.cohortComposer = true; S.cohortTarget = 'new-audience';
  S.cohortPrompt = 'Adult weekend museum visitors with varied experience.'; S.cohortSize = 2;
  S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', label: 'Codex', available: true }];
  const original = structuredClone(S.doc);
  const candidate = { ...structuredClone(S.doc.cohorts[0]), id: 'new-audience', name: 'Museum visitors', generationPrompt: S.cohortPrompt };
  candidate.personas = [candidate.personas[0], { ...candidate.personas[0], id: 'second', label: 'Frequent visitor', age: 42 }];
  const job = { id: 'cohort-job', engine: 'codex', revision: S.revision, status: 'completed', cohort: { id: candidate.id, size: 2, prompt: S.cohortPrompt }, proposal: { document: { ...structuredClone(S.doc), cohorts: [...S.doc.cohorts, candidate] }, explanation: 'Fictional personas with assumed weights.' } };
  browser.respond('/api/agent/jobs', job);
  await startCohortJob();
  assert.deepEqual(JSON.parse(JSON.stringify(browser.bodies.at(-1)!.body)), { engine: 'codex', prompt: S.cohortPrompt, revision: S.revision, cohort: { id: 'new-audience', size: 2 } });
  assert.equal(JSON.stringify(S.doc), JSON.stringify(original), 'generation cannot modify the workspace draft');
  const review = cohortProposalReview(S.localJob);
  assert.match(review, /Frequent visitor/); assert.match(review, /Review and edit cohort/);
  assert.doesNotMatch(review, /Apply proposal/);
  adoptCohortProposal();
  assert.equal(S.cohortId, 'new-audience'); assert.equal(S.dirty, true); assert.equal(S.cohortComposer, false);
  assert.equal(JSON.stringify(S.doc.pipelines), JSON.stringify(original.pipelines)); assert.equal(JSON.stringify(S.doc.cohorts[0]), JSON.stringify(original.cohorts[0]));
  assert.equal(S.doc.cohorts[1].generationPrompt, job.cohort.prompt);
  assert.equal(browser.bodies.filter(x => x.path === '/api/workspace' || x.path.endsWith('/apply')).length, 0, 'review adoption stays local until explicit save');
});

test('cohort generation preserves unsaved edits and rejects stale proposal adoption', async () => {
  const browser = browserHarness(); await settle();
  const { S, startCohortJob, adoptCohortProposal, canGenerateCohort } = browser.client;
  S.cohortPrompt = 'Synthetic adult hikers'; S.cohortSize = 3; S.localEngines = [{ id: 'codex', available: true }];
  S.dirty = true;
  await assert.rejects(startCohortJob(), /Save your changes/);
  assert.equal(browser.bodies.length, 0);
  S.dirty = false; S.cohortSize = 0; assert.equal(canGenerateCohort(), false);
  S.cohortSize = 3;
  S.localJob = { status: 'completed', revision: S.revision, cohort: { id: 'cohort', size: 1, prompt: S.cohortPrompt }, proposal: { document: structuredClone(S.doc), explanation: 'Draft' } };
  S.remoteRevision = S.revision + 1;
  assert.equal(canGenerateCohort(), false);
  await assert.rejects(startCohortJob(), /Reload the saved workspace/);
  assert.throws(adoptCohortProposal, /Workspace changed/);
  assert.equal(S.doc.cohorts[0].name, 'Original cohort'); assert.equal(S.dirty, false);
});


test('late polling from a cancelled job cannot replace or block a newer generation', async () => {
  const browser = browserHarness(); await settle();
  const { S, pollLocalJob, cancelLocalJob } = browser.client;
  const first = { id: 'first', status: 'running', revision: S.revision };
  let finishOldPoll!: (value: unknown) => void;
  browser.respond('/api/agent/jobs/first', new Promise(resolve => { finishOldPoll = resolve; }));
  browser.respond('/api/agent/jobs/first/cancel', { ...first, status: 'cancelled' });
  S.localJob = first;
  const oldPolling = pollLocalJob('first');
  browser.timeouts.shift()!(); await settle();
  await cancelLocalJob();
  assert.equal(S.localJob.status, 'cancelled');
  const second = { id: 'second', status: 'running', revision: S.revision };
  S.localJob = second;
  browser.respond('/api/agent/jobs/second', { ...second, status: 'completed' });
  const newPolling = pollLocalJob('second');
  finishOldPoll({ ...first, status: 'running' });
  await oldPolling;
  assert.equal(S.localJob.id, 'second');
  browser.timeouts.shift()!();
  await newPolling;
  assert.equal(S.localJob.id, 'second');
  assert.equal(S.localJob.status, 'completed');
});


test('ChatGPT drafting requires explicit model and carries selected model without changing TypeSafe connection', async () => {
  const browser = browserHarness(); await settle();
  const { S, startLocalJob, canGenerateCohort, agents } = browser.client;
  S.tab = 'agents'; S.localEngine = 'chatgpt'; S.localEngines = [{ id: 'chatgpt', label: 'ChatGPT subscription', available: true }];
  S.chatgpt = { connected: true, planEnabled: true, account: { id: 'one', label: '<unsafe account>' }, accounts: [] };
  S.localPrompt = 'Draft a synthetic cohort'; S.cohortPrompt = S.localPrompt; S.cohortSize = 2;
  assert.equal(canGenerateCohort(), false); await assert.rejects(startLocalJob(), /Choose an available drafting provider/);
  S.chatgptModels = [{ id: 'model-one', name: 'Model One' }]; S.chatgptModel = 'model-one';
  assert.equal(canGenerateCohort(), true);
  const html = agents(); assert.match(html, /&lt;unsafe account&gt;/); assert.match(html, /TypeSafe and its separate billing/);
  browser.respond('/api/agent/jobs', { id: 'chatgpt-job', engine: 'chatgpt', status: 'failed', revision: S.revision, message: 'Test complete' });
  await startLocalJob();
  assert.deepEqual(browser.bodies.at(-1), { path: '/api/agent/jobs', body: { engine: 'chatgpt', model: 'model-one', prompt: S.localPrompt, revision: S.revision } });
  assert.equal(S.snap.auth.configured, true); assert.equal(browser.requests.includes('/api/run'), false);
});
