import { MAX_COHORT_PERSONAS } from '../src/limits.js';
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

function browserHarness(openExistingProject = true) {
  const documentValue = { version: 1, cohorts: [{ id: 'cohort', name: 'Original cohort', population: 'Adults', description: '', assumptions: [], sources: [], segments: [], personas: [{ id: 'person', label: 'Adult participant', age: 30, segment: 'general', weight: 1, background: 'Independent background', attributes: {}, sourceIds: [], syntheticFields: ['background'] }] }], pipelines: [{ id: 'study', name: 'Original study', description: '', stages: [{ id: 'panel', label: 'First question', kind: 'poll', cohort: 'audience', questions: { answer: { type: 'choice', label: 'Which option fits?', instructions: 'Choose an option.', criteria: { a: 'A', b: 'B' } } }, inputs: {}, dependsOn: [] }], cohorts: { audience: 'cohort' } }] };
  let snapshot = { revision: 1, document: documentValue, auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null };
  const elements = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const intervals: Function[] = [];
  const timeouts: Function[] = [];
  const requests: string[] = [];
  const bodies: Array<{ path: string; body: unknown }> = [];
  const responses = new Map<string, unknown>();
  const storage = new Map<string, string>();
  class TestFormData {
    constructor(private readonly form: any) {}
    has(name: string) { return Object.prototype.hasOwnProperty.call(this.form.values ?? {}, name); }
    get(name: string) { const value = this.form.values?.[name]; return Array.isArray(value) ? value[0] ?? null : value ?? null; }
    getAll(name: string) { const value = this.form.values?.[name]; return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
  }
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, inert: false, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {}, open: false, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  }
  const context = {
    location: { origin: "http://127.0.0.1:4180" },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    document: { getElementById: element, querySelectorAll: () => [], visibilityState: 'visible', addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    fetch: async (path: string, options?: { body?: string }) => { requests.push(path); if (options?.body) bodies.push({ path, body: JSON.parse(options.body) }); return { ok: true, json: async () => JSON.parse(JSON.stringify(await (responses.get(path) ?? snapshot))) }; },
    setTimeout: (fn: Function) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {}, setInterval: (fn: Function) => { intervals.push(fn); return 1; },
    navigator: {}, URL, confirm: () => { throw new Error('Unexpected native confirmation'); },
    FormData: TestFormData,
  };
  const html = renderWorkspace('test', 'token');
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.clientTest={S,reviewPlan,selectProject,project,projectCohorts,projectPipelines,projectRuns,projects,render,refresh,reloadSaved,applySnapshot,agents,copyAgentText,act,freshPipeline,addNextPhase,addPhaseInput,projectionOptions,dataInputOptions,startLocalJob,applyLocalProposal,proposalReview,graphEdgePath,drawStageEdges,cohortGenerator,startCohortJob,adoptCohortProposal,cohortProposalReview,canGenerateCohort,pollLocalJob,cancelLocalJob,cohorts,cohortCard,deleteCohortFromDraft,loadChatGpt,loadLocalAgents,cohortBlockReason,cohortExplorer,personaDetail,explorerAction,cohortDistributions,targetEditor,startPersonaJob,adoptPersonaProposal,segmentShares,applySegmentShares};})();');
  const sandbox = new Script(exposed).runInNewContext(context) as undefined;
  void sandbox;
  if (openExistingProject) (context as any).clientTest.S.projectId = 'existing-research';
  return {
    client: (context as typeof context & { clientTest: any }).clientTest,
    element, listeners, intervals, timeouts, requests, bodies, storage, respond: (path: string, value: unknown) => responses.set(path, value),
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
  S.doc.pipelines = [pipeline]; S.doc.projects[0].pipelineIds = [pipeline.id]; S.pipelineId = pipeline.id; S.stageId = pipeline.stages[0].id; S.tab = 'studies';
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
  assert.deepEqual(browser.bodies[0], { path: '/api/agent/jobs', body: { projectId: 'existing-research', engine: 'codex', prompt: S.localPrompt, revision: 1 } });
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
  assert.deepEqual(JSON.parse(JSON.stringify(browser.bodies.at(-1)!.body)), { projectId: 'existing-research', engine: 'codex', prompt: S.cohortPrompt, revision: S.revision, cohort: { id: 'new-audience', size: 2 } });
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
  assert.deepEqual(browser.bodies.at(-1), { path: '/api/agent/jobs', body: { projectId: 'existing-research', engine: 'chatgpt', model: 'model-one', prompt: S.localPrompt, revision: S.revision } });
  assert.equal(S.snap.auth.configured, true); assert.equal(browser.requests.includes('/api/run'), false);
});


test('cohort deletion names the target, preserves cancel, and detaches only affected phases before explicit save', async () => {
  const browser = browserHarness(); await settle();
  const { S, act, cohortCard } = browser.client;
  S.doc.cohorts.push({ ...structuredClone(S.doc.cohorts[0]), id: 'keep', name: 'Keep cohort' });
  S.doc.pipelines[0].cohorts.other = 'keep';
  S.doc.pipelines[0].stages.push({ ...structuredClone(S.doc.pipelines[0].stages[0]), id: 'other-panel', cohort: 'other' });
  S.cohortId = 'keep'; S.preferredCohortId = 'cohort';
  const before = JSON.stringify(S.doc);
  assert.match(cohortCard(S.doc.cohorts[0]), /data-act="delete-cohort" data-id="cohort"/);
  act(null, { dataset: { act: 'delete-cohort', id: 'cohort' } });
  assert.equal(browser.element('deleteCohortDialog').open, true);
  assert.match(browser.element('deleteCohortDescription').textContent, /Original cohort/);
  assert.match(browser.element('deleteCohortUsage').textContent, /Original study/);
  assert.equal(JSON.stringify(S.doc), before);
  act(null, { dataset: { act: 'delete-cohort-close' } });
  assert.equal(browser.element('deleteCohortDialog').open, false);
  assert.equal(JSON.stringify(S.doc), before);
  act(null, { dataset: { act: 'delete-cohort', id: 'cohort' } });
  act(null, { dataset: { act: 'delete-cohort-confirm' } });
  assert.equal(S.doc.cohorts.length, 1); assert.equal(S.doc.cohorts[0].id, 'keep');
  assert.equal(S.cohortId, 'keep'); assert.equal(S.preferredCohortId, null);
  assert.equal(S.doc.pipelines[0].cohorts.audience, undefined);
  assert.equal(S.doc.pipelines[0].stages[0].cohort, '');
  assert.equal(S.doc.pipelines[0].cohorts.other, 'keep');
  assert.equal(S.doc.pipelines[0].stages[1].cohort, 'other');
  assert.equal(S.dirty, true); assert.equal(browser.bodies.length, 0);
  assert.equal(browser.snapshot().document.cohorts.length, 1, 'saved snapshot unchanged');
});

