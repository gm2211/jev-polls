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
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, inert: false, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {}, addEventListener() {}, open: false, showModal() { this.open = true; }, close() { this.open = false; } });
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
    navigator: {}, URL, Blob, TextEncoder, confirm: () => { throw new Error('Unexpected native confirmation'); },
    FormData: TestFormData,
  };
  const html = renderWorkspace('test', 'token');
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.clientTest={S,runs,updateAISettings,updateAuth,runUsageText,draftProgress,draftEstimate,updateDraftClocks,reviewPlan,selectProject,project,projectCohorts,projectPipelines,projectRuns,projects,render,refresh,reloadSaved,applySnapshot,agents,copyAgentText,act,freshPipeline,addNextPhase,addPhaseInput,projectionOptions,dataInputOptions,startLocalJob,applyLocalProposal,proposalReview,aiSettingsContent,graphEdgePath,drawStageEdges,cohortGenerator,startCohortJob,adoptCohortProposal,cohortProposalReview,canGenerateCohort,pollLocalJob,cancelLocalJob,cohorts,cohortCard,deleteCohortFromDraft,loadChatGpt,loadLocalAgents,cohortBlockReason,cohortExplorer,personaDetail,explorerAction,cohortDistributions,targetEditor,startPersonaJob,adoptPersonaProposal,segmentShares,applySegmentShares,pageItems,sectionPanels,revealSectionField,stageForm,advancedStageForm,studies,review,say,applyStage,applyStudySetup,setupAction,setupContextSummary,inputTitle,stepTitle,stageMap,studyQuestionList,validateSetupAnswers,questionParts,upsertQuestion,openAnswerList,closeAnswerList,answerListAction,answerListValues,applyAnswerList,readAnswerListFile,updateAnswerList};})();');
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

test('evaluation provider is global, persists, and invalidates only its reviewed plan', async () => {
  const preferences = new Map<string, string>([['jev-evaluation-provider', 'gliner']]);
  const browser = browserHarness(true, preferences); await settle();
  const { S, aiSettingsContent, reviewPlan } = browser.client;
  assert.equal(S.evaluationProvider, 'gliner'); S.aiSection = 'evaluations';
  S.snap.gliner = { ready: true, model: 'fastino/GLiNER2.5-Decide' };
  assert.match(aiSettingsContent(), /Local model installed/);
  assert.doesNotMatch(aiSettingsContent(), /Update API key/);
  S.pipelineId = 'study'; S.tab = 'studies';
  browser.respond('/api/plan', { pipelineId: 'study', provider: 'gliner', model: 'fastino/GLiNER2.5-Decide', maxRequests: 1, stages: [], warnings: [], revision: 1, planToken: 'test' }, 'POST');
  await reviewPlan();
  assert.equal((browser.bodies.at(-1)!.body as any).provider, 'gliner');
  assert.match(browser.element('app').innerHTML, /Runs locally with GLiNER/);
  assert.doesNotMatch(browser.element('app').innerHTML, /uses your account balance/);
  const before = JSON.stringify(S.doc);
  await browser.listeners.get('change')!({ target: { name: 'evaluationProvider', value: 'typesafe' } });
  assert.equal(S.plan, null); assert.equal(S.evaluationProvider, 'typesafe');
  assert.equal(preferences.get('jev-evaluation-provider'), 'typesafe');
  assert.equal(JSON.stringify(S.doc), before); assert.equal(S.dirty, false);
});

test('evaluation readiness refresh updates run controls without replacing the form', async () => {
  const browser = browserHarness(); await settle();
  const { S, updateAuth, runUsageText } = browser.client;
  S.plan = { provider: 'gliner' }; S.snap.gliner = { ready: false };
  const start = { disabled: false }, setup = { hidden: true };
  const root = browser.element('app'); root.innerHTML = 'Review form with unsaved run settings';
  root.querySelector = (selector: string) => selector === '[data-act=start-run]' ? start : setup;
  updateAuth(); assert.equal(start.disabled, true); assert.equal(setup.hidden, false);
  S.snap.gliner.ready = true; updateAuth();
  assert.equal(start.disabled, false); assert.equal(setup.hidden, true);
  assert.equal(root.innerHTML, 'Review form with unsaved run settings');
  S.plan.provider = 'typesafe'; S.snap.auth.configured = false; browser.client.updateAISettings();
  assert.equal(start.disabled, true);
  S.snap.auth.configured = true; browser.client.updateAISettings(); assert.equal(start.disabled, false);
  assert.equal(runUsageText({ requests: 2, inputTokens: 0, outputTokens: 0, tokenUsage: 'unreported', measuredInputTokens: 123 }), '2 model requests · 123 measured input tokens · API token usage not reported');
  assert.equal(runUsageText({ requests: 2, inputTokens: 10, outputTokens: 4 }), '2 model requests · 10 input / 4 output tokens');
  S.snap.runs = [{ projectId: S.projectId, id: 'local-run', pipelineName: 'Local', status: 'completed', createdAt: '2026-10-06T12:00:00Z', message: 'Done', usage: { requests: 2, inputTokens: 0, outputTokens: 0, tokenUsage: 'unreported', measuredInputTokens: 123 } }];
  assert.match(browser.client.runs(), /123 measured input tokens/);
  assert.doesNotMatch(browser.client.runs(), /0 input \/ 0 output tokens/);
});

test('global Data tools export current edits without saving or duplicating controls in editors', async () => {
  const browser = browserHarness(); await settle();
  const { S, render, selectProject } = browser.client;
  const click = (act: string) => browser.listeners.get('click')!({ target: { closest: () => ({ dataset: { act } }) }, preventDefault() {} });
  const before = JSON.stringify(S.doc);
  S.tab = 'project-settings'; S.dirty = true; render();
  let submitted = 0;
  const form: any = { dataset: { form: 'project-settings' }, reportValidity: () => true, values: { name: 'Typed before export', description: 'Unsaved project brief' } };
  form.requestSubmit = () => { submitted++; browser.listeners.get('submit')!({ target: { closest: () => form }, preventDefault() {} }); };
  browser.element('app').querySelectorAll = (selector: string) => selector === '[data-form]' ? [form] : [];
  browser.element('exportDownload').href = '';
  click('data-open');
  assert.equal(browser.element('dataToolsDialog').open, true);
  assert.equal(submitted, 0, 'Opening Data must not change or validate the draft');
  assert.equal(JSON.stringify(S.doc), before);
  click('export');
  assert.equal(browser.element('dataToolsDialog').open, false);
  assert.equal(browser.element('exportDialog').open, true);
  assert.equal(submitted, 1);
  assert.equal(JSON.parse(browser.element('exportJson').value).projects[0].name, 'Typed before export');
  assert.equal(S.dirty, true);
  assert.equal(browser.bodies.length, 0, 'Export must not save or send the draft');
  URL.revokeObjectURL(browser.element('exportDownload').href);
  click('export-close'); click('data-open'); click('import-open');
  assert.equal(browser.element('dataToolsDialog').open, false);
  assert.equal(browser.element('importDialog').open, true);
  click('import-close');
  S.cohortId = 'cohort'; S.tab = 'cohorts'; render();
  assert.doesNotMatch(browser.element('app').innerHTML, /data-act="(?:export|import-open)"/);
  selectProject(null);
  assert.doesNotMatch(browser.element('app').innerHTML, /Workspace files|data-act="(?:export|import-open)"/);
  const shell = renderWorkspace('test', 'token');
  assert.match(shell, /id="dataToolsPill"[^>]*aria-controls="dataToolsDialog"/);
  assert.equal([...shell.matchAll(/<button[^>]*data-act="export"/g)].length, 1);
  assert.equal([...shell.matchAll(/<button[^>]*data-act="import-open"/g)].length, 1);
});

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
  const { S, advancedStageForm } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel';
  const pipeline = S.doc.pipelines[0], html = advancedStageForm(pipeline, pipeline.stages[0]);
  assert.equal((html.match(/data-form="stage"/g) ?? []).length, 1);
  for (const name of ['label', 'size', 'questionId', 'questionInstructions', 'criteria', 'repeats', 'stageContext']) {
    assert.match(html, new RegExp(`name="${name}"`));
  }
  assert.match(html, /data-section-id="rules" >/);assert.doesNotMatch(html,/name="phasePool"/);
  assert.doesNotMatch(html, /data-section-id="cohort"/);
  assert.equal((html.match(/name="label"/g)??[]).length,1);
  assert.match(html, /data-section-id="inputs" hidden/);
  assert.match(html, /data-section-id="instructions" hidden/);
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
  assert.match(browser.element('app').innerHTML, /This cohort also sees results from:/);
  assert.match(browser.element('app').innerHTML, /Who answers/);
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

