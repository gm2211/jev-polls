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

function browserHarness(openExistingProject = true, preferences = new Map<string, string>()) {
  const documentValue = { version: 1, cohorts: [{ id: 'cohort', name: 'Original cohort', population: 'Adults', description: '', assumptions: [], sources: [], segments: [], personas: [{ id: 'person', label: 'Adult participant', age: 30, segment: 'general', weight: 1, background: 'Independent background', attributes: {}, sourceIds: [], syntheticFields: ['background'] }] }], pipelines: [{ id: 'study', name: 'Original study', description: '', stages: [{ id: 'panel', label: 'First question', kind: 'poll', cohort: 'audience', questions: { answer: { type: 'choice', label: 'Which option fits?', instructions: 'Choose an option.', criteria: { a: 'A', b: 'B' } } }, inputs: {}, dependsOn: [] }], cohorts: { audience: 'cohort' } }] };
  let snapshot = { revision: 1, document: documentValue, auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null };
  const elements = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const intervals: Function[] = [];
  const timeouts: Function[] = [];
  const requests: string[] = [];
  const bodies: Array<{ path: string; body: unknown }> = [];
  const responses = new Map<string, unknown>([['/api/local-agents', { engines: [] }], ['/api/chatgpt/status', { connected: false, planEnabled: false }]]);
  const failures = new Map<string, string>();
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
    localStorage: { getItem: (key: string) => preferences.get(key) ?? null, setItem: (key: string, value: string) => preferences.set(key, value), removeItem: (key: string) => preferences.delete(key) },
    sessionStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    document: { getElementById: element, querySelectorAll: () => [], visibilityState: 'visible', addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    fetch: async (path: string, options?: { method?: string; body?: string }) => {
      requests.push(path); if (options?.body) bodies.push({ path, body: JSON.parse(options.body) });
      const key = (options?.method || 'GET') + ' ' + path;
      const data = await (responses.get(key) ?? responses.get(path) ?? snapshot);
      const failure = failures.get(key) ?? failures.get(path);
      return { ok: !failure, json: async () => JSON.parse(JSON.stringify(failure ? { error: { message: failure } } : data)) };
    },
    setTimeout: (fn: Function) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {}, setInterval: (fn: Function) => { intervals.push(fn); return 1; },
    navigator: {}, URL, confirm: () => { throw new Error('Unexpected native confirmation'); },
    FormData: TestFormData,
  };
  const html = renderWorkspace('test', 'token');
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.clientTest={S,draftProgress,updateDraftClocks,reviewPlan,selectProject,project,projectCohorts,projectPipelines,projectRuns,projects,render,refresh,reloadSaved,applySnapshot,agents,copyAgentText,act,freshPipeline,addNextPhase,addPhaseInput,projectionOptions,dataInputOptions,startLocalJob,applyLocalProposal,proposalReview,aiSettingsContent,graphEdgePath,drawStageEdges,cohortGenerator,startCohortJob,adoptCohortProposal,cohortProposalReview,canGenerateCohort,pollLocalJob,cancelLocalJob,cohorts,cohortCard,deleteCohortFromDraft,loadChatGpt,loadLocalAgents,cohortBlockReason,cohortExplorer,personaDetail,explorerAction,cohortDistributions,targetEditor,startPersonaJob,adoptPersonaProposal,segmentShares,applySegmentShares,pageItems,sectionPanels,revealSectionField,stageForm,applyStage};})();');
  const sandbox = new Script(exposed).runInNewContext(context) as undefined;
  void sandbox;
  if (openExistingProject) (context as any).clientTest.S.projectId = 'existing-research';
  return {
    client: (context as typeof context & { clientTest: any }).clientTest, window: context.window,
    element, listeners, intervals, timeouts, requests, bodies, storage,
    respond: (path: string, value: unknown, method?: string) => responses.set(method ? method + ' ' + path : path, value),
    fail: (path: string, message: string, method?: string) => failures.set(method ? method + ' ' + path : path, message),
    setSnapshot: (value: typeof snapshot) => { snapshot = value; },
    snapshot: () => structuredClone(snapshot),
    document: context.document,
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('collection pages clamp after deletion and stay independent across projects', async () => {
  const browser = browserHarness(); await settle();
  const { S, pageItems } = browser.client;
  const items = Array.from({ length: 15 }, (_, i) => i);
  S.listPages['existing-research:cohorts'] = 2;
  assert.deepEqual(Array.from(pageItems(items, 'cohorts', 6).items), [12, 13, 14]);
  assert.equal(pageItems(items.slice(0, 8), 'cohorts', 6).index, 1);
  S.projectId = 'another-project';
  assert.deepEqual(Array.from(pageItems(items, 'cohorts', 6).items), [0, 1, 2, 3, 4, 5]);
  assert.equal(S.dirty, false);
});

test('section navigation flushes typed persona fields without replacing the separate weight', async () => {
  const browser = browserHarness(); await settle();
  const { S } = browser.client;
  S.cohortId = 'cohort'; S.personId = 'person'; S.personaOpen = true;
  S.doc.cohorts[0].personas[0].weight = 2.5;
  const form: any = { dataset: { form: 'persona' }, reportValidity: () => true, values: {
    personaId: 'person', personaLabel: 'Edited before tabbing', age: '31', segment: 'general',
    background: 'Unsaved full story', attributes: '{"country":"Italy"}', syntheticFields: 'background\nattributes', sourceIds: [],
  } };
  const submit = browser.listeners.get('submit')!;
  form.requestSubmit = () => submit({ target: { closest: () => form }, preventDefault() {} });
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [form] : [];
  S.dirty = true;
  const button = { dataset: { act: 'section-view', sectionKey: 'persona-detail', sectionId: 'attributes' } };
  browser.listeners.get('click')!({ target: { closest: () => button }, preventDefault() {} });
  const persona = S.doc.cohorts[0].personas[0];
  assert.equal(persona.label, 'Edited before tabbing');
  assert.equal(persona.background, 'Unsaved full story');
  assert.equal(persona.attributes.country, 'Italy');
  assert.equal(persona.weight, 2.5);
  assert.equal(S.sections['persona-detail'], 'attributes');
  assert.equal(S.dirty, true);
  assert.equal(browser.bodies.length, 0, 'tabbing does not save or call a model');
});

test('invalid form blocks a tab change and hidden field validation reveals every containing section', async () => {
  const browser = browserHarness(); await settle();
  const { S, revealSectionField } = browser.client;
  S.sections['persona-detail'] = 'edit'; S.dirty = true;
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [{ dataset: { form: 'persona' }, reportValidity: () => false }] : [];
  const button = { dataset: { act: 'section-view', sectionKey: 'persona-detail', sectionId: 'background' } };
  browser.listeners.get('click')!({ target: { closest: () => button }, preventDefault() {} });
  assert.equal(S.sections['persona-detail'], 'edit');
  const outer: any = { dataset: { sectionKey: 'persona-detail', sectionId: 'edit' }, hidden: true };
  const inner: any = { dataset: { sectionKey: 'persona-edit', sectionId: 'attributes' }, hidden: true, parentElement: { closest: () => outer } };
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-section-panel]' ? [outer, inner] : [];
  revealSectionField({ closest: () => inner });
  assert.equal(outer.hidden, false); assert.equal(inner.hidden, false);
  assert.equal(S.sections['persona-edit'], 'attributes');
});