test('last-cohort deletion still offers saving and stale confirmation cannot delete new data', async () => {
  const browser = browserHarness(); await settle();
  const { S, act, cohorts } = browser.client;
  S.cohortId = 'cohort'; S.personId = 'person';
  assert.match(cohorts(), /data-act="delete-cohort" data-id="cohort"/);
  act(null, { dataset: { act: 'delete-cohort', id: 'cohort' } });
  S.remoteRevision = S.revision + 1;
  assert.throws(() => act(null, { dataset: { act: 'delete-cohort-confirm' } }), /Workspace changed/);
  assert.equal(S.doc.cohorts.length, 1);
  S.remoteRevision = null;
  act(null, { dataset: { act: 'delete-cohort-confirm' } });
  assert.equal(S.doc.cohorts.length, 0); assert.equal(S.cohortId, null); assert.equal(S.personId, null);
  assert.match(cohorts(), /data-act="save"/);
  assert.equal(S.dirty, true);
});


test('custom ChatGPT model survives catalog refresh, resets across accounts, and reaches cohort drafting', async () => {
  const browser = browserHarness(); await settle();
  const { S, loadChatGpt, startCohortJob } = browser.client;
  S.localEngine = 'chatgpt'; S.localEngines = [{ id: 'chatgpt', available: true }];
  S.chatgpt = { connected: true, planEnabled: true, account: { id: 'first' } };
  S.cohortPrompt = 'Diverse synthetic adult game buyers'; S.cohortSize = 100; S.cohortTarget = 'gamers';
  browser.respond('/api/chatgpt/status', S.chatgpt);
  browser.respond('/api/chatgpt/models', { models: [{ id: 'older-model', name: 'Older model' }] });
  await browser.listeners.get('change')!({ target: { name: 'chatgptModel', value: '__custom__' } });
  browser.listeners.get('input')!({ target: { name: 'chatgptCustomModelId', value: 'gpt-6.1-sol' } });
  assert.equal(S.dirty, false);
  await loadChatGpt();
  assert.equal(S.chatgptCustomModel, true); assert.equal(S.chatgptModel, 'gpt-6.1-sol');
  assert.equal(browser.client.canGenerateCohort(), true);
  browser.respond('/api/chatgpt/models', Promise.reject(new Error('Catalog unavailable')));
  await loadChatGpt();
  assert.equal(S.chatgptModel, 'gpt-6.1-sol'); assert.equal(S.chatgptCustomModel, true);
  assert.equal(browser.client.canGenerateCohort(), true);
  browser.respond('/api/chatgpt/models', { models: [] });
  assert.match(browser.client.cohortGenerator(), /value="__custom__" selected/);
  browser.respond('/api/agent/jobs', { id: 'custom-model-job', status: 'failed', revision: S.revision });
  await startCohortJob();
  assert.deepEqual(browser.bodies.at(-1)?.body, { projectId: 'existing-research', engine: 'chatgpt', model: 'gpt-6.1-sol', prompt: S.cohortPrompt, revision: S.revision, cohort: { id: 'gamers', size: 100 } });
  browser.respond('/api/chatgpt/status', { ...S.chatgpt, account: { id: 'second' } });
  await loadChatGpt();
  assert.equal(S.chatgptModel, ''); assert.equal(S.chatgptCustomModel, false);
});

test('cohort count rejects invalid edits, permits larger cohorts, and shows other readiness blockers', async () => {
  const browser = browserHarness(); await settle();
  const { S, cohortBlockReason, canGenerateCohort } = browser.client;
  S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }]; S.cohortPrompt = 'Adult game buyers';
  const input = (value: string) => ({ name: 'cohortSize', value, closest: () => ({ dataset: { form: 'cohort-generator' } }) });
  for (const count of [0, -1, 1.5, MAX_COHORT_PERSONAS + 1]) {
    const target = input(String(count));
    browser.listeners.get('input')!({ target });
    assert.equal(S.cohortSize, 8); assert.equal(target.value, '8');
    assert.match(browser.element('toast').textContent, /Kept 8 personas/);
  }
  const blank = input(''); browser.listeners.get('input')!({ target: blank });
  assert.equal(canGenerateCohort(), false); assert.match(cohortBlockReason(), /20,000/);
  await browser.listeners.get('change')!({ target: blank });
  assert.equal(blank.value, '8');
  for (const count of [100, 101, MAX_COHORT_PERSONAS]) {
    browser.listeners.get('input')!({ target: input(String(count)) });
    assert.equal(S.cohortSize, count); assert.equal(canGenerateCohort(), true);
  }
  assert.equal(browser.element('cohortReadiness').hidden, true); assert.equal(S.dirty, false);
  S.localEngine = 'chatgpt'; S.localEngines = [{ id: 'chatgpt', available: true }];
  assert.match(cohortBlockReason(), /Choose a drafting model/);
  S.dirty = true; assert.match(cohortBlockReason(), /Save your current edits/);
});