test('projects start from a question and assign cohorts only after an explicit choice', async () => {
  const browser = browserHarness(false); await settle();
  const { S, selectProject, render, freshPipeline, act } = browser.client;
  const html = () => browser.element('app').innerHTML;
  const study = S.doc.pipelines[0];
  study.context = { decisionQuestion: 'Earlier question' };
  study.description = 'Which direction should we choose?';
  const before = JSON.stringify(S.doc);
  selectProject('existing-research');
  assert.equal(S.tab, 'studies');
  assert.equal(S.pipelineId,null);assert.match(html(),/Your studies/);
  act(null,{dataset:{act:'open-pipeline',id:'study'}});
  assert.match(html(), /<h1[^>]*>Which direction should we choose\?<\/h1>/);
  assert.match(html(), /aria-label="Study editor"/);assert.doesNotMatch(html(), /id="tab-cohorts"/);
  assert.equal(JSON.stringify(S.doc), before);
  S.tab = 'cohorts'; S.cohortPrompt = 'Keep this unfinished cohort prompt';
  selectProject(null); selectProject('existing-research');
  assert.equal(S.tab, 'cohorts');
  assert.equal(S.cohortPrompt, 'Keep this unfinished cohort prompt');

  S.doc.pipelines = []; S.doc.projects[0].pipelineIds = [];
  S.tab = 'studies'; render();
  assert.match(html(), /What question do you want to answer\?/);
  assert.doesNotMatch(html(), /data-act="new-cohort"|A clean research bench/);
  assert.equal(freshPipeline('Question first').cohorts.audience, '');
  S.preferredCohortId = 'cohort';
  assert.equal(freshPipeline('Use this audience').cohorts.audience, 'cohort');
  S.newQuestion = 'Which name best fits our game?';
  act(null, { dataset: { act: 'draft-question' } });
  assert.equal(S.tab, 'agents');
  assert.match(S.localPrompt, /Which name best fits our game\?/);
  assert.equal(S.doc.pipelines.length, 0);
  assert.equal(S.doc.cohorts.length, 1);
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

test('run navigation requires recorded project ownership and opens reports without replacing the draft', async () => {
  const browser = browserHarness(); await settle();
  const { S, projectRuns, projects, render, cohortGenerator, aiSettingsContent } = browser.client;
  S.snap.runs = [
    { id: 'owned', projectId: 'existing-research', pipelineId: 'study', pipelineName: 'Owned run', createdAt: '2026-10-06', status: 'completed', message: 'Complete', reportUrl: '/reports/owned' },
    { id: 'legacy', pipelineId: 'study', pipelineName: 'Legacy run' },
    { id: 'other', projectId: 'another-project', pipelineId: 'study', pipelineName: 'Other run' },
  ];
  assert.deepEqual(Array.from(projectRuns(), (r: any) => r.id), ['owned']);
  assert.deepEqual(Array.from(projectRuns('missing-project')), []);
  assert.doesNotMatch(projects(), /Earlier runs|Legacy run|Other run/);
  S.tab = 'runs'; S.dirty = true;
  const before = JSON.stringify(S.doc);
  render();
  assert.match(browser.element('app').innerHTML, /href="[^"]*\/reports\/owned" target="_blank" rel="noopener noreferrer"/);
  assert.equal(S.dirty, true);
  assert.equal(JSON.stringify(S.doc), before);
  S.localEngine = 'chatgpt';
  S.chatgpt = { connected: true, planEnabled: true, account: { id: 'account', label: 'Test account' } };
  const settings = aiSettingsContent();
  assert.match(settings, /data-act="chatgpt-disconnect"/);
  const generator = cohortGenerator();
  assert.match(generator, /data-act="manual-cohort"/);
  for (const html of [settings, generator]) {
    for (const details of html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)) assert.doesNotMatch(details[1]!, /<(?:button|input|select|a)\b/);
  }
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
  const { S, cohorts, cohortCard } = browser.client;
  S.cohortId = 'cohort'; S.personId = 'person'; S.dirty = true;
  const html = cohorts();
  assert.match(html, /Unsaved changes/);
  assert.match(html, /data-act="save"/);
  assert.doesNotMatch(html+cohortCard(S.doc.cohorts[0]), /Use in study|data-act="pool-study"/);
  assert.match(html, /data-act="delete-cohort"/);
  assert.match(html, /role="group" aria-label="Cohort actions"/);
  assert.doesNotMatch(html, /More cohort actions|cohort-management/);
  assert.doesNotMatch(html, /running this study|Review before inference/i);
});

test('workspace tabs clear cohort selections and open the study library while preserving the draft', async () => {
  const browser = browserHarness(); await settle();
  const { S, act } = browser.client;
  const draft = structuredClone(S.doc);
  S.tab = 'cohorts'; S.cohortId = 'cohort'; S.personId = 'person';
  act(null, { dataset: { act: 'tab', tab: 'cohorts' } });
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.doesNotMatch(browser.element('app').innerHTML, /Back to cohorts|Back to cohort/);
  assert.equal(S.cohortId, null); assert.equal(S.personId, null);
  assert.equal(S.cohortComposer, false); assert.equal(S.cohortReturn, null);
  assert.deepEqual(JSON.parse(JSON.stringify(S.doc)), JSON.parse(JSON.stringify(draft)));

  S.pipelineId = 'study'; S.stageId = 'panel';
  act(null, { dataset: { act: 'tab', tab: 'studies' } });
  assert.equal(S.pipelineId, null);
  assert.match(browser.element('app').innerHTML, /role="tablist"/);
  assert.match(browser.element('app').innerHTML, /Your studies/);
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
  assert.match(html, /name="segmentId"/);
  for (const details of html.matchAll(/<details\b[^>]*>([\s\S]*?)<\/details>/g)) assert.doesNotMatch(details[1]!, /<(?:button|input|select)\b/);
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
  assert.match(html, /25 <span>\/ 60/); assert.match(html, /value="25" max="60"/);
  assert.match(html, /Generating batch 2 of 3/); assert.doesNotMatch(html, /batches checked/);
  assert.match(html, /ChatGPT · chosen-model/); assert.match(html, /1m 5s elapsed/);
  assert.match(html, /personas generated/); assert.doesNotMatch(html, /Waiting for ChatGPT|Counts update after validation/); assert.match(html, /Cancel generation/);
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
  assert.match(browser.element('app').innerHTML, /data-section-id="review" >[\s\S]*value="25" max="60"/);
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


test('progress exposes observed activity, synthetic previews and real checks without changing draft fields', async () => {
  const browser = browserHarness(); await settle();
  const { S, draftProgress } = browser.client;
  const job = { id: 'streamed', status: 'running', engine: 'chatgpt', cohort: {size:100}, progress: { phase:'generating', totalPersonas:100, completedPersonas:25, batch:2, totalBatches:4, batchSize:25, activity:'receiving', outputChars:12500, lastActivityAt:new Date().toISOString(), latestAccepted:[{label:'Synthetic reader <script>',age:42}], validation:{scope:'batch',status:'passed',checks:['Required fields and adult ages','Expected batch size'],checkedPersonas:25} } };
  S.localJob=job; S.cohortComposer=true; S.cohortTarget='new'; S.sections['cohort-generation']='review';
  assert.match(draftProgress(job), /Response arriving/);
  assert.match(draftProgress(job), /12,500 characters received/);
  assert.match(draftProgress(job), /synthetic draft/);
  assert.match(draftProgress(job), /Synthetic reader &lt;script&gt;/);
  const before=JSON.stringify(S.doc);
  browser.element('app').querySelectorAll=(selector:string)=>selector==='[data-form]'?[{reportValidity:()=>assert.fail('progress tab must not submit another form')}]:[];
  browser.listeners.get('click')!({target:{closest:()=>({dataset:{act:'draft-progress-section',section:'checks'}})},preventDefault(){}});
  const html=draftProgress(job);
  assert.match(html,/Latest batch checks · passed/); assert.match(html,/Expected batch size/);
  assert.match(html,/do not verify real-world facts/);
  assert.match(draftProgress({...job,progress:{...job.progress,validation:undefined,lastBatchChecks:['Expected batch size']}}),/Latest batch checks · passed/);
  assert.equal(JSON.stringify(S.doc),before); assert.equal(browser.bodies.length,0);
  assert.match(draftProgress({...job,progress:{...job.progress,outputSource:'cli-stdout'}}),/CLI output arriving/);
});

test('remaining-time estimates require two measured batches and use persona-weighted durations', async () => {
  const browser=browserHarness(); await settle(); const {draftEstimate}=browser.client;
  const p={totalPersonas:1000,completedPersonas:50,batchDurationsMs:[60000],completedBatchSizes:[25]};
  assert.match(draftEstimate(p),/After two completed batches/);
  assert.match(draftEstimate({...p,batchDurationsMs:[60000,60000],completedBatchSizes:[25,25]}),/~30–46 min remaining/);
  assert.match(draftEstimate({...p,batchDurationsMs:[60000,12000],completedBatchSizes:[25,5]}),/~30–46 min remaining/);
  assert.equal(draftEstimate({...p,completedPersonas:1000}), '');
  assert.match(draftEstimate({...p,totalPersonas:75,batchDurationsMs:[1000,1000],completedBatchSizes:[25,25]}),/~1–2 sec remaining/);
  assert.match(draftEstimate({...p,batchStartedAt:new Date(Date.now()-120000).toISOString(),batchDurationsMs:[60000,60000],completedBatchSizes:[25,25]}),/Taking longer/);
  assert.equal(draftEstimate({...p,totalBatches:1}), '');
  assert.match(draftEstimate({...p,batchDurationsMs:[60000,NaN],completedBatchSizes:[25,25]}),/Estimating/);
});


test('progress polling preserves keyboard focus on its current action', async () => {
  const browser=browserHarness(); await settle();
  let focused=false;
  (browser.document as any).activeElement={closest:()=>true,dataset:{act:'draft-progress-section',section:'checks'}};
  browser.element('app').querySelector=(selector:string)=>selector==='[data-act=draft-progress-section][data-section="checks"]'?{focus(){focused=true}}:null;
  browser.client.render(); assert.equal(focused,true);
});

test('simple study setup preserves hidden contracts, stable option keys, and other questions', async () => {
  const browser = browserHarness(); await settle();
  const { S, stageForm, applyStudySetup, setupAction } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel';
  const p = S.doc.pipelines[0], s = p.stages[0];
  s.context = { policy: 'Keep this' }; s.repeats = 3; s.size = 1;
  s.when = { stage: 'prior', question: 'x', metric: 'mean', op: 'gt', value: 0.5 };
  s.questions.other = { type: 'noul', label: 'Independent check', instructions: 'Preserve these instructions.' };
  delete s.inputs;
  const before = structuredClone(s);
  let html = stageForm(p, s);
  assert.match(html, /data-form="study-setup"/);
  assert.doesNotMatch(html, /name="(?:questionId|questionInstructions|phasePool|stageContext|repeats)"|Apply phase/);
  const row = (key: string, value: string) => ({ dataset: { setupOption: key }, querySelector: (selector: string) => selector==='[name=setupOption]'?{value}:null });
  applyStudySetup({ dataset: { questionId: 'answer' }, values: { setupPrompt: 'Which game title fits?' }, querySelectorAll: () => [row('a', 'Project Dawn'), row('b', 'Afterlight')] });
  assert.deepEqual(JSON.parse(JSON.stringify(s.questions.answer.criteria)), { a: {label:'Project Dawn',description:''}, b: {label:'Afterlight',description:''} });
  assert.equal(s.questions.answer.instructions, before.questions.answer.instructions);
  for (const key of ['context', 'repeats', 'size', 'when']) assert.equal(JSON.stringify(s[key]), JSON.stringify(before[key]));
  assert.equal(JSON.stringify(s.questions.other), JSON.stringify(before.questions.other));
  assert.equal(s.inputs, undefined);
  setupAction('setup-type', { dataset: { type: 'noul' } });
  setupAction('setup-type', { dataset: { type: 'choice' } });
  assert.deepEqual(JSON.parse(JSON.stringify(s.questions.answer.criteria)), { a: {label:'Project Dawn',description:''}, b: {label:'Afterlight',description:''} });
  setupAction('setup-cohort', { dataset: { id: 'cohort' } });
  assert.equal(p.cohorts[s.cohort], 'cohort');
  S.sections.pipeline = 'advanced'; html = stageForm(p, s);
  assert.match(html, /name="questionInstructions"/);
  assert.doesNotMatch(html, /data-form="study-setup"/, 'only one editor can submit changes for a phase');
});

test('earlier context stays beside follow-up questions without an empty setup tab or changing bindings', async () => {
  const browser = browserHarness(); await settle();
  const { S, stageForm, render, setupContextSummary } = browser.client;
  S.tab = 'studies'; S.pipelineId = 'study'; S.stageId = 'panel';
  const p = S.doc.pipelines[0], first = p.stages[0];
  render();
  assert.doesNotMatch(browser.element('app').innerHTML, /Use earlier answers|No earlier answers|setup-context/);
  const next = { ...structuredClone(first), id: 'review', label: 'Review', dependsOn: ['panel'], inputs: { custom: { stage: 'panel', question: 'answer', select: 'winner' } } };
  p.stages.push(next);
  first.questions.answer.label = 'Which <title> fits?';
  const before = JSON.stringify(next);
  assert.match(stageForm(p, next), /This cohort also sees results from: “1\. Which &lt;title&gt; fits\?”/);
  assert.equal(JSON.stringify(next), before);
  delete (next as any).inputs;
  assert.match(setupContextSummary(p, next), /1\. Which &lt;title&gt; fits\?/);
  assert.equal((next as any).inputs, undefined, 'legacy summary bindings remain implicit');
  (next as any).inputs = {};
  assert.equal(setupContextSummary(p, next), '', 'ordering alone does not imply receiving results');
  S.sections.pipeline = 'advanced'; S.sections['phase-review'] = 'inputs';
  assert.match(stageForm(p, next), /Connect output/);
});

test('review saves pending setup before planning and stops on save failure or empty answer options', async () => {
  const browser = browserHarness(); await settle();
  const { S, reviewPlan } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel'; S.dirty = true;
  browser.respond('/api/workspace', { document: S.doc, revision: 2 }, 'POST');
  browser.respond('/api/plan', { provider: 'typesafe', pipelineId: 'study', revision: 2, maxRequests: 1, stages: [], warnings: [] }, 'POST');
  await reviewPlan();
  assert.deepEqual(browser.bodies.slice(-2).map(x => x.path), ['/api/workspace', '/api/plan']);
  assert.equal(S.revision, 2);
  S.dirty = true;
  browser.fail('/api/workspace', 'Save conflict', 'POST');
  const plans = browser.bodies.filter(x => x.path === '/api/plan').length;
  await assert.rejects(reviewPlan(), /Save conflict/);
  assert.equal(S.dirty, true);
  assert.equal(browser.bodies.filter(x => x.path === '/api/plan').length, plans);
  S.doc.pipelines[0].stages[0].questions.answer.criteria.a = '';
  await assert.rejects(reviewPlan(), /text for every answer option/);
  assert.equal(S.sections.pipeline, 'phase');
});

test('browser submit flushes simple fields before navigation without touching other questions', async () => {
  const browser = browserHarness(); await settle();
  const { S } = browser.client; S.pipelineId = 'study'; S.stageId = 'panel'; S.dirty = true;
  const form = { dataset: { form: 'study-setup', questionId: 'answer' }, values: { setupPrompt: 'Updated from form dispatch' }, querySelectorAll: () => [] };
  browser.listeners.get('submit')!({ target: { closest: () => form }, preventDefault() {} });
  assert.equal(S.doc.pipelines[0].stages[0].questions.answer.label, 'Updated from form dispatch');
});

test('point-and-click result selections reconcile data dependencies and compare choices without key-order sensitivity', async () => {
  const browser = browserHarness(); await settle();
  const { S, setupAction, stageForm } = browser.client;
  S.pipelineId = 'study';
  const p = S.doc.pipelines[0], first = p.stages[0];
  const second = { ...structuredClone(first), id: 'second', label: 'Second cohort' };
  second.questions.answer.criteria = { b: 'B', a: 'A' };
  const combine = { id: 'combine', label: 'Combined', kind: 'aggregate', outputQuestion: 'combined', inputs: [{ stage: first.id, question: 'answer', weight: 2 }], dependsOn: ['panel', 'ordering'] };
  p.stages.push(second, combine); S.stageId = 'combine';
  assert.match(browser.client.studyQuestionList(p), /Second cohort/);assert.doesNotMatch(stageForm(p,combine),/phasePicker/);
  setupAction('setup-result', { dataset: { source: 'second', question: 'answer' } });
  assert.equal(combine.inputs.length, 2); assert.equal(combine.inputs[0].weight, 2);
  setupAction('setup-result', { dataset: { source: 'panel', question: 'answer' } });
  assert.deepEqual(Array.from(combine.dependsOn), ['ordering', 'second']);
  const decision = { id: 'decision', label: 'Decision', kind: 'decision', from: { stage: 'panel', question: 'answer' }, outputQuestion: 'result', dependsOn: ['panel', 'ordering'] };
  p.stages.push(decision); S.stageId = 'decision';
  setupAction('setup-result', { dataset: { source: 'second', question: 'answer' } });
  assert.deepEqual(Array.from(decision.dependsOn), ['ordering', 'second']);
  decision.when = { stage: 'panel', question: 'answer', metric: 'winner', op: 'eq', value: 'a' };
  setupAction('setup-result', { dataset: { source: 'panel', question: 'answer' } });
  setupAction('setup-result', { dataset: { source: 'second', question: 'answer' } });
  assert.ok(decision.dependsOn.includes('panel'), 'branch conditions keep their required source');
});

test('new choice options never reuse deleted keys referenced by branch conditions', async () => {
  const browser = browserHarness(); await settle();
  const { S, setupAction } = browser.client; S.pipelineId = 'study'; S.stageId = 'panel';
  const p = S.doc.pipelines[0], s = p.stages[0];
  s.questions.answer.criteria = { option_1: 'Old title', option_2: 'Keep', option_3: 'Keep too' };
  p.stages.push({ id: 'branch', kind: 'decision', label: 'Conditional', from: { stage: 'panel', question: 'answer' }, outputQuestion: 'winner', dependsOn: ['panel'], when: { stage: 'panel', question: 'answer', metric: 'winner', op: 'eq', value: 'option_1' } });
  setupAction('setup-remove-option', { dataset: { key: 'option_1' } });
  setupAction('setup-add-option', { dataset: {} });
  assert.equal(Object.keys(s.questions.answer.criteria).length, 3);
  assert.equal(Object.hasOwn(s.questions.answer.criteria, 'option_1'), false);
  assert.equal(p.stages[1].when.value, 'option_1', 'review will flag a missing option instead of reinterpreting the rule');
});


test('bulk choice lists preview without mutation, retain matching IDs, and reject duplicates or limits atomically', async () => {
  const browser = browserHarness(); await settle();
  const { S, openAnswerList, applyAnswerList, updateAnswerList } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel';
  const q = S.doc.pipelines[0].stages[0].questions.answer;
  const original = JSON.stringify(q);
  openAnswerList();
  browser.element('answerListText').value = 'B, "New, improved", A';
  updateAnswerList();
  assert.equal(JSON.stringify(q), original);
  assert.match(browser.element('answerListPreview').innerHTML, /3 options/);
  applyAnswerList(false);
  assert.deepEqual(Object.values(q.criteria), ['B', 'New, improved', 'A']);
  assert.equal(q.criteria.a, 'A'); assert.equal(q.criteria.b, 'B');
  assert.equal(q.instructions, 'Choose an option.');
  assert.equal(S.dirty, true); assert.equal(S.plan, null);
  assert.equal(browser.bodies.length, 0, 'bulk editing neither saves nor starts inference');
  const changed = JSON.stringify(q);
  openAnswerList(); browser.element('answerListText').value = 'Same, Same';
  assert.throws(() => applyAnswerList(false), /different text/);
  assert.equal(JSON.stringify(q), changed);
  browser.element('answerListText').value = Array.from({ length: 256 }, (_, i) => 'Option ' + i).join(',');
  assert.throws(() => applyAnswerList(false), /2–255/);
  assert.equal(JSON.stringify(q), changed);
  browser.element('answerListText').value = 'One additional option'; applyAnswerList(true);
  assert.deepEqual(Object.values(q.criteria), ['B', 'New, improved', 'A', 'One additional option']);
});

test('CSV import selects one column, supports headers and preserves rating order', async () => {
  const browser = browserHarness(); await settle();
  const { S, setupAction, openAnswerList, readAnswerListFile, answerListValues, applyAnswerList } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel'; setupAction('setup-type', { dataset: { type: 'score' } });
  const q = S.doc.pipelines[0].stages[0].questions.answer;
  openAnswerList(); const original = JSON.stringify(q);
  await readAnswerListFile({ name: 'levels.csv', size: 80, text: async () => '\uFEFFlevel,code\r\nLow,L\r\n"Medium, steady",M\r\nHigh,H' });
  browser.element('answerListColumn').value = '0'; browser.element('answerListHeader').checked = true;
  await browser.listeners.get('change')!({ target: { id: 'answerListHeader' } });
  assert.equal(JSON.stringify(q), original);
  assert.deepEqual(Array.from(answerListValues()), ['Low', 'Medium, steady', 'High']);
  applyAnswerList(false);
  assert.deepEqual(Array.from(q.criteria), ['Low', 'Medium, steady', 'High']);
  openAnswerList(); browser.element('answerListText').value = Array.from({ length: 11 }, (_, i) => 'Level ' + i).join(',');
  assert.throws(() => applyAnswerList(false), /2–10/);
  assert.deepEqual(Array.from(q.criteria), ['Low', 'Medium, steady', 'High']);
});

test('file imports reject oversize or malformed data and cannot apply to a changed or dismissed question', async () => {
  const browser = browserHarness(); await settle();
  const { S, openAnswerList, closeAnswerList, readAnswerListFile, applyAnswerList } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel';
  openAnswerList();
  await readAnswerListFile({ name: 'big.csv', size: 262145, text: async () => { throw Error('Must not read oversized file'); } });
  assert.match(browser.element('answerListError').textContent, /too large/);
  await readAnswerListFile({ name: 'bad.csv', size: 5, text: async () => '"bad' });
  assert.match(browser.element('answerListError').textContent, /unterminated/);
  let finish!: (text: string) => void;
  const pending = readAnswerListFile({ name: 'slow.csv', size: 9, text: () => new Promise<string>(resolve => { finish = resolve; }) });
  closeAnswerList(); openAnswerList(); browser.element('answerListText').value = 'Fresh, List';
  finish('Old, File'); await pending;
  assert.equal(browser.element('answerListText').value, 'Fresh, List');
  const earlier = readAnswerListFile({ name: 'earlier.csv', size: 9, text: () => new Promise<string>(resolve => { finish = resolve; }) });
  await readAnswerListFile({ name: 'latest.csv', size: 9, text: async () => 'Latest, File' });
  finish('Earlier, File'); await earlier;
  assert.equal(browser.element('answerListText').value, 'Latest, File', 'last selected file wins');
  const typing = readAnswerListFile({ name: 'pending.csv', size: 9, text: () => new Promise<string>(resolve => { finish = resolve; }) });
  browser.element('answerListText').value = 'Typed, List';
  browser.listeners.get('input')!({ target: { id: 'answerListText' } });
  finish('Ignore, File'); await typing;
  assert.equal(browser.element('answerListText').value, 'Typed, List', 'typing supersedes a pending file');
  const q = S.doc.pipelines[0].stages[0].questions.answer; q.criteria.a = 'Changed elsewhere';
  assert.throws(() => applyAnswerList(false), /question changed/);
  assert.equal(q.criteria.a, 'Changed elsewhere');
});


test('step navigation uses numbered questions consistently without rewriting saved labels or bindings', async () => {
  const browser = browserHarness(); await settle();
  const { S, stageForm, stageMap, stepTitle, inputTitle, advancedStageForm } = browser.client;
  S.pipelineId = 'study'; S.stageId = 'panel';
  const p = S.doc.pipelines[0], first = p.stages[0];
  const next = { ...structuredClone(first), id: 'follow', label: 'Next question', questions: { answer: { ...first.questions.answer, label: 'What should this phase decide?' } }, dependsOn: ['panel'] };
  next.inputs = { previous_result: { stage: first.id, question: 'answer', select: 'summary' } };
  p.stages.push(next);
  const before = JSON.stringify(p);
  assert.doesNotMatch(stageForm(p,first),/name="phasePicker"/);
  for (const html of [browser.client.studyQuestionList(p), advancedStageForm(p, first), stageMap(p)]) {
    assert.match(html, /Which option fits\?/);
    assert.match(html, /Untitled question|Follow-up 1/);
    assert.doesNotMatch(html, />First question<|>Next question</);
  }
  assert.doesNotMatch(stageMap(p), /From First question/);
  assert.match(stageMap(p), /From 1\. Which option fits\?/);
  assert.equal(JSON.stringify(p), before, 'display labels preserve stored identity and execution contracts');
  next.questions.answer.label = 'Which launch date fits?';
  assert.equal(stepTitle(p, next), '2. Which launch date fits?');
  next.questions.answer.label = '   ';
  assert.equal(stepTitle(p, next), '2. Untitled question');
  first.questions.second = { ...first.questions.answer, label: 'Would people buy it?' };
  assert.equal(stepTitle(p, first), '1. Which option fits? + 1 more');
  assert.equal(inputTitle(p, { stage: first.id, question: 'second' }), '1. Would people buy it?');
  p.stages.push({ id: 'result', kind: 'decision', label: 'Launch recommendation' });
  assert.equal(stepTitle(p, p.stages[2]), '3. Launch recommendation');
});

test('typing a question keeps the current form and pending document intact',async()=>{
  const browser=browserHarness();await settle();const {S}=browser.client;S.pipelineId='study';S.stageId='panel';
  const form={dataset:{form:'study-setup',questionId:'answer'},querySelector:()=>({value:'Which name works?'})};
  const before=JSON.stringify(S.doc),html=browser.element('app').innerHTML;
  await browser.listeners.get('input')!({target:{name:'setupPrompt',closest:()=>form}});
  assert.equal(JSON.stringify(S.doc),before);assert.equal(browser.element('app').innerHTML,html);assert.equal(S.dirty,true);
});


test('option comparisons preserve descriptions, stable keys and paginated answers across format and advanced edits', async () => {
  const browser=browserHarness();await settle();
  const {S,stageForm,applyStudySetup,setupAction,questionParts,upsertQuestion,openAnswerList,applyAnswerList,validateSetupAnswers}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],s=p.stages[0],q=s.questions.answer;
  q.criteria={a:{label:'Afterlight',description:'A hopeful title about exploration.'},b:{label:'Project Dawn',description:'A bold title about a new beginning.'},c:'None of these',d:'Other',e:{label:'Hidden option',description:'Preserve this off-page description.'}};
  const html=stageForm(p,s);
  assert.match(html,/aria-label="Add options"/);assert.match(html,/Probability distribution/);assert.doesNotMatch(html,/name="setupOption"|name="setupDescription"|>Rating</);
  assert.match(html,/A hopeful title/);assert.doesNotMatch(html,/Hidden option/);
  const beforeEditing=JSON.stringify(q);setupAction('setup-edit-option',{dataset:{key:'a'}});
  const editor=stageForm(p,s);assert.match(editor,/Option 1 name/);assert.match(editor,/Option 1 description/);assert.doesNotMatch(editor,/Option 2 name/);
  assert.equal(JSON.stringify(q),beforeEditing,'opening an option does not mutate criteria');
  setupAction('setup-option-back',{dataset:{}});setupAction('setup-format',{dataset:{}});
  assert.match(stageForm(p,s),/Compare options/);assert.match(stageForm(p,s),/Ordered scale/);
  setupAction('setup-format-back',{dataset:{}});
  assert.match(html,/Probabilities 0–1, totaling 1/);
  const row={dataset:{setupOption:'a'},querySelector:(selector:string)=>({value:selector==='[name=setupOption]'?'Afterglow':'Warm and reflective.'})};
  applyStudySetup({dataset:{questionId:'answer'},values:{setupPrompt:q.label},querySelectorAll:()=>[row]});
  assert.equal(q.criteria.a.label,'Afterglow');assert.equal(q.criteria.a.description,'Warm and reflective.');assert.equal(q.criteria.e.description,'Preserve this off-page description.');
  setupAction('setup-type',{dataset:{type:'score'}});setupAction('setup-type',{dataset:{type:'choice'}});
  assert.equal(s.questions.answer.criteria.a.description,'Warm and reflective.');
  openAnswerList();browser.element('answerListText').value='Project Dawn, Afterglow, New title';applyAnswerList(false);
  const edited=s.questions.answer;assert.equal(edited.criteria.a.description,'Warm and reflective.');assert.equal(edited.criteria.b.description,'A bold title about a new beginning.');
  assert.equal(Object.keys(edited.criteria).length,3);assert.doesNotThrow(()=>validateSetupAnswers(p));
  const advanced=questionParts('answer',edited)[1].html;assert.doesNotMatch(advanced,/\[object Object\]/);assert.match(advanced,/Option definitions \(JSON\)/);
  const values={questionId:'answer',questionType:'choice',questionLabel:edited.label,questionInstructions:edited.instructions,criteria:JSON.stringify(edited.criteria)};
  const restored={questions:{}};upsertQuestion(restored,{querySelector:(selector:string)=>({value:values[selector.match(/name="([^"\]]+)"/)![1] as keyof typeof values]})});
  assert.equal(JSON.stringify(restored.questions),JSON.stringify({answer:edited}));
  edited.criteria.a.label=' ';assert.throws(()=>validateSetupAnswers(p),/text for every answer/);
});


test('answer setup distinguishes hosted probabilities from local classifier evidence for every format',async()=>{
  const browser=browserHarness();await settle();const {S,stageForm,setupAction}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],s=p.stages[0];S.evaluationProvider='typesafe';
  assert.match(stageForm(p,s),/Probabilities 0–1, totaling 1/);
  S.evaluationProvider='gliner';assert.match(stageForm(p,s),/Relative scores/);assert.match(stageForm(p,s),/not calibrated probabilities/);
  setupAction('setup-type',{dataset:{type:'score'}});assert.match(stageForm(p,s),/relative level scores/);assert.doesNotMatch(stageForm(p,s),/plus probabilities across/);
  setupAction('setup-type',{dataset:{type:'noul'}});assert.match(stageForm(p,s),/relative yes score/);
});


test('project entry and back navigation keep every breadcrumb level and preserve study drafts',async()=>{
  const browser=browserHarness(false);await settle();const {S,act}=browser.client;
  const html=()=>browser.element('app').innerHTML;
  act(null,{dataset:{act:'open-project',id:'existing-research'}});
  assert.equal(S.pipelineId,null);assert.match(html(),/Your studies/);
  assert.match(html(),/<span>Projects<\/span>.*<span>Existing research<\/span>.*<span aria-current="page">Studies<\/span>/);
  act(null,{dataset:{act:'open-pipeline',id:'study'}});
  assert.match(html(),/<span>Projects<\/span>.*<span>Existing research<\/span>.*<span>Studies<\/span>/);
  assert.match(html(),/<h1[^>]*aria-current="page"/);
  S.doc.pipelines[0].description='Unfinished study question';S.dirty=true;
  S.sections['setup-wizard-study-panel-answer']='options';const before=JSON.stringify(S.doc);
  act(null,{dataset:{act:'back-studies'}});assert.equal(S.projectId,'existing-research');assert.equal(S.pipelineId,null);
  assert.match(html(),/Your studies/);
  act(null,{dataset:{act:'open-pipeline',id:'study'}});
  act(null,{dataset:{act:'projects'}});assert.equal(S.projectId,null);
  act(null,{dataset:{act:'open-project',id:'existing-research'}});
  assert.equal(S.pipelineId,null);assert.equal(S.tab,'studies');assert.match(html(),/Your studies/);
  assert.equal(JSON.stringify(S.doc),before);assert.equal(S.dirty,true);assert.equal(S.sections['setup-wizard-study-panel-answer'],'options');
});

test('study navigation has clear scope, a reachable single-study library and contextual step settings', async()=>{
  const browser=browserHarness();await settle();const {S,act,render,say}=browser.client;
  S.tab='studies';S.pipelineId='study';S.stageId='panel';S.dirty=true;
  S.doc.pipelines[0].stages[0].questions.answer.criteria.a={label:'Draft name',description:'Keep typed detail'};
  const before=JSON.stringify(S.doc);render();let html=browser.element('app').innerHTML;
  assert.doesNotMatch(html,/role="tablist"|>Advanced<|Apply phase/);assert.match(html,/data-act="back-studies" aria-label="Back to studies"/);const location=html.match(/<nav class="study-location"[\s\S]*?<\/nav>/)![0];assert.equal((location.match(/<button/g)||[]).length,1);assert.doesNotMatch(location,/data-act="projects"/);assert.doesNotMatch(html,/← Studies|← Projects/);assert.match(html,/>Questions</);assert.match(html,/aria-label="Step settings" title="Step settings"/);
  act(null,{dataset:{act:'section-view',sectionKey:'pipeline',sectionId:'advanced'}});html=browser.element('app').innerHTML;
  assert.match(html,/Back to question/);assert.match(html,/Step settings · 1\./);assert.doesNotMatch(html,/aria-label="Study sections"|Apply phase/);
  for(const field of ['questionInstructions','criteria','stageContext','repeats'])assert.match(html,new RegExp('name="'+field+'"'));
  act(null,{dataset:{act:'section-view',sectionKey:'pipeline',sectionId:'phase'}});
  assert.match(browser.element('app').innerHTML,/Keep typed detail/);
  act(null,{dataset:{act:'back-studies'}});assert.equal(S.pipelineId,null);render();html=browser.element('app').innerHTML;
  assert.match(html,/Your studies|Your research questions/);assert.match(html,/role="tablist"/);assert.match(html,/New study/);assert.doesNotMatch(html,/data-form="new-pipeline"/);
  assert.match(html,/<button type="button" class="listrow study-list-row" data-act="open-pipeline" data-id="study" aria-label="Open study: /);assert.doesNotMatch(html,/>Open study<|<div class="listrow">/);
  act(null,{dataset:{act:'new-study'}});assert.match(browser.element('app').innerHTML,/data-form="new-pipeline"/);
  act(null,{dataset:{act:'cancel-study'}});assert.doesNotMatch(browser.element('app').innerHTML,/data-form="new-pipeline"/);
  act(null,{dataset:{act:'open-pipeline',id:'study'}});assert.equal(JSON.stringify(S.doc),before);
  S.flushing=true;browser.element('toast').textContent='';say('Stage applied to draft.');assert.equal(browser.element('toast').textContent,'');
  S.flushing=false;say('Draft saved.');assert.equal(browser.element('toast').textContent,'Draft saved.');
});


test('step settings preserve cohort assignment and structured option contracts when basic fields are absent',async()=>{
  const browser=browserHarness();await settle();const {S,applyStage}=browser.client;S.pipelineId='study';S.stageId='panel';
  const p=S.doc.pipelines[0],s=p.stages[0];const criteria={a:{label:'Named option',description:'Keep full meaning'},b:'Other'};
  s.questions.answer.criteria=criteria;s.context={note:'Existing fact'};
  const values={label:s.label,size:'',repeats:'3',join:'all',stageContext:JSON.stringify(s.context),questionId:'answer',questionLabel:s.questions.answer.label,questionInstructions:'Updated instructions',questionType:'choice',criteria:JSON.stringify(criteria)};
  const card={querySelector:(selector:string)=>({value:values[selector.match(/name="(.+)"/)![1] as keyof typeof values]})};
  const before=JSON.stringify(p.cohorts);applyStage({values,querySelector:()=>null,querySelectorAll:(selector:string)=>selector==='.question-card'?[card]:[]});
  assert.equal(s.cohort,'audience');assert.equal(JSON.stringify(p.cohorts),before);assert.equal(JSON.stringify(s.questions.answer.criteria),JSON.stringify(criteria));
  assert.equal(s.questions.answer.instructions,'Updated instructions');assert.equal(s.repeats,3);assert.equal(s.context.note,'Existing fact');
});


test('empty option setup starts with CSV import and manual add opens only one option',async()=>{
  const browser=browserHarness();await settle();const {S,stageForm,setupAction}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],s=p.stages[0];s.questions.answer.criteria={a:'',b:''};
  const before=JSON.stringify(s);let html=stageForm(p,s);
  assert.match(html,/Drop CSV or JSON/);assert.match(html,/data-answer-drop="true" data-act="answer-list-import"/);
  assert.doesNotMatch(html,/name="setupOption"|name="setupDescription"/);assert.equal(JSON.stringify(s),before);
  setupAction('setup-add-option',{dataset:{}});html=stageForm(p,s);
  assert.equal((html.match(/name="setupOption"/g)||[]).length,1);assert.equal((html.match(/name="setupDescription"/g)||[]).length,1);
  assert.match(html,/Back to options/);assert.equal(S.dirty,true);
});

test('provider change redraws distribution semantics without requiring a reviewed plan', async () => {
  const browser = browserHarness(); await settle();
  const { S, render } = browser.client;
  S.tab='studies';S.pipelineId='study';S.stageId='panel';S.plan=null;render();
  assert.match(browser.element('app').innerHTML,/Probability distribution/);
  await browser.listeners.get('change')!({target:{name:'evaluationProvider',value:'gliner'}});
  assert.match(browser.element('app').innerHTML,/Normalized option scores/);
  assert.doesNotMatch(browser.element('app').innerHTML,/Jev returns a probability/);
});


test('option input tabs isolate sources and preserve drafts and reachable blank criteria', async () => {
  const browser=browserHarness();await settle();
  const {S,stageForm,setupAction,applyStudySetup}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],s=p.stages[0],q=s.questions.answer;
  q.criteria={a:'',b:''};S.dirty=false;const before=JSON.stringify(q);
  let html=stageForm(p,s);assert.match(html,/data-source="file" aria-pressed="true"/);
  assert.doesNotMatch(html,/data-act="option-agent-open"|data-act="setup-add-option"/);
  setupAction('setup-input',{dataset:{source:'agent'}});html=stageForm(p,s);
  assert.match(html,/id="optionAgentPrompt"/);assert.doesNotMatch(html,/<dialog[^>]*optionAgent/);assert.doesNotMatch(html,/data-answer-drop|data-act="setup-add-option"/);
  setupAction('setup-input',{dataset:{source:'manual'}});html=stageForm(p,s);
  assert.match(html,/Edit option Unnamed option 1/);assert.match(html,/Edit option Unnamed option 2/);
  assert.equal(JSON.stringify(q),before);assert.equal(S.dirty,false,'view changes alone do not edit study');
  setupAction('setup-edit-option',{dataset:{key:'a'}});
  const row={dataset:{setupOption:'a'},querySelector:(selector:string)=>({value:selector==='[name=setupOption]'?'Afterlight':'A hopeful title.'})};
  applyStudySetup({dataset:{questionId:'answer'},values:{setupPrompt:'Choose a title'},querySelectorAll:()=>[row]});
  setupAction('setup-option-back',{dataset:{}});setupAction('setup-input',{dataset:{source:'file'}});setupAction('setup-input',{dataset:{source:'manual'}});
  assert.equal(q.label,'Choose a title');assert.equal(q.criteria.a.description,'A hopeful title.');assert.equal(q.criteria.b,'');
  html=stageForm(p,s);assert.match(html,/Afterlight/);assert.match(html,/Unnamed option 2/);
  const other={...s,id:'other',questions:{answer:{...q,criteria:{a:'',b:''}}}};
  assert.match(stageForm(p,other),/data-source="file" aria-pressed="true"/,'source selection belongs to one step');
});


test('progressive setup has one active task, preserves edits and isolates each study question',async()=>{
  const browser=browserHarness();await settle();const {S,stageForm,setupAction,applyStudySetup}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],s=p.stages[0],q=s.questions.answer;
  const active=(html:string)=>[...html.matchAll(/data-setup-pane="([^"]+)" >/g)].map(match=>match[1]);
  q.label='';S.dirty=false;assert.deepEqual(active(stageForm(p,s)),['question']);
  setupAction('setup-wizard',{dataset:{step:'cohort',forward:'true'}});assert.match(stageForm(p,s),/Write the question before continuing/);assert.deepEqual(active(stageForm(p,s)),['question']);
  const instructions=q.instructions,inputs=JSON.stringify(s.inputs);
  applyStudySetup({dataset:{questionId:'answer'},values:{setupPrompt:'Which title fits?'},querySelectorAll:()=>[]});
  setupAction('setup-wizard',{dataset:{step:'cohort',forward:'true'}});
  assert.deepEqual(active(stageForm(p,s)),['cohort']);
  setupAction('setup-wizard',{dataset:{step:'question'}});assert.equal(q.label,'Which title fits?');
  setupAction('setup-wizard',{dataset:{step:'options'}});setupAction('setup-edit-option',{dataset:{key:'a'}});
  const row={dataset:{setupOption:'a'},querySelector:(selector:string)=>({value:selector==='[name=setupOption]'?'Afterlight':'A hopeful title.'})};
  applyStudySetup({dataset:{questionId:'answer'},values:{setupPrompt:q.label},querySelectorAll:()=>[row]});
  setupAction('setup-option-back',{dataset:{}});setupAction('setup-wizard',{dataset:{step:'review',forward:'true'}});
  assert.deepEqual(active(stageForm(p,s)),['review']);assert.equal(q.criteria.a.description,'A hopeful title.');
  assert.equal(q.instructions,instructions);assert.equal(JSON.stringify(s.inputs),inputs);
  const other={...s,id:'other'};assert.deepEqual(active(stageForm(p,other)),['question']);
  assert.deepEqual(active(stageForm({...p,id:'different-study'},s)),['question']);
  const focused=stageForm(p,s,true);assert.doesNotMatch(focused,/setup-progress|data-setup-pane/);assert.match(focused,/setupPrompt/);assert.match(focused,/setup-columns/);
});

test('review validation returns incomplete question to correct setup task',async()=>{
  const browser=browserHarness();await settle();const {S,stageForm,setupAction,validateSetupAnswers}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],s=p.stages[0],q=s.questions.answer;
  q.criteria={a:'',b:''};setupAction('setup-wizard',{dataset:{step:'options'}});
  setupAction('setup-wizard',{dataset:{step:'review',forward:'true'}});assert.match(stageForm(p,s),/Import a list or name every option before continuing/);assert.match(stageForm(p,s),/data-setup-pane="options" >/);
  setupAction('setup-wizard',{dataset:{step:'review'}});
  assert.throws(()=>validateSetupAnswers(p),/text for every answer/);
  const html=stageForm(p,s);assert.match(html,/data-setup-pane="options" >/);assert.match(html,/data-source="manual" aria-pressed="true"/);
  q.label='';assert.throws(()=>validateSetupAnswers(p),/Add the question/);assert.match(stageForm(p,s),/data-setup-pane="question" >/);
});


test('new and legacy placeholder follow-ups do not count as completed questions',async()=>{
  const browser=browserHarness();await settle();const {S,addNextPhase,stageForm,setupAction}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0];addNextPhase();const s=p.stages.at(-1);
  assert.equal(s.questions.answer.label,'');
  for(const label of ['', 'What should this phase decide?']){
    s.questions.answer.label=label;
    assert.match(stageForm(p,s),/aria-label="Question" aria-current="step" data-complete="false"/);
    setupAction('setup-wizard',{dataset:{step:'cohort',forward:'true'}});
    assert.match(stageForm(p,s),/Write the question before continuing/);
  }
});