test('phase editor keeps question and cohort together with advanced controls in tabs', async () => {
  const browser = browserHarness(); await settle();
  const { S, stageForm } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel';
  const pipeline = S.doc.pipelines[0], html = stageForm(pipeline, pipeline.stages[0]);
  assert.equal((html.match(/data-form="stage"/g) ?? []).length, 1);
  for (const name of ['label', 'phasePool', 'size', 'questionId', 'questionInstructions', 'criteria', 'repeats', 'stageContext']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /data-section-id="question" >/);
  assert.doesNotMatch(html, /data-section-id="cohort"/);
  for (const name of ['label', 'phasePool']) {
    assert.equal((html.match(new RegExp(`name="${name}"`, 'g')) ?? []).length, 1);
    assert.ok(html.indexOf(`name="${name}"`) < html.indexOf('data-section-panel'));
  }
  assert.match(html, /data-section-id="inputs" hidden/);
  assert.match(html, /data-section-id="rules" hidden/);
});

test('target fields survive cohort section switches and persona filters reset pagination', async () => {
  const browser = browserHarness(); await settle();
  const { S, explorerAction } = browser.client;
  S.cohortId = 'cohort'; S.cohortSection = 'distributions';
  S.targetDraft = { field: 'age', kind: 'numeric', buckets: [{ label: 'Adults', min: 18, max: 121, percent: 100 }] };
  const form = { values: { targetField: 'age', targetKind: 'numeric', targetLabel0: 'Edited age group', targetMin0: '20', targetMax0: '40', targetPercent0: '100' } };
  browser.element('app').querySelector = (selector: string) => selector === '[data-form=distribution-target]' ? form : null;
  explorerAction('cohort-section', { dataset: { section: 'people' } });
  assert.equal(S.targetDraft.buckets[0].label, 'Edited age group');
  assert.equal(S.targetDraft.buckets[0].min, 20);
  assert.equal(S.doc.cohorts[0].distributionTargets, undefined, 'tab switching does not apply a target');
  S.listPages['existing-research:personas'] = 30;
  explorerAction('distribution-drill', { dataset: { index: '0' } });
  assert.equal(S.listPages['existing-research:personas'], 0);
  S.listPages['existing-research:personas'] = 30;
  explorerAction('persona-clear-filter', { dataset: {} });
  assert.equal(S.listPages['existing-research:personas'], 0);
});