test('recovering a cohort job keeps its requested count after clearing and leaving the field', async () => {
  const browser = browserHarness(); await settle();
  browser.storage.set('jev-local-job:http://127.0.0.1:4180:existing-research', 'recovered');
  browser.respond('/api/local-agents', { engines: [{ id: 'codex', available: true }] });
  browser.respond('/api/agent/jobs/recovered', { id: 'recovered', status: 'completed', cohort: { id: 'gamers', size: 100, prompt: 'Diverse adults' } });
  await browser.client.loadLocalAgents();
  assert.equal(browser.client.S.cohortSize, 100);
  const target = { name: 'cohortSize', value: '', closest: () => ({ dataset: { form: 'cohort-generator' } }) };
  browser.listeners.get('input')!({ target });
  await browser.listeners.get('change')!({ target });
  assert.equal(target.value, '100'); assert.equal(browser.client.S.cohortSize, 100);
});


test('workspace opens at projects and keeps another project out of cohort, pipeline and run views', async () => {
  const browser = browserHarness(false); await settle();
  const { S, selectProject, projectCohorts, projectPipelines, projectRuns, render } = browser.client;
  assert.equal(S.projectId, null);
  assert.match(browser.element('app').innerHTML, /Your projects/);
  assert.match(browser.element('app').innerHTML, /Existing research/);
  assert.doesNotMatch(browser.element('app').innerHTML, /Who should be in this cohort/);
  S.doc.projects.push({ id: 'second', name: 'Second research', description: 'Other decision', cohortIds: ['second-cohort'], pipelineIds: ['second-pipeline'] });
  S.doc.cohorts.push({ ...structuredClone(S.doc.cohorts[0]), id: 'second-cohort', name: 'Other audience' });
  S.doc.pipelines.push({ ...structuredClone(S.doc.pipelines[0]), id: 'second-pipeline', name: 'Other pipeline', cohorts: { audience: 'second-cohort' } });
  S.snap.runs = [{ id: 'first-run', projectId: 'existing-research', pipelineId: 'study' }, { id: 'second-run', projectId: 'second', pipelineId: 'second-pipeline' }];
  selectProject('existing-research'); await settle();
  assert.deepEqual(Array.from(projectCohorts(), (c: any) => c.id), ['cohort']);
  assert.deepEqual(Array.from(projectPipelines(), (p: any) => p.id), ['study']);
  assert.deepEqual(Array.from(projectRuns(), (r: any) => r.id), ['first-run']);
  S.cohortPrompt = 'Unsaved first project brief'; S.localPrompt = 'First assistant brief'; S.plan = { planToken: 'old' };
  selectProject('second'); await settle();
  assert.equal(S.cohortPrompt, ''); assert.equal(S.localPrompt, ''); assert.equal(S.plan, null);
  assert.deepEqual(Array.from(projectCohorts(), (c: any) => c.id), ['second-cohort']);
  S.tab = 'studies'; render();
  assert.match(browser.element('app').innerHTML, /Other pipeline/);
  assert.doesNotMatch(browser.element('app').innerHTML, /Original cohort|Original study/);
  selectProject('existing-research');
  assert.equal(S.cohortPrompt, 'Unsaved first project brief'); assert.equal(S.localPrompt, 'First assistant brief');
});

test('manual cohort creation and deletion update only selected project membership', async () => {
  const browser = browserHarness(); await settle();
  const { S, act, deleteCohortFromDraft } = browser.client;
  S.doc.projects.push({ id: 'empty', name: 'Empty', description: '', cohortIds: [], pipelineIds: [] });
  const previous = JSON.stringify(S.doc.projects[1]);
  act({}, { dataset: { act: 'manual-cohort' } });
  const created = S.cohortId;
  assert.ok(S.doc.projects[0].cohortIds.includes(created));
  S.cohortDeletion = { id: created, revision: S.revision };
  deleteCohortFromDraft();
  assert.equal(S.doc.projects[0].cohortIds.includes(created), false);
  assert.equal(S.doc.cohorts.some((c: any) => c.id === created), false);
  assert.equal(JSON.stringify(S.doc.projects[1]), previous);
});


test('late run plan cannot land after switching projects', async () => {
  const browser = browserHarness(); await settle();
  const { S, reviewPlan, selectProject } = browser.client;
  S.pipelineId = 'study'; S.doc.projects.push({ id: 'other', name: 'Other', description: '', cohortIds: [], pipelineIds: [] });
  let complete!: (value: unknown) => void;
  browser.respond('/api/plan', new Promise(resolve => { complete = resolve; }));
  const pending = reviewPlan();
  selectProject('other');
  complete({ pipelineId: 'study', projectId: 'existing-research', maxRequests: 1 });
  await pending;
  assert.equal(S.plan, null);
  assert.equal(S.projectId, 'other');
});

test('cohort editor has an explicit path back to the library and keeps unsaved edits', async () => {
  const browser = browserHarness(); await settle();
  const { S, act, cohorts } = browser.client;
  S.tab = 'cohorts'; S.cohortId = null;
  assert.match(cohorts(), /role="tablist"/);
  act(null, { dataset: { act: 'open-cohort', id: 'cohort' } });
  assert.doesNotMatch(browser.element('app').innerHTML, /role="tablist"|role="tabpanel"/);
  assert.match(browser.element('app').innerHTML, /Back to cohorts/);
  assert.match(browser.element('app').innerHTML, /Original cohort/);
  act(null, { dataset: { act: 'cohort-section', section: 'definition' } });
  assert.match(browser.element('app').innerHTML, /data-form="cohort"/);
  const input = { name: 'description', closest: () => ({ dataset: { form: 'cohort' } }) };
  browser.listeners.get('input')!({ target: input });
  assert.match(cohorts(), /Unsaved changes/);
  S.doc.cohorts[0].name = 'Unsaved audience edit'; S.dirty = true;
  assert.match(cohorts(), /Unsaved changes/);
  act(null, { dataset: { act: 'back-cohorts' } });
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.match(browser.element('app').innerHTML, /Unsaved audience edit/);
  assert.equal(S.doc.cohorts[0].name, 'Unsaved audience edit');
});