test('question outline replaces dropdown, preserves pending fields and returns to each scoped task',async()=>{
  const browser=browserHarness();await settle();const {S,render,applyStudySetup,setupAction,studyQuestionList,stageForm}=browser.client;
  S.tab='studies';S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],first=p.stages[0];
  const follow={...structuredClone(first),id:'follow',questions:{answer:{...first.questions.answer,label:'What should this phase decide?'}},dependsOn:['panel'],inputs:{prior:{stage:'panel',question:'answer',select:'summary'}}};
  const another={...structuredClone(follow),id:'another'};p.stages.push(follow,another);S.dirty=true;
  S.sections['setup-wizard-study-panel-answer']='options';render();assert.doesNotMatch(browser.element('app').innerHTML,/name="phasePicker"|>Study question</);
  const form:any={dataset:{form:'study-setup',questionId:'answer'},values:{setupPrompt:'Which title fits our game?'},reportValidity:()=>true,querySelectorAll:()=>[],requestSubmit:()=>applyStudySetup(form)};
  browser.element('app').querySelectorAll=(selector:string)=>selector==='[data-form]'?[form]:[];
  browser.listeners.get('click')!({preventDefault(){},target:{closest:()=>({dataset:{act:'setup-question-list'}})}});
  assert.equal(first.questions.answer.label,'Which title fits our game?');let html=browser.element('app').innerHTML;
  assert.match(html,/Questions in this study/);assert.match(html,/Follow-up 1/);assert.match(html,/Follow-up 2/);assert.match(html,/Question needed/);assert.doesNotMatch(html,/data-form="study-setup"|Untitled question|What should this phase decide/);
  browser.element('app').querySelectorAll=()=>[];
  setupAction('setup-edit-step',{dataset:{id:'follow'}});html=stageForm(p,follow);
  assert.match(html,/Follow-up 1/);assert.match(html,/name="setupPrompt" rows="3"><\/textarea>/);assert.doesNotMatch(html,/aria-label="Cohort, complete"|aria-label="Options, complete"/);
  const before=JSON.stringify(follow);applyStudySetup({dataset:{questionId:'answer'},values:{setupPrompt:''},querySelectorAll:()=>[]});assert.equal(JSON.stringify(follow),before,'navigation does not rewrite legacy placeholder data');
  setupAction('setup-question-list',{dataset:{}});setupAction('setup-edit-step',{dataset:{id:'panel'}});
  assert.match(stageForm(p,first),/data-setup-pane="options" >/);assert.equal(first.questions.answer.label,'Which title fits our game?');
  assert.match(studyQuestionList(p),/Which title fits our game/);
  const single={...p,stages:[first]};assert.doesNotMatch(stageForm(single,first),/setup-question-list|phasePicker/,'single question needs no navigation choice');
});