test('segment paging preserves temporarily non-totaling inputs without applying or rerendering them', async () => {
  const browser = browserHarness(); await settle();
  const { S } = browser.client;
  S.cohortId = 'cohort'; S.cohortSection = 'weights'; S.dirty = true;
  S.doc.cohorts[0].segments = Array.from({ length: 7 }, (_, i) => ({ id: `s${i}`, label: `Group ${i}`, weight: 1, weightBasis: 'assumed', sourceIds: [] }));
  const rows = Array.from({ length: 7 }, () => ({ hidden: false }));
  const pager = { outerHTML: '' }, draft = { value: '30' };
  const shares = { querySelectorAll: () => rows, querySelector: (selector: string) => selector === '.pagination' ? pager : null };
  const button: any = { dataset: { act: 'page-action', pageKey: 'existing-research:segments', page: '1' }, closest: (selector: string) => selector === '[data-form=segment-shares]' ? shares : button };
  browser.element('app').querySelectorAll = (selector: string) => { if (selector === '[data-form]') throw Error('must not flush partially rebalanced shares'); return []; };
  browser.element('app').innerHTML = 'existing editable DOM';
  browser.listeners.get('click')!({ target: { closest: () => button }, preventDefault() {} });
  assert.equal(browser.element('app').innerHTML, 'existing editable DOM');
  assert.deepEqual(rows.map(r => r.hidden), [true, true, true, true, false, false, false]);
  assert.equal(draft.value, '30');
  assert.match(pager.outerHTML, /5–7 of 7/);
  assert.equal(S.doc.cohorts[0].segments[0].weight, 1);
});

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
  assert.match(browser.client.agents(), /Your agent prepares\. Jev evaluates\./);
  browser.client.S.aiSection = 'external';
  const html = browser.client.aiSettingsContent();
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
  assert.match(browser.element('app').innerHTML, /Who answers this question/);
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

test('local assistant refuses stale proposals without posting mutations', async () => {
  const browser = browserHarness();
  await settle();
  const { S, applyLocalProposal } = browser.client;
  S.localJob = { id: 'stale', engine: 'codex', status: 'completed', revision: 0, proposal: { document: browser.snapshot().document, explanation: 'Old proposal' } };
  await assert.rejects(applyLocalProposal(), /Workspace changed/);
  assert.equal(browser.bodies.length, 0);
  assert.match(browser.client.proposalReview(S.localJob), /Prepare a new proposal/);
});

for (const mode of ['cohort', 'persona', 'assistant'] as const) {
  test(`${mode} generation saves typed draft edits first and uses the returned revision`, async () => {
    const browser = browserHarness(); await settle();
    const { S, startCohortJob, startPersonaJob, startLocalJob } = browser.client;
    S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }];
    S.cohortId = 'cohort'; S.personId = 'person'; S.cohortTarget = 'cohort';
    S.cohortPrompt = 'Adults with varied reading habits'; S.cohortSize = 2;
    S.personaRegenPrompt = 'Generate a different individual'; S.localPrompt = 'Draft a reading study';
    S.dirty = true;
    const name = 'Typed cohort brief before generation';
    const form: any = { dataset: { form: 'cohort' }, reportValidity: () => true, values: {
      name, population: 'Adult readers', description: 'Unsubmitted context', generationPrompt: 'Readers', assumptions: 'Synthetic people',
    } };
    form.requestSubmit = () => browser.listeners.get('submit')!({ target: { closest: () => form }, preventDefault() {} });
    browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [form] : [];
    const saved = structuredClone(S.doc);
    Object.assign(saved.cohorts[0], { name, population: 'Adult readers', description: 'Unsubmitted context', generationPrompt: 'Readers', assumptions: ['Synthetic people'] });
    browser.respond('/api/workspace', { revision: 7, document: saved }, 'POST');
    browser.respond('/api/agent/jobs', { id: mode + '-draft', revision: 7, status: 'failed', message: 'No model needed for this test' });
    await ({ cohort: startCohortJob, persona: startPersonaJob, assistant: startLocalJob })[mode]();
    assert.deepEqual(browser.bodies.map(request => request.path), ['/api/workspace', '/api/agent/jobs']);
    assert.deepEqual(browser.bodies[0], { path: '/api/workspace', body: { revision: 1, document: saved } });
    const expectedDetails = mode === 'cohort' ? { prompt: S.cohortPrompt, cohort: { id: 'cohort', size: 2 } }
      : mode === 'persona' ? { prompt: S.personaRegenPrompt, persona: { cohortId: 'cohort', personaId: 'person' } }
      : { prompt: S.localPrompt };
    assert.deepEqual(browser.bodies[1], { path: '/api/agent/jobs', body: { projectId: 'existing-research', engine: 'codex', ...expectedDetails, revision: 7 } });
    assert.equal(S.revision, 7); assert.equal(S.dirty, false); assert.equal(S.doc.cohorts[0].name, name);
    assert.equal(browser.requests.includes('/api/run'), false);
  });
}