test('opening a persona shows its full story, structured attributes, attached sources, and one weight control', async () => {
  const browser = browserHarness(); await settle();
  const { S, act } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [{ id: 'general', label: 'General visitors', description: 'Museum visitors', weight: 1, weightBasis: 'assumed', sourceIds: [] }];
  cohort.sources = [{ id: 'study', title: 'Visitor research', url: 'https://example.com/visitors', retrievedAt: '2026-10-01T00:00:00.000Z', notes: 'Supports the general visit-frequency context.' }];
  cohort.personas[0].sourceIds = ['study'];
  cohort.personas[0].background = 'A complete story about how this adult chooses weekend museum visits.';
  cohort.personas[0].attributes = { region: 'North', visitsPerYear: 4 };
  S.cohortId = cohort.id;
  act(null, { dataset: { act: 'open-persona', id: 'person' } });
  const html = browser.element('app').innerHTML;
  assert.equal(S.personaOpen, true);
  assert.match(html, /A complete story about how this adult chooses weekend museum visits/);
  assert.match(html, /visitsPerYear/); assert.match(html, /North/);
  assert.match(html, /Visitor research/); assert.match(html, /Supports the general visit-frequency context/);
  assert.match(html, /href="https:\/\/example.com\/visitors"/);
  assert.match(html, /Synthetic fields/);
  assert.equal((html.match(/name="relativeWeight"/g) ?? []).length, 1, 'weight editing has one authoritative field');
});

test('persona grouping, filtering, and pagination operate on the full cohort', async () => {
  const browser = browserHarness(); await settle();
  const { S, cohortExplorer, explorerAction } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.personas = Array.from({ length: 50 }, (_, index) => ({ ...structuredClone(cohort.personas[0]), id: `person-${index + 1}`, label: `Person ${index + 1}`, attributes: { region: index % 2 ? 'South' : 'North' } }));
  S.cohortId = cohort.id; S.personaGroup = 'attributes.region';
  let html = cohortExplorer(cohort);
  assert.match(html, /Group personas by/); assert.match(html, /North/); assert.doesNotMatch(html, /South/);
  assert.match(html, /1–24 of 50 personas/);
  explorerAction('persona-page', { dataset: { delta: '1' } });
  html = browser.element('app').innerHTML;
  assert.match(html, /25–48 of 50 personas/);
  assert.match(html, /South/);
  S.personaFilter = { field: 'attributes.region', bucket: { label: 'North', value: 'North' } };
  S.personaPage = 0; html = cohortExplorer(cohort);
  assert.match(html, /Showing Region: North/);
  assert.match(html, /1–24 of 25 personas/);
  assert.doesNotMatch(html, /Person 2</);
  explorerAction('persona-clear-filter', { dataset: {} });
  assert.equal(S.personaFilter, null);
  assert.match(browser.element('app').innerHTML, /of 50 personas/);
});

test('explorer controls stay transient and target validation plus positive persona weights gate edits', async () => {
  const browser = browserHarness(); await settle();
  const { S, explorerAction } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [{ id: 'general', label: 'General', description: 'General adults', weight: 1, weightBasis: 'assumed', sourceIds: [] }];
  cohort.personas = [
    { ...structuredClone(cohort.personas[0]), id: 'young', age: 25, weight: 1 },
    { ...structuredClone(cohort.personas[0]), id: 'older', age: 60, weight: 1 },
  ];
  S.cohortId = cohort.id;
  const saved = JSON.stringify(S.doc);
  const change = browser.listeners.get('change')!;
  change({ target: { name: 'personaGroup', value: 'age' } });
  change({ target: { name: 'distributionField', value: 'age' } });
  change({ target: { name: 'distributionMeasure', value: 'weighted' } });
  assert.equal(S.dirty, false); assert.equal(JSON.stringify(S.doc), saved);

  S.targetDraft = { field: 'age', kind: 'numeric', buckets: [{ label: 'Younger', min: 18, max: 40, percent: 50 }, { label: 'Older', min: 40, max: 121, percent: 50 }] };
  const targetForm = { reportValidity: () => true, values: { targetField: 'age', targetKind: 'numeric', targetLabel0: 'Younger', targetMin0: '18', targetMax0: '40', targetPercent0: '70', targetLabel1: 'Older', targetMin1: '40', targetMax1: '121', targetPercent1: '20' } };
  browser.element('app').querySelector = selector => selector === '[data-form=distribution-target]' ? targetForm : null;
  const input = { name: 'targetPercent0', closest: () => ({ dataset: { form: 'distribution-target' } }) };
  browser.listeners.get('input')!({ target: input });
  assert.equal(S.dirty, false); assert.equal(JSON.stringify(S.doc), saved);
  assert.throws(() => explorerAction('target-apply', { dataset: {} }), /percentages must total 100/);
  assert.equal(cohort.distributionTargets, undefined);
  targetForm.values.targetPercent0 = '60'; targetForm.values.targetPercent1 = '40';
  explorerAction('target-apply', { dataset: {} });
  assert.deepEqual(JSON.parse(JSON.stringify(cohort.distributionTargets)), [{ field: 'age', kind: 'numeric', buckets: [{ label: 'Younger', min: 18, max: 40, percent: 60 }, { label: 'Older', min: 40, max: 121, percent: 40 }] }]);
  assert.equal(S.dirty, true);

  S.dirty = false; S.personId = 'young';
  let selfSubmitAttempts = 0;
  const weightForm = { dataset: { form: 'persona-weight' }, values: { relativeWeight: '0' }, reportValidity: () => true, requestSubmit: () => { selfSubmitAttempts++; } };
  browser.element('app').querySelectorAll = selector => selector === '[data-form]' ? [weightForm] : [];
  const submit = browser.listeners.get('submit')!;
  browser.listeners.get('input')!({ target: { name: 'relativeWeight', closest: () => weightForm } });
  submit({ target: { closest: () => weightForm }, preventDefault() {} });
  assert.equal(cohort.personas[0].weight, 1);
  weightForm.values.relativeWeight = '2.5';
  browser.listeners.get('input')!({ target: { name: 'relativeWeight', closest: () => weightForm } });
  S.dirty = false;
  submit({ target: { closest: () => weightForm }, preventDefault() {} });
  assert.equal(cohort.personas[0].weight, 2.5); assert.equal(S.dirty, true);
  assert.equal(selfSubmitAttempts, 0, 'submitting the active weight form does not re-submit itself during flush');
});