test('outline reaches result steps and validation returns from outline to missing question',async()=>{
  const browser=browserHarness();await settle();const {S,setupAction,studyQuestionList,stageForm,validateSetupAnswers,render}=browser.client;
  S.tab='studies';S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],first=p.stages[0];
  const result={id:'combine',kind:'aggregate',label:'Combined result',inputs:[],dependsOn:[],outputQuestion:'combined'};p.stages.push(result);
  assert.match(stageForm(p,first),/Study outline/);assert.match(studyQuestionList(p),/Combined answer/);assert.match(studyQuestionList(p),/Choose earlier answers/);
  setupAction('setup-edit-step',{dataset:{id:'combine'}});assert.equal(S.stageId,'combine');assert.match(stageForm(p,result),/Which answers should be combined/);assert.doesNotMatch(stageForm(p,result),/phasePicker/);
  first.questions.answer.label='';setupAction('setup-question-list',{dataset:{}});assert.throws(()=>validateSetupAnswers(p),/Add the question/);render();
  assert.equal(S.sections['question-list-study'],false);assert.equal(S.stageId,'panel');assert.match(browser.element('app').innerHTML,/data-form="study-setup"/);
});


test('advanced settings selector retains stage switching without adding a dropdown to question setup',async()=>{
  const browser=browserHarness();await settle();const {S,stageForm,advancedStageForm}=browser.client;
  S.pipelineId='study';S.stageId='panel';const p=S.doc.pipelines[0],first=p.stages[0],next={...structuredClone(first),id:'second'};p.stages.push(next);
  S.sections.pipeline='advanced';assert.match(advancedStageForm(p,first),/name="phasePicker"/);
  await browser.listeners.get('change')!({target:{name:'phasePicker',value:'second'}});
  assert.equal(S.stageId,'second');assert.equal(S.sections.pipeline,'advanced');S.sections.pipeline='phase';
  assert.doesNotMatch(stageForm(p,next),/name="phasePicker"/);
});