test('generation retains unsaved draft and returns to its request tab when autosave fails', async () => {
  for (const mode of ['cohort', 'assistant'] as const) {
    for (const message of ['Workspace revision conflict: expected 1, current revision is 2', 'Workspace could not be written']) {
      const browser = browserHarness(); await settle();
      const { S, startCohortJob, startLocalJob } = browser.client;
      S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }];
      S.cohortPrompt = 'Synthetic adult readers'; S.localPrompt = 'Draft a reading study'; S.dirty = true;
      S.tab = mode === 'cohort' ? 'cohorts' : 'agents'; S.cohortComposer = mode === 'cohort';
      S.sections['cohort-generation'] = 'review'; S.sections.assistant = 'proposal';
      S.doc.cohorts[0].description = 'Keep my unsaved changes';
      const before = JSON.stringify(S.doc);
      browser.fail('/api/workspace', message, 'POST');
      await (mode === 'cohort' ? startCohortJob : startLocalJob)();
      assert.deepEqual(browser.bodies.map(request => request.path), ['/api/workspace']);
      assert.equal(S.localError, message); assert.equal(S.dirty, true); assert.equal(S.revision, 1);
      assert.equal(JSON.stringify(S.doc), before); assert.equal(S.localStarting, false);
      assert.equal(browser.element('app').inert, false);
      const sectionKey = mode === 'cohort' ? 'cohort-generation' : 'assistant', section = mode === 'cohort' ? 'prompt' : 'draft';
      assert.equal(S.sections[sectionKey], section);
      assert.match(browser.element('app').innerHTML, new RegExp('data-section-key="' + sectionKey + '" data-section-id="' + section + '" >'));
      assert.equal(browser.element('app').innerHTML.includes(message), true, 'save error remains visible in the active request panel');
    }
  }
});


test('invalid editor fields stop generation before saving and leave the draft intact', async () => {
  const browser = browserHarness(); await settle();
  const { S, startPersonaJob } = browser.client;
  S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }];
  S.cohortId = 'cohort'; S.personId = 'person'; S.dirty = true;
  const before = JSON.stringify(S.doc); let checked = 0;
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [{
    dataset: { form: 'persona' }, reportValidity: () => { checked++; return false; },
    requestSubmit: () => assert.fail('Invalid form must not submit'),
  }] : [];
  await assert.rejects(startPersonaJob(), /Complete the invalid fields/);
  assert.equal(checked, 1); assert.equal(S.dirty, true); assert.equal(JSON.stringify(S.doc), before);
  assert.equal(browser.bodies.length, 0); assert.equal(S.localStarting, false);
});

test('draft start remains locked across autosave and job request and ignores an in-flight refresh', async () => {
  const browser = browserHarness(); await settle();
  const { S, refresh, startCohortJob, selectProject } = browser.client;
  S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }]; S.cohortPrompt = 'Synthetic adult readers';
  let finishRefresh!: (value: unknown) => void, finishSave!: (value: unknown) => void, finishStart!: (value: unknown) => void;
  browser.respond('/api/workspace', new Promise(resolve => { finishRefresh = resolve; }), 'GET');
  browser.respond('/api/workspace', new Promise(resolve => { finishSave = resolve; }), 'POST');
  browser.respond('/api/agent/jobs', new Promise(resolve => { finishStart = resolve; }));
  const refreshing = refresh();
  S.dirty = true; S.doc.cohorts[0].name = 'Current typed audience';
  const saved = structuredClone(S.doc), starting = startCohortJob();
  assert.equal(S.localStarting, true); assert.equal(browser.element('app').inert, true);
  assert.match(browser.element('app').innerHTML, /Saving your latest edits/);
  assert.doesNotMatch(browser.element('app').innerHTML, /Wait for the current draft/);
  assert.equal(S.sections['cohort-generation'], 'review');
  assert.throws(() => selectProject(null), /Wait for the drafting request/);
  await startCohortJob();
  finishRefresh({ ...browser.snapshot(), revision: 99 }); await refreshing;
  assert.equal(S.revision, 1); assert.equal(S.remoteRevision, null); assert.equal(S.doc.cohorts[0].name, 'Current typed audience');
  finishSave({ revision: 7, document: saved }); await settle();
  assert.equal(S.revision, 7); assert.equal(S.localStarting, true); assert.equal(browser.element('app').inert, true);
  assert.match(browser.element('app').innerHTML, /Checking AI connection/);
  await startCohortJob();
  await browser.listeners.get('change')!({ target: { name: 'localEngine', value: 'claude' } });
  browser.listeners.get('click')!({ target: { closest: () => ({ dataset: { act: 'projects' } }) }, preventDefault() {} });
  assert.equal(S.localEngine, 'codex'); assert.equal(S.projectId, 'existing-research');
  assert.deepEqual(browser.bodies.map(request => request.path), ['/api/workspace', '/api/agent/jobs']);
  assert.equal((browser.bodies[1]!.body as any).revision, 7);
  finishStart({ id: 'single-start', revision: 7, status: 'failed', message: 'Finished without inference' }); await starting;
  assert.equal(S.localStarting, false); assert.equal(S.localLoading, false); assert.equal(browser.element('app').inert, false);
});