test('single-persona regeneration targets one ID and adoption is stale-safe and preserves all other data', async () => {
  const browser = browserHarness(); await settle();
  const { S, startPersonaJob, adoptPersonaProposal } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.personas.push({ ...structuredClone(cohort.personas[0]), id: 'keep-person', label: 'Keep this person', background: 'Unaffected person.' });
  S.cohortId = cohort.id; S.personId = 'person'; S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }]; S.personaRegenPrompt = 'Add a distinct family detail.';
  const original = structuredClone(S.doc);
  const replacement = { ...structuredClone(cohort.personas[0]), label: 'Updated participant', background: 'A refreshed full story.', attributes: { role: 'Parent' } };
  const proposal = structuredClone(S.doc); proposal.cohorts[0].personas[0] = replacement;
  browser.respond('/api/agent/jobs', { id: 'persona-job', engine: 'codex', status: 'completed', revision: S.revision, persona: { cohortId: cohort.id, personaId: 'person' }, proposal: { document: proposal, explanation: 'Only one persona changed.' } });
  await startPersonaJob();
  assert.deepEqual(JSON.parse(JSON.stringify(browser.bodies.at(-1)?.body)), { projectId: 'existing-research', engine: 'codex', prompt: 'Add a distinct family detail.', revision: S.revision, persona: { cohortId: 'cohort', personaId: 'person' } });
  assert.deepEqual(JSON.parse(JSON.stringify(S.doc)), original, 'generation leaves the saved draft untouched');
  assert.match(browser.client.personaDetail(cohort), /Updated participant/);

  S.dirty = true; assert.throws(adoptPersonaProposal, /Workspace changed/); S.dirty = false;
  S.revision++; assert.throws(adoptPersonaProposal, /Workspace changed/); S.revision--;
  S.remoteRevision = S.revision + 1; assert.throws(adoptPersonaProposal, /Workspace changed/); S.remoteRevision = null;
  adoptPersonaProposal();
  assert.equal(S.dirty, true);
  assert.equal(cohort.personas[0].label, 'Updated participant');
  assert.deepEqual(cohort.personas[1], original.cohorts[0].personas[1]);
  assert.equal(JSON.stringify(S.doc.pipelines), JSON.stringify(original.pipelines));
});

test('persona regeneration proposals stay isolated to the project that requested them', async () => {
  const browser = browserHarness(); await settle();
  const { S, startPersonaJob, selectProject, adoptPersonaProposal } = browser.client;
  const otherCohort = structuredClone(S.doc.cohorts[0]);
  otherCohort.id = 'other-cohort'; otherCohort.name = 'Other project cohort';
  otherCohort.personas[0].id = 'other-person'; otherCohort.personas[0].label = 'Keep other project person';
  S.doc.cohorts.push(otherCohort);
  S.doc.projects.push({ id: 'other-project', name: 'Other project', description: '', cohortIds: [otherCohort.id], pipelineIds: [] });
  S.cohortId = 'cohort'; S.personId = 'person'; S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }];
  const proposal = structuredClone(S.doc);
  proposal.cohorts.find(c => c.id === 'cohort')!.personas[0]!.label = 'First project replacement';
  browser.respond('/api/agent/jobs', { id: 'first-project-persona-job', projectId: 'existing-research', engine: 'codex', status: 'completed', revision: S.revision, persona: { cohortId: 'cohort', personaId: 'person' }, proposal: { document: proposal, explanation: 'One persona in the first project changed.' } });
  await startPersonaJob();
  assert.equal((browser.bodies.at(-1)?.body as any).projectId, 'existing-research');
  const firstProjectJob = S.localJob;

  selectProject('other-project'); await settle();
  assert.equal(S.localJob, null, 'a completed persona proposal from another project is not shown');
  S.localJob = firstProjectJob;
  assert.throws(adoptPersonaProposal, /Open the project that generated this draft/);
  S.localJob = null;
  adoptPersonaProposal();
  assert.equal(S.doc.cohorts.find(c => c.id === 'other-cohort')!.personas[0]!.label, 'Keep other project person');
  assert.equal(S.doc.cohorts.find(c => c.id === 'cohort')!.personas[0]!.label, 'Adult participant');

  selectProject('existing-research'); await settle();
  assert.equal(S.localJob?.projectId, 'existing-research', 'returning restores only that project’s proposal');
  adoptPersonaProposal();
  assert.equal(S.doc.cohorts.find(c => c.id === 'cohort')!.personas[0]!.label, 'First project replacement');
  assert.equal(S.doc.cohorts.find(c => c.id === 'other-cohort')!.personas[0]!.label, 'Keep other project person');
});

test('cohort generation is entered explicitly and its return action restores the right editor', async () => {
  const browser = browserHarness(); await settle();
  const { S, act, cohorts } = browser.client;
  S.tab = 'cohorts'; S.cohortId = null; S.personId = null;
  S.doc.cohorts = [];
  assert.match(cohorts(), /role="tablist"/);
  assert.doesNotMatch(cohorts(), /cohort-generator/);
  act(null, { dataset: { act: 'new-cohort' } });
  assert.match(browser.element('app').innerHTML, /cohort-generator/);
  assert.doesNotMatch(browser.element('app').innerHTML, /role="tablist"/);
  assert.match(browser.element('app').innerHTML, /Back to cohorts/);
  act(null, { dataset: { act: 'cohort-generator-close' } });
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.doesNotMatch(browser.element('app').innerHTML, /cohort-generator/);
  S.doc.cohorts = browser.snapshot().document.cohorts;
  act(null, { dataset: { act: 'new-cohort' } });
  S.cohortPrompt = 'New audience brief';
  act(null, { dataset: { act: 'cohort-generator-close' } });
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.equal(S.cohortPrompt, 'New audience brief');

  act(null, { dataset: { act: 'open-cohort', id: 'cohort' } });
  S.doc.cohorts[0].description = 'Unsaved cohort detail'; S.dirty = true;
  act(null, { dataset: { act: 'cohort-section', section: 'definition' } });
  act(null, { dataset: { act: 'generate-personas' } });
  assert.match(browser.element('app').innerHTML, /Back to cohort/);
  act(null, { dataset: { act: 'cohort-generator-close' } });
  assert.match(browser.element('app').innerHTML, /Unsaved cohort detail/);
  assert.equal(S.dirty, true);
});

test('phase cohort entry returns to the same pipeline stage while direct cohort entry clears that context', async () => {
  const browser = browserHarness(); await settle();
  const { S, act } = browser.client;
  S.tab = 'studies'; S.pipelineId = 'study'; S.stageId = 'panel'; S.cohortId = null;
  act(null, { dataset: { act: 'phase-pool', id: 'cohort' } });
  assert.deepEqual(JSON.parse(JSON.stringify(S.cohortReturn)), { pipelineId: 'study', stageId: 'panel' });
  assert.match(browser.element('app').innerHTML, /data-act="back-cohort-pipeline"/);
  S.doc.cohorts[0].description = 'Unsaved from pipeline'; S.dirty = true;
  act(null, { dataset: { act: 'back-cohort-pipeline' } });
  assert.equal(S.pipelineId, 'study'); assert.equal(S.stageId, 'panel');
  assert.equal(S.doc.cohorts[0].description, 'Unsaved from pipeline');
  assert.equal(S.dirty, true);
  act(null, { dataset: { act: 'open-cohort', id: 'cohort' } });
  assert.equal(S.cohortReturn, null);
  assert.doesNotMatch(browser.element('app').innerHTML, /back-cohort-pipeline/);
});

test('cohort editor keeps management controls without study execution or inference review asides', async () => {
  const browser = browserHarness(); await settle();
  const { S, cohorts } = browser.client;
  S.cohortId = 'cohort'; S.personId = 'person'; S.dirty = true;
  const html = cohorts();
  assert.match(html, /Unsaved changes/);
  assert.match(html, /data-act="save"/);
  assert.match(html, /data-act="pool-study"/);
  assert.match(html, /data-act="delete-cohort"/);
  assert.match(html, /management/i);
  assert.doesNotMatch(html, /running this study|Review before inference/i);
});

test('workspace tabs clear cohort selections and open the project pipeline while preserving the draft', async () => {
  const browser = browserHarness(); await settle();
  const { S, act } = browser.client;
  const draft = structuredClone(S.doc);
  S.tab = 'cohorts'; S.cohortId = 'cohort'; S.personId = 'person';
  act(null, { dataset: { act: 'pool-study', id: 'cohort' } });
  act(null, { dataset: { act: 'tab', tab: 'cohorts' } });
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.doesNotMatch(browser.element('app').innerHTML, /Back to cohorts|Back to cohort/);
  assert.equal(S.cohortId, null); assert.equal(S.personId, null);
  assert.equal(S.cohortComposer, false); assert.equal(S.cohortReturn, null);
  assert.deepEqual(JSON.parse(JSON.stringify(S.doc)), JSON.parse(JSON.stringify(draft)));

  S.pipelineId = 'study'; S.stageId = 'panel';
  act(null, { dataset: { act: 'tab', tab: 'studies' } });
  assert.equal(S.pipelineId, 'study'); assert.equal(S.stageId, 'panel');
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.deepEqual(JSON.parse(JSON.stringify(S.doc)), JSON.parse(JSON.stringify(draft)));
});


test('project detail submission saves metadata and pipeline creation assigns ownership', async () => {
  const browser = browserHarness(); await settle();
  const { S } = browser.client;
  const submit = (kind: string, values: Record<string, string>) => {
    const form = { dataset: { form: kind }, values };
    browser.listeners.get('submit')!({ target: { closest: () => form }, preventDefault() {} });
  };
  S.flushing = true;
  submit('project-settings', { name: 'Renamed project', description: 'Updated research brief' });
  S.flushing = false;
  assert.equal(S.doc.projects[0].name, 'Renamed project');
  assert.equal(S.doc.projects[0].description, 'Updated research brief');
  S.doc.pipelines = []; S.doc.projects[0].pipelineIds = [];
  submit('new-pipeline', { question: 'Which service is preferred?' });
  assert.equal(S.doc.pipelines.length, 1);
  assert.equal(S.doc.projects[0].pipelineIds[0], S.doc.pipelines[0].id);
  submit('new-pipeline', { question: 'Second pipeline?' });
  assert.equal(S.doc.pipelines.length, 1, 'new project keeps one pipeline');
});


test('segment percentages round-trip without rewriting relative weights or source provenance', async () => {
  const browser = browserHarness(); await settle();
  const { S, segmentShares, applySegmentShares } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [
    { id: 'general', label: 'General', description: 'Audience', weight: 2, weightBasis: 'sourced', sourceIds: ['research'] },
    { id: 'other', label: 'Other', description: 'Other audience', weight: 1, weightBasis: 'assumed', sourceIds: [] },
    { id: 'excluded', label: 'Excluded', description: '', weight: 0, weightBasis: 'user', sourceIds: [] },
  ];
  const before = JSON.stringify(S.doc);
  const shares = Array.from(segmentShares(cohort)) as number[];
  assert.equal(shares.reduce((sum, share) => sum + share, 0), 100);
  assert.ok(Math.abs(shares[0]! - 200 / 3) < 0.000001);
  assert.equal(shares[2], 0);
  applySegmentShares(cohort, { values: Object.fromEntries(shares.map((share, i) => [`segmentShare${i}`, String(share)])) });
  assert.equal(JSON.stringify(S.doc), before, 'display rounding must not mutate saved raw weights or provenance');
});