test('global AI settings preserve editor DOM and draft state across workspace views', async () => {
  const browser = browserHarness(); await settle();
  const { S, render, aiSettingsContent } = browser.client;
  const engines = [{ id: 'codex', label: 'Codex', available: true }, { id: 'chatgpt', label: 'ChatGPT subscription', available: true }];
  S.localEngines = engines; S.localEngine = 'codex';
  browser.respond('/api/local-agents', { engines });
  browser.respond('/api/chatgpt/status', { connected: true, planEnabled: true, account: { id: 'account', label: 'Account' }, accounts: [] });
  browser.respond('/api/chatgpt/models', { models: [{ id: 'draft-model', name: 'Draft model' }] });
  const click = (act: string) => browser.listeners.get('click')!({ target: { closest: () => ({ dataset: { act } }) }, preventDefault() {} });
  for (const [index, view] of ['cohorts', 'persona', 'studies', 'agents'].entries()) {
    const tab = view === 'persona' ? 'cohorts' : view;
    S.tab = tab; S.dirty = index !== 0; S.cohortId = 'cohort'; S.personId = 'person';
    S.pipelineId = 'study'; S.stageId = 'panel';
    S.personaOpen = view === 'persona'; S.personaRegenOpen = view === 'persona'; S.sections['persona-detail'] = 'regenerate';
    S.cohortComposer = view === 'cohorts'; S.cohortPrompt = 'Typed cohort prompt'; S.localPrompt = 'Typed assistant request';
    render();
    assert.doesNotMatch(browser.element('app').innerHTML, /name="(?:localEngine|chatgptModel|chatgptCustomModelId)"/);
    const draft = JSON.stringify(S.doc), dirty = S.dirty, currentDom = 'Unsaved editor DOM with caret ' + tab;
    browser.element('app').innerHTML = currentDom;
    browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [{
      dataset: { form: 'cohort' }, reportValidity: () => assert.fail('AI settings must not validate the draft'),
    }] : [];
    click('ai-open'); await settle();
    assert.equal(browser.element('aiSettingsDialog').open, true);
    await browser.listeners.get('change')!({ target: { name: 'localEngine', value: 'chatgpt' } });
    await browser.listeners.get('change')!({ target: { name: 'chatgptModel', value: 'draft-model' } });
    click('ai-close');
    assert.equal(browser.element('aiSettingsDialog').open, false);
    assert.equal(browser.element('app').innerHTML, currentDom); assert.equal(JSON.stringify(S.doc), draft); assert.equal(S.dirty, dirty);
    assert.equal(S.cohortPrompt, 'Typed cohort prompt'); assert.equal(S.localPrompt, 'Typed assistant request');
    assert.equal(S.localEngine, 'chatgpt'); assert.equal(S.chatgptModel, 'draft-model');
    assert.match(browser.element('aiLabel').textContent, /ChatGPT.*draft-model/);
    assert.match(aiSettingsContent(), /name="localEngine"/);
  }
  assert.equal(browser.bodies.length, 0, 'connection preferences never save or generate a workspace');
});