test('segment percentage validation is atomic for missing, invalid, and non-totaling values', async () => {
  const browser = browserHarness(); await settle();
  const { S, applySegmentShares } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [
    { id: 'general', label: 'General', description: '', weight: 2, weightBasis: 'sourced', sourceIds: ['research'] },
    { id: 'other', label: 'Other', description: '', weight: 1, weightBasis: 'assumed', sourceIds: [] },
  ];
  const before = JSON.stringify(S.doc);
  for (const shares of [['', '100'], [' ', '100'], ['60', '30'], ['-1', '101'], ['101', '-1'], ['Infinity', '0'], ['NaN', '100'], ['no', '100'], ['0', '0']]) {
    assert.throws(() => applySegmentShares(cohort, { values: { segmentShare0: shares[0], segmentShare1: shares[1] } }), `must reject ${JSON.stringify(shares)}`);
    assert.equal(JSON.stringify(S.doc), before, 'failed validation must leave the entire draft unchanged');
  }
  assert.throws(() => applySegmentShares(cohort, { values: { segmentShare0: '100' } }));
  assert.equal(JSON.stringify(S.doc), before);
});

test('applying segment percentages preserves references and changes provenance only for edited shares', async () => {
  const browser = browserHarness(); await settle();
  const { S, applySegmentShares } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [
    { id: 'general', label: 'General', description: 'Keep biography', weight: 2, weightBasis: 'sourced', sourceIds: ['research'] },
    { id: 'other', label: 'Other', description: '', weight: 1, weightBasis: 'assumed', sourceIds: [] },
    { id: 'same', label: 'Same', description: '', weight: 1, weightBasis: 'sourced', sourceIds: ['unchanged-research'] },
  ];
  const people = JSON.stringify(cohort.personas), pipelines = JSON.stringify(S.doc.pipelines);
  applySegmentShares(cohort, { values: { segmentShare0: '60', segmentShare1: '15', segmentShare2: '25' } });
  assert.deepEqual(Array.from(cohort.segments, (segment: any) => segment.weight), [0.6, 0.15, 0.25]);
  assert.deepEqual(Array.from(cohort.segments, (segment: any) => segment.weightBasis), ['user', 'user', 'sourced']);
  assert.deepEqual(Array.from(cohort.segments[0].sourceIds), ['research']);
  assert.deepEqual(Array.from(cohort.segments[2].sourceIds), ['unchanged-research']);
  assert.equal(cohort.segments[0].description, 'Keep biography');
  assert.equal(JSON.stringify(cohort.personas), people);
  assert.equal(JSON.stringify(S.doc.pipelines), pipelines);
  applySegmentShares(cohort, { values: { segmentShare0: '100', segmentShare1: '0', segmentShare2: '0' } });
  assert.deepEqual(Array.from(cohort.segments, (segment: any) => segment.weight), [1, 0, 0], 'zero-share segments remain valid');
});

test('weights show compact shares and only the selected segment details editor', async () => {
  const browser = browserHarness(); await settle();
  const { S, act } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [
    { id: 'general', label: 'General visitors', description: 'General audience details', weight: 1, weightBasis: 'assumed', sourceIds: [] },
    { id: 'other', label: 'Other visitors', description: 'Other audience details', weight: 1, weightBasis: 'assumed', sourceIds: [] },
  ];
  S.cohortId = cohort.id;
  act(null, { dataset: { act: 'cohort-section', section: 'weights' } });
  let html = browser.element('app').innerHTML;
  assert.equal((html.match(/name="segmentShare\d+"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /data-form="segment"/);
  act(null, { dataset: { act: 'edit-segment', id: 'other' } });
  html = browser.element('app').innerHTML;
  assert.equal(S.segmentId, 'other');
  assert.equal((html.match(/data-form="segment"/g) ?? []).length, 1);
  assert.match(html, /Other audience details/);
  assert.doesNotMatch(html, /name="segmentWeight"/);
  assert.match(html, /<details[\s\S]*name="segmentId"/);
  act(null, { dataset: { act: 'close-segment' } });
  assert.doesNotMatch(browser.element('app').innerHTML, /data-form="segment"/);
});

test('leaving weights flushes percentage and detail edits together without stale provenance overwrites', async () => {
  const browser = browserHarness(); await settle();
  const { S } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.sources = [{ id: 'research', title: 'Research', url: 'https://example.com', retrievedAt: '2026-10-01T00:00:00Z', notes: 'Original share context' }];
  cohort.segments = [
    { id: 'general', label: 'General', description: 'Before', weight: 2, weightBasis: 'sourced', sourceIds: ['research'] },
    { id: 'other', label: 'Other', description: '', weight: 1, weightBasis: 'assumed', sourceIds: [] },
  ];
  cohort.distributionTargets = [{ field: 'segment', kind: 'categorical', buckets: [{ label: 'General', value: 'general', percent: 100 }] }];
  S.tab = 'cohorts'; S.cohortId = cohort.id; S.cohortSection = 'weights'; S.segmentId = 'general'; S.dirty = true;
  const submit = browser.listeners.get('submit')!;
  const sharesForm: any = { dataset: { form: 'segment-shares' }, values: { segmentShare0: '60', segmentShare1: '40' }, reportValidity: () => true };
  const detailsForm: any = { dataset: { form: 'segment', id: 'general', weightBasis: 'sourced' }, values: { segmentId: 'renamed', segmentLabel: 'Renamed group', segmentDescription: 'After', weightBasis: 'sourced', sourceIds: ['research'] }, reportValidity: () => true };
  detailsForm.querySelector = () => ({ value: 'renamed' });
  for (const form of [sharesForm, detailsForm]) form.requestSubmit = () => submit({ target: { closest: () => form }, preventDefault() {} });
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [sharesForm, detailsForm] : selector === '[data-form=segment]' ? [detailsForm] : [];
  browser.listeners.get('click')!({ target: { closest: () => ({ dataset: { act: 'close-segment' } }) }, preventDefault() {} });
  assert.deepEqual(Array.from(S.doc.cohorts[0].segments, (segment: any) => segment.weight), [0.6, 0.4]);
  assert.equal(S.doc.cohorts[0].segments[0].label, 'Renamed group');
  assert.equal(S.doc.cohorts[0].segments[0].description, 'After');
  assert.equal(S.doc.cohorts[0].segments[0].weightBasis, 'user', 'untouched details provenance must not erase the edited share provenance');
  assert.equal(S.doc.cohorts[0].personas[0].segment, 'renamed');
  assert.equal(S.doc.cohorts[0].distributionTargets[0].buckets[0].value, 'renamed');
  assert.equal(S.segmentId, null);
});

test('invalid percentage totals block navigation and roll back other flushed form edits', async () => {
  const browser = browserHarness(); await settle();
  const { S } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [
    { id: 'general', label: 'General', description: 'Original description', weight: 2, weightBasis: 'assumed', sourceIds: [] },
    { id: 'other', label: 'Other', description: '', weight: 1, weightBasis: 'assumed', sourceIds: [] },
  ];
  S.tab = 'cohorts'; S.cohortId = cohort.id; S.cohortSection = 'weights'; S.segmentId = 'general'; S.dirty = true;
  const before = JSON.stringify(S.doc), submit = browser.listeners.get('submit')!;
  const detailsForm: any = { dataset: { form: 'segment', id: 'general', weightBasis: 'assumed' }, values: { segmentId: 'renamed', segmentLabel: 'Edited but not applied', segmentDescription: 'Do not partially apply', weightBasis: 'assumed' }, reportValidity: () => true };
  const sharesForm: any = { dataset: { form: 'segment-shares' }, values: { segmentShare0: '60', segmentShare1: '30' }, reportValidity: () => true };
  detailsForm.querySelector = () => ({ value: 'renamed' });
  for (const form of [detailsForm, sharesForm]) form.requestSubmit = () => submit({ target: { closest: () => form }, preventDefault() {} });
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [detailsForm, sharesForm] : selector === '[data-form=segment]' ? [detailsForm] : [];
  browser.listeners.get('click')!({ target: { closest: () => ({ dataset: { act: 'cohort-section', section: 'people' } }) }, preventDefault() {} });
  assert.equal(S.cohortSection, 'weights');
  assert.equal(S.segmentId, 'general');
  assert.equal(JSON.stringify(S.doc), before);
  assert.match(S.formError, /100/);
});


test('submitting segment metadata preserves untouched raw weights and skips submitting the active form twice', async () => {
  const browser = browserHarness(); await settle();
  const { S, segmentShares } = browser.client;
  const cohort = S.doc.cohorts[0];
  cohort.segments = [
    { id: 'general', label: 'General', description: 'Before', weight: 2, weightBasis: 'sourced', sourceIds: ['research'] },
    { id: 'other', label: 'Other', description: '', weight: 1, weightBasis: 'assumed', sourceIds: [] },
  ];
  S.tab = 'cohorts'; S.cohortId = cohort.id; S.cohortSection = 'weights'; S.segmentId = 'general'; S.dirty = true;
  const submit = browser.listeners.get('submit')!, shares = Array.from(segmentShares(cohort));
  const sharesForm: any = { dataset: { form: 'segment-shares' }, values: Object.fromEntries(shares.map((share, i) => [`segmentShare${i}`, String(share)])), reportValidity: () => true };
  const detailsForm: any = { dataset: { form: 'segment', id: 'general', weightBasis: 'sourced' }, values: { segmentId: 'general', segmentLabel: 'Clearer group label', segmentDescription: 'Edited description only', weightBasis: 'sourced', sourceIds: ['research'] }, reportValidity: () => true };
  detailsForm.querySelector = () => ({ value: 'general' });
  let activeFormSubmits = 0;
  detailsForm.requestSubmit = () => { activeFormSubmits++; };
  sharesForm.requestSubmit = () => submit({ target: { closest: () => sharesForm }, preventDefault() {} });
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [sharesForm, detailsForm] : selector === '[data-form=segment]' ? [detailsForm] : [];
  submit({ target: { closest: () => detailsForm }, preventDefault() {} });
  assert.equal(cohort.segments[0].label, 'Clearer group label');
  assert.equal(cohort.segments[0].description, 'Edited description only');
  assert.deepEqual(Array.from(cohort.segments, (segment: any) => segment.weight), [2, 1]);
  assert.deepEqual(Array.from(cohort.segments, (segment: any) => segment.weightBasis), ['sourced', 'assumed']);
  assert.equal(S.segmentId, 'general');
  assert.equal(activeFormSubmits, 0);
});

test('invalid active share submission preserves pending segment ID edits for correction', async () => {
const browser = browserHarness(); await settle(); const {S}=browser.client;
const c=S.doc.cohorts[0];c.segments=[{id:'general',label:'General',description:'',weight:1,weightBasis:'assumed',sourceIds:[]},{id:'other',label:'Other',description:'',weight:1,weightBasis:'assumed',sourceIds:[]}];S.tab='cohorts';S.cohortId=c.id;S.segmentId='general';S.cohortSection='weights';S.dirty=true;
const submit=browser.listeners.get('submit')!;
const shares:any={dataset:{form:'segment-shares'},values:{segmentShare0:'60',segmentShare1:'30'},reportValidity:()=>true};
const details:any={dataset:{form:'segment',id:'general',weightBasis:'assumed'},values:{segmentId:'renamed',segmentLabel:'General',segmentDescription:'',weightBasis:'assumed'},reportValidity:()=>true,querySelector:()=>({value:'renamed'})};
for(const f of [shares,details])f.requestSubmit=()=>submit({target:{closest:()=>f},preventDefault(){}});
browser.element('app').querySelectorAll=(selector:string)=>selector==='[data-form]'?[shares,details]:selector==='[data-form=segment]'?[details]:[];
submit({target:{closest:()=>shares},preventDefault(){}});
assert.match(S.formError,/100/);
shares.values.segmentShare1='40';submit({target:{closest:()=>shares},preventDefault(){}});
assert.equal(S.formError,null);
assert.equal(S.doc.cohorts[0].segments[0].weight,.6);
});