test('AI provider and account-scoped custom model preferences restore without saving draft data', async () => {
  const preferences = new Map<string, string>();
  const browser = browserHarness(true, preferences); await settle();
  const { S } = browser.client;
  S.chatgpt = { connected: true, planEnabled: true, account: { id: 'first-account' } };
  S.localEngines = [{ id: 'chatgpt', available: true }, { id: 'claude', available: true }];
  await browser.listeners.get('change')!({ target: { name: 'localEngine', value: 'chatgpt' } });
  await browser.listeners.get('change')!({ target: { name: 'chatgptModel', value: '__custom__' } });
  browser.listeners.get('input')!({ target: { name: 'chatgptCustomModelId', value: 'gpt-6.1-sol' } });
  await browser.listeners.get('change')!({ target: { name: 'localEngine', value: 'claude' } });
  assert.deepEqual(JSON.parse(preferences.get('jev-ai-selection')!), { provider: 'claude', accountId: 'first-account', model: 'gpt-6.1-sol', custom: true });
  const reopened = browserHarness(true, preferences);
  assert.equal(reopened.client.S.localEngine, 'claude', 'provider restores before connection checks finish');
  reopened.respond('/api/local-agents', { engines: [{ id: 'chatgpt', available: true }, { id: 'claude', available: true }] });
  reopened.respond('/api/chatgpt/status', { connected: true, planEnabled: true, account: { id: 'first-account' } });
  reopened.respond('/api/chatgpt/models', { models: [{ id: 'older-model', name: 'Older model' }] });
  await settle();
  assert.equal(reopened.client.S.localEngine, 'claude');
  assert.equal(reopened.client.S.chatgptModel, 'gpt-6.1-sol'); assert.equal(reopened.client.S.chatgptCustomModel, true);
  reopened.respond('/api/chatgpt/status', { connected: true, planEnabled: true, account: { id: 'second-account' } });
  await reopened.client.loadChatGpt();
  assert.equal(reopened.client.S.chatgptModel, '', 'custom model does not carry into another account');
  assert.equal(reopened.client.S.chatgptCustomModel, false);
  assert.equal(S.dirty, false); assert.equal(reopened.client.S.dirty, false);
  assert.equal(browser.bodies.length + reopened.bodies.length, 0, 'preferences do not persist through workspace writes');
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
  assert.match(html, /Studies: 0 added · 1 changed · 1 removed/);
  assert.match(html, /Removed cohort: <strong>Archived &lt;audience&gt;<\/strong> <code>\(removed-pool\)<\/code> · 1 personas removed/);
  assert.match(html, /Removed study: <strong>Retired study<\/strong> <code>\(removed-pipeline\)<\/code> · 1 phases removed/);
  assert.match(html, /Changed cohort:.*1 personas removed/);
  assert.match(html, /Changed study:.*1 phases removed/);
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
  S.cohortPrompt = 'Synthetic adult hikers'; S.cohortSize = 3; S.localEngine = 'codex'; S.localEngines = [{ id: 'codex', available: true }];
  S.dirty = true; assert.equal(canGenerateCohort(), true, 'valid unsaved edits do not block generation');
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
  const html = browser.client.aiSettingsContent(); assert.match(html, /&lt;unsafe account&gt;/);
  S.aiSection = 'evaluations'; assert.match(browser.client.aiSettingsContent(), /TypeSafe/); S.aiSection = 'drafting';
  assert.doesNotMatch(agents(), /name="(?:localEngine|chatgptModel)"/);
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
  assert.match(browser.client.aiSettingsContent(), /value="__custom__" selected/);
  assert.doesNotMatch(browser.client.cohortGenerator(), /name="(?:localEngine|chatgptModel)"/);
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
  S.dirty = true; assert.match(cohortBlockReason(), /Choose a drafting model/);
  S.chatgptModel = 'chosen-model'; assert.equal(cohortBlockReason(), '');
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

test('project creation requires explicit entry and cancellation preserves its draft without changing projects', async () => {
  const browser = browserHarness(false); await settle();
  const { S, act, render, selectProject } = browser.client;
  const html = () => browser.element('app').innerHTML;
  const before = JSON.stringify(S.doc);
  assert.match(html(), /data-act="new-project"/);
  assert.doesNotMatch(html(), /data-form="new-project"/);
  act({}, { dataset: { act: 'new-project' } });
  assert.match(html(), /data-form="new-project"/);
  assert.doesNotMatch(html(), /data-act="open-project"/);
  for (const [name, value] of [['projectName', 'Research in progress'], ['projectBrief', 'A brief to keep']]) {
    browser.listeners.get('input')!({ target: { name, value, closest: () => ({ dataset: { form: 'new-project' } }) } });
  }
  act({}, { dataset: { act: 'cancel-project' } });
  assert.doesNotMatch(html(), /data-form="new-project"/);
  assert.equal(JSON.stringify(S.doc), before);
  assert.equal(S.dirty, false);
  assert.equal(browser.bodies.length, 0);
  act({}, { dataset: { act: 'new-project' } });
  assert.match(html(), /Research in progress/);
  assert.match(html(), /A brief to keep/);
  selectProject('existing-research');
  selectProject(null);
  assert.equal(S.projectComposer, false);
  assert.doesNotMatch(html(), /data-form="new-project"/);
  S.doc.projects = []; render();
  assert.match(html(), /Start your first project/);
  assert.match(html(), /data-act="new-project"/);
  assert.doesNotMatch(html(), /data-form="new-project"/);
});

test('failed project creation exposes the inserted draft and Save changes for recovery', async () => {
  const browser = browserHarness(false); await settle();
  const { S, act } = browser.client;
  browser.fail('/api/workspace', 'Save unavailable', 'POST');
  act({}, { dataset: { act: 'new-project' } });
  const form = { dataset: { form: 'new-project' }, values: { projectName: 'Recoverable project', projectBrief: 'Keep this brief' } };
  browser.listeners.get('submit')!({ target: { closest: () => form }, preventDefault() {} });
  await settle();
  assert.equal(S.projectComposer, false);
  assert.equal(S.dirty, true);
  assert.equal(S.doc.projects.filter((p: any) => p.name === 'Recoverable project').length, 1);
  assert.equal(S.doc.projects.at(-1).description, 'Keep this brief');
  const html = browser.element('app').innerHTML;
  assert.match(html, /Recoverable project/);
  assert.match(html, /data-act="save"/);
  assert.doesNotMatch(html, /data-form="new-project"/);
  assert.equal(browser.bodies.filter(r => r.path === '/api/workspace').length, 1);
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
  assert.match(html, /1–3 of 50/);
  browser.client.act(null, { dataset: { act: 'page-action', pageKey: 'existing-research:personas', page: '8' } });
  html = browser.element('app').innerHTML;
  assert.match(html, /25–27 of 50/);
  assert.match(html, /South/);
  S.personaFilter = { field: 'attributes.region', bucket: { label: 'North', value: 'North' } };
  S.personaPage = 0; S.listPages['existing-research:personas'] = 0; html = cohortExplorer(cohort);
  assert.match(html, /Showing Region: North/);
  assert.match(html, /1–3 of 25/);
  assert.doesNotMatch(html, /Person 2</);
  explorerAction('persona-clear-filter', { dataset: {} });
  assert.equal(S.personaFilter, null);
  assert.match(browser.element('app').innerHTML, /of 50/);
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
  assert.match(html, /role="group" aria-label="Cohort actions"/);
  assert.doesNotMatch(html, /More cohort actions|cohort-management/);
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
  assert.equal(S.doc.pipelines[0].name, 'Renamed project study');
  assert.equal(S.sections.pipeline, 'phase');
  assert.equal(S.sections['phase-' + S.stageId], 'question');
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


test('generation progress reports accepted counts without inventing completion or elapsed-driven progress', async () => {
  const browser = browserHarness(); await settle();
  const { S, draftProgress, cohortGenerator, updateDraftClocks, canGenerateCohort } = browser.client;
  const job = { id: 'progress', engine: 'chatgpt', model: 'chosen-model', status: 'running', startedAt: new Date(Date.now() - 65000).toISOString(), cohort: { id: 'new', size: 60 }, progress: { phase: 'generating', batch: 2, totalBatches: 3, completedBatches: 1, completedPersonas: 25, totalPersonas: 60 } };
  S.localJob = job; S.cohortTarget = 'new'; S.sections['cohort-generation'] = 'review';
  let html = draftProgress(job);
  assert.match(html, /25 \/ 60/); assert.match(html, /value="25" max="60"/);
  assert.match(html, /Generating batch 2 of 3/); assert.match(html, /1 of 3 batches checked/);
  assert.match(html, /ChatGPT · chosen-model/); assert.match(html, /1m 5s elapsed/);
  assert.match(html, /Counts update after validation/); assert.match(html, /Cancel generation/);
  assert.doesNotMatch(cohortGenerator(), /Wait for the current draft/);
  assert.equal(canGenerateCohort(), false);
  const clock = { dataset: { draftStart: job.startedAt }, textContent: '' };
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-draft-start]' ? [clock] : [];
  updateDraftClocks(); assert.match(clock.textContent, /1m 5s elapsed/);
  assert.equal(S.localJob.progress.completedPersonas, 25);
  html = draftProgress({ ...job, progress: { ...job.progress, phase: 'validating' } });
  assert.match(html, /Checking batch 2 of 3/); assert.doesNotMatch(html, /Checking the complete draft/);
  html = draftProgress({ ...job, progress: { ...job.progress, phase: 'validating', completedBatches: 3, completedPersonas: 60 } });
  assert.match(html, /Checking the complete draft/); assert.doesNotMatch(html, /Draft ready/);
  html = draftProgress({ id: 'general', status: 'running', engine: 'codex' });
  assert.doesNotMatch(html, /<progress|personas checked|elapsed/);
});

test('poll interruption stays visible in progress and can reconnect without another generation', async () => {
  const browser = browserHarness(); await settle();
  const { S, pollLocalJob, cohortGenerator } = browser.client;
  S.cohortComposer = true; S.cohortTarget = 'new'; S.sections['cohort-generation'] = 'review';
  S.localJob = { id: 'interrupted', engine: 'codex', status: 'running', cohort: { id: 'new', size: 2 } };
  browser.fail('/api/agent/jobs/interrupted', 'Local server unavailable');
  const polling = pollLocalJob('interrupted'); browser.timeouts.at(-1)!(); await polling;
  assert.equal(S.localJob.status, 'running');
  assert.match(cohortGenerator(), /Status connection interrupted/);
  assert.match(cohortGenerator(), /Reconnect progress/);
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [{ reportValidity: () => assert.fail('reconnecting must not validate unrelated edits') }] : [];
  browser.listeners.get('click')!({ target: { closest: () => ({ dataset: { act: 'assistant-status-retry' } }) }, preventDefault() {} });
  assert.equal(S.localPollError, null);
  assert.equal(browser.bodies.length, 0, 'reconnecting never submits a generation');
  S.localJob.status = 'cancelled'; browser.timeouts.at(-1)!(); await settle();
});

test('recovering active cohort generation selects Progress with actual server counts', async () => {
  const browser = browserHarness(); await settle();
  browser.storage.set('jev-local-job:http://127.0.0.1:4180:existing-research', 'active');
  browser.respond('/api/local-agents', { engines: [{ id: 'codex', available: true }] });
  browser.respond('/api/agent/jobs/active', { id: 'active', engine: 'codex', status: 'running', cohort: { id: 'new', size: 60, prompt: 'Adult readers' }, progress: { phase: 'generating', completedPersonas: 25, totalPersonas: 60, batch: 2, totalBatches: 3, completedBatches: 1 } });
  await browser.client.loadLocalAgents();
  assert.equal(browser.client.S.sections['cohort-generation'], 'review');
  assert.match(browser.element('app').innerHTML, /data-section-id="review" >[\s\S]*25 \/ 60/);
  assert.match(browser.element('app').innerHTML, />Progress<\/button>/);
  assert.doesNotMatch(browser.element('app').innerHTML, /Wait for the current draft/);
  browser.client.S.localJob.status = 'cancelled'; browser.timeouts.at(-1)!(); await settle();
});


test('poll errors stay with their project and clear when a matching response succeeds', async () => {
  const browser = browserHarness(); await settle();
  const { S, pollLocalJob, selectProject } = browser.client;
  const job = { id: 'resume', status: 'running', engine: 'codex', revision: S.revision };
  S.localJob = job; S.localPollError = 'Temporary disconnect';
  selectProject(null); assert.equal(S.localPollError, null);
  browser.respond('/api/agent/jobs/resume', { ...job, status: 'completed' });
  selectProject('existing-research');
  assert.equal(S.localPollError, 'Temporary disconnect');
  browser.timeouts.at(-1)!(); await settle();
  assert.equal(S.localJob.status, 'completed'); assert.equal(S.localPollError, null);
  await pollLocalJob('resume');
});


test('changing an intermediate cohort keeps other phase cohorts and inputs independent', async () => {
  for (const mapping of [{ audience: 'cohort' }, { audience: '' }, { audience: 'cohort', experts: 'reviewers' }]) {
    const browser = browserHarness(); await settle();
    const { S, applyStage, act } = browser.client;
    const pipeline = S.doc.pipelines[0];
    S.doc.cohorts.push({ ...structuredClone(S.doc.cohorts[0]), id: 'reviewers', name: 'Reviewers' });
    S.doc.projects[0].cohortIds.push('reviewers');
    pipeline.cohorts = structuredClone(mapping);
    const first = pipeline.stages[0];
    const middle = { ...structuredClone(first), id: 'middle', label: 'Review',
      dependsOn: ['panel'], inputs: { evidence: { stage: 'panel', question: 'answer', select: 'summary' } } };
    const last = { ...structuredClone(first), id: 'last' };
    pipeline.stages.push(middle, last);
    S.tab = 'studies'; S.pipelineId = pipeline.id; S.stageId = 'panel';
    S.sections.pipeline = 'flow'; S.sections['phase-middle'] = 'rules';
    act(null, { dataset: { act: 'stage', id: 'middle' } });
    assert.equal(S.sections.pipeline, 'phase');
    assert.equal(S.sections['phase-middle'], 'question');
    const before = JSON.stringify([first, last]);
    const values: Record<string, string> = {
      label: 'Expert review', phasePool: 'reviewers', size: '', repeats: '1', join: 'all', stageContext: '{}',
      bindingName0: 'evidence', bindingStage0: 'panel', bindingQuestion0: 'answer', bindingSelect0: 'summary',
      questionId: 'answer', questionLabel: 'Which option should advance?', questionInstructions: 'Evaluate the earlier evidence.',
      questionType: 'choice', criteria: 'a: A\nb: B',
    };
    const question = { querySelector: (selector: string) => ({ value: values[selector.match(/name="(.+)"/)![1]!] }) };
    const form = { values, querySelector: () => null, querySelectorAll: (selector: string) =>
      selector === '[name=dependsOn]:checked' ? [{ value: 'panel' }] :
      selector === '[data-phase-input]' ? [{}] : selector === '.question-card' ? [question] : [] };
    applyStage(form);
    assert.equal(pipeline.cohorts[middle.cohort], 'reviewers');
    assert.equal(pipeline.cohorts.audience, mapping.audience);
    if ('experts' in mapping) assert.equal(middle.cohort, 'experts');
    assert.equal(JSON.stringify([first, last]), before);
    assert.deepEqual(JSON.parse(JSON.stringify(middle.inputs)), { evidence: { stage: 'panel', question: 'answer', select: 'summary' } });
    assert.equal(middle.questions.answer.label, 'Which option should advance?');
    assert.equal(middle.questions.answer.instructions, 'Evaluate the earlier evidence.');
    if (mapping.audience === '') {
      for (const stage of [first, last]) {
        S.stageId = stage.id;
        applyStage({ ...form, querySelectorAll: (selector: string) => selector === '.question-card' ? [question] : [] });
      }
      assert.equal(Object.values(pipeline.cohorts).includes(''), false, 'completed assignments leave no unresolved unused aliases');
      assert.ok(pipeline.stages.every((stage: any) => pipeline.cohorts[stage.cohort] === 'reviewers'));
    }
  }
});
