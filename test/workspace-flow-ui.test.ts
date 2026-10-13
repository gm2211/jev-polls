import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderWorkspace } from '../src/workspace-ui.js';
import { WORKSPACE_FLOW_CLIENT, WORKSPACE_FLOW_CSS, ROUND_PANEL_CSS } from '../src/workspace-flow-ui.js';

// Execute the served browser client so connection tests use the real graph and
// dependency helpers, including legacy bindings and nested branch conditions.
async function flowHarness() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', hidden: false, inert: false,
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: () => null, querySelectorAll: () => [], focus() {}, addEventListener() {},
    });
    return elements.get(id);
  };
  let narrow = false;
  const fakeNode = (): any => ({
    style: {}, children: [] as any[], offsetWidth: 120, offsetHeight: 40, className: '', id: '', textContent: '',
    setAttribute() {}, removeAttribute() {}, append() {}, remove() {}, replaceChildren(...items: any[]) { this.children = items; }, querySelector: () => null,
  });
  const snapshot = {
    revision: 1,
    document: { version: 1, cohorts: [], pipelines: [] },
    auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null,
  };
  const context: any = {
    location: { origin: 'http://127.0.0.1:4180' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: (query: string) => ({ matches: narrow && query.includes('700px'), addEventListener() {} }),
    document: { getElementById: element, createElement: fakeNode, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} },
    fetch: async (path: string) => ({ ok: true, json: async () => structuredClone(
      path === '/api/local-agents' ? { engines: [] } :
      path === '/api/chatgpt/status' ? { connected: false, planEnabled: false } : snapshot,
    ) }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    navigator: {}, URL, URLSearchParams, Blob, TextEncoder, FormData,
  };
  const html = renderWorkspace('flow-test', 'token');
  const script = html.match(/<script nonce="flow-test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.flowTest={S,flowAction,flowCreateMenu,flowKindMatches,flowConnect,flowDisconnect,flowInputs,flowNode,flowReadiness,flowConnections,flowCohortMap,flowTodo,flowRoundTabs,flowNode,flowInspector,flowCanvas,flowWorkspace,flowReads,flowRunOrder,flowListMode,flowTipShow,flowNodeInputs,flowWireEnd,setupAction,stageForm,resultSetup,flowNewStage,removeStep,stepReaders,requestStepDeletion,stepDeletionAction,undoStepDeletion};})();');
  new Script(exposed).runInNewContext(context);
  await new Promise<void>(resolve => setImmediate(resolve));
  const client = context.flowTest;
  const poll = (id: string, label = id): any => ({
    id, label, kind: 'poll', cohort: 'audience', dependsOn: [], inputs: {},
    questions: { answer: { type: 'choice', label, instructions: 'Compare options.', criteria: { a: 'A', b: 'B' } } },
  });
  const pipeline: any = { version: 1, id: 'study', name: 'Study', description: '', context: {}, cohorts: {}, stages: [poll('source'), poll('other'), poll('target')] };
  client.S.doc.pipelines = [pipeline];
  client.S.doc.projects = [{ id: 'project', name: 'Project', description: '', cohortIds: [], pipelineIds: ['study'] }];
  Object.assign(client.S, { projectId: 'project', pipelineId: 'study', stageId: 'target', tab: 'studies', dirty: false, plan: { revision: 1, stages: [], warnings: [], provider: 'typesafe', model: 'jev', maxRequests: 0 } });
  return { ...client, setNarrow: (value: boolean) => { narrow = value; }, pipeline, source: pipeline.stages[0], other: pipeline.stages[1], target: pipeline.stages[2], element };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test('connecting an answer preserves custom inputs and their projections without duplicate bindings', async () => {
  const { pipeline, target, flowConnect } = await flowHarness();
  target.inputs = { custom_context: { stage: 'other', question: 'answer', select: 'winner' } };
  target.dependsOn = ['other'];
  flowConnect(pipeline, 'source', 'answer', 'target');
  assert.deepEqual(plain(target.inputs.custom_context), { stage: 'other', question: 'answer', select: 'winner' });
  assert.equal(Object.values<any>(target.inputs).filter(input => input.stage === 'source' && input.question === 'answer').length, 1);
  assert.deepEqual(new Set(target.dependsOn), new Set(['other', 'source']));
  const firstConnection = JSON.stringify(target);
  flowConnect(pipeline, 'source', 'answer', 'target');
  assert.equal(JSON.stringify(target), firstConnection, 'repeating a connection must not create duplicate aliases or dependencies');
});

test('connecting into legacy poll context retains every implicit earlier summary', async () => {
  const { pipeline, target, flowConnect } = await flowHarness();
  delete target.inputs;
  target.dependsOn = ['other'];
  flowConnect(pipeline, 'source', 'answer', 'target');
  const inputs = Object.values<any>(target.inputs);
  assert.ok(inputs.some(input => input.stage === 'other' && input.question === 'answer' && input.select === 'summary'));
  assert.ok(inputs.some(input => input.stage === 'source' && input.question === 'answer' && input.select === 'summary'));
  assert.deepEqual(new Set(target.dependsOn), new Set(['other', 'source']));
});

test('connection refuses self edges and transitive cycles without mutating graph', async () => {
  const { pipeline, source, other, target, flowConnect } = await flowHarness();
  other.dependsOn = ['source'];
  target.dependsOn = ['other'];
  const before = JSON.stringify(pipeline);
  assert.throws(() => flowConnect(pipeline, 'target', 'answer', 'source'));
  assert.equal(JSON.stringify(pipeline), before);
  assert.throws(() => flowConnect(pipeline, 'source', 'answer', source.id));
  assert.equal(JSON.stringify(pipeline), before);
});

test('disconnect removes only selected binding and keeps dependencies needed by other inputs or nested conditions', async () => {
  const { pipeline, target, flowDisconnect } = await flowHarness();
  target.inputs = {
    first: { stage: 'source', question: 'answer', select: 'summary' },
    retained_projection: { stage: 'source', question: 'answer', select: 'winner' },
    other: { stage: 'other', question: 'answer', select: 'probabilities' },
  };
  target.dependsOn = ['source', 'other'];
  target.when = { all: [{ not: { any: [{ stage: 'source', question: 'answer', metric: 'winner', op: 'eq', value: 'a' }] } }] };
  flowDisconnect(pipeline, target, 'first');
  assert.equal(target.inputs.first, undefined);
  assert.deepEqual(plain(target.inputs.retained_projection), { stage: 'source', question: 'answer', select: 'winner' });
  flowDisconnect(pipeline, target, 'retained_projection');
  assert.ok(target.dependsOn.includes('source'), 'nested branch condition still needs its source');
  assert.deepEqual(plain(target.inputs.other), { stage: 'other', question: 'answer', select: 'probabilities' });
  flowDisconnect(pipeline, target, 'other');
  assert.equal(target.dependsOn.includes('other'), false);
  assert.deepEqual(plain(target.when), { all: [{ not: { any: [{ stage: 'source', question: 'answer', metric: 'winner', op: 'eq', value: 'a' }] } }] });
});

test('disconnecting legacy context materializes remaining summaries instead of dropping all earlier results', async () => {
  const { pipeline, target, flowDisconnect, flowInputs } = await flowHarness();
  delete target.inputs;
  target.dependsOn = ['source', 'other'];
  const key = flowInputs(pipeline, target).find(([, input]: any) => input.stage === 'source')[0];
  flowDisconnect(pipeline, target, key);
  assert.ok(Object.values<any>(target.inputs).some(input => input.stage === 'other' && input.question === 'answer' && input.select === 'summary'));
  assert.equal(Object.values<any>(target.inputs).some(input => input.stage === 'source'), false);
  assert.deepEqual(plain(target.dependsOn), ['other']);
});

test('point-click output then destination edits graph only after destination selection and invalidates review', async () => {
  const { S, pipeline, target, flowAction } = await flowHarness();
  const before = JSON.stringify(pipeline);
  flowAction('flow-output', { dataset: { id: 'source', question: 'answer' } });
  assert.equal(JSON.stringify(pipeline), before, 'choosing source is navigation, not a mutation');
  assert.equal(S.dirty, false);
  assert.ok(S.plan);
  flowAction('flow-select', { dataset: { id: 'target' } });
  assert.equal(S.flowSource, null);
  assert.equal(S.stageId, 'target');
  assert.equal(S.sections['flow-inspector'], 'connections');
  assert.equal(S.dirty, true);
  assert.equal(S.plan, null);
  assert.ok(Object.values<any>(target.inputs).some(input => input.stage === 'source' && input.question === 'answer'));
});

test('point-click rejected cycle retains pending source and does not invalidate review', async () => {
  const { S, pipeline, target, flowAction } = await flowHarness();
  target.dependsOn = ['source'];
  const before = JSON.stringify(pipeline);
  flowAction('flow-output', { dataset: { id: 'target', question: 'answer' } });
  assert.throws(() => flowAction('flow-select', { dataset: { id: 'source' } }), /loop/);
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(S.flowSource.stage, 'target');
  assert.equal(S.dirty, false);
  assert.ok(S.plan);
});

test('combining results preserves weights and refuses incompatible answer contracts atomically', async () => {
  const { pipeline, other, flowConnect } = await flowHarness();
  const combine: any = { id: 'combined', label: 'Combine answers', kind: 'aggregate', inputs: [{ stage: 'source', question: 'answer', weight: 3 }], outputQuestion: 'combined', dependsOn: ['source'] };
  pipeline.stages.push(combine);
  flowConnect(pipeline, 'other', 'answer', 'combined');
  assert.equal(combine.inputs[0].weight, 3);
  assert.deepEqual(plain(combine.inputs[1]), { stage: 'other', question: 'answer', weight: 1 });
  const before = JSON.stringify(combine);
  flowConnect(pipeline, 'source', 'answer', 'combined');
  assert.equal(JSON.stringify(combine), before);
  other.questions.answer.criteria = { different: 'Different', another: 'Another' };
  assert.throws(() => flowConnect(pipeline, 'other', 'answer', 'combined'), /matching/);
  assert.equal(JSON.stringify(combine), before);
});

test('replacing final result keeps unrelated ordering and conditional dependencies', async () => {
  const { pipeline, target, flowConnect, flowDisconnect } = await flowHarness();
  const result: any = {
    id: 'final', label: 'Final result', kind: 'decision',
    from: { stage: 'source', question: 'answer' }, outputQuestion: 'decision',
    dependsOn: ['source', 'target'],
    when: { stage: 'source', question: 'answer', metric: 'winner', op: 'eq', value: 'a' },
  };
  pipeline.stages.push(result);
  flowConnect(pipeline, 'other', 'answer', result.id);
  assert.deepEqual(plain(result.from), { stage: 'other', question: 'answer' });
  assert.deepEqual(new Set(result.dependsOn), new Set(['source', 'target', 'other']));
  flowDisconnect(pipeline, result, 'result');
  assert.deepEqual(plain(result.dependsOn), ['source', target.id]);
  assert.deepEqual(plain(result.when), { stage: 'source', question: 'answer', metric: 'winner', op: 'eq', value: 'a' });
});

test('attached add actions create connected follow-up, combine, and final result with correct stage contracts', async () => {
  for (const kind of ['poll', 'aggregate', 'decision']) {
    const { S, pipeline, source, flowAction } = await flowHarness();
    flowAction('flow-add', { dataset: { id: 'source', kind } });
    const added = pipeline.stages.at(-1);
    assert.equal(added.kind, kind);
    assert.deepEqual(plain(added.dependsOn), ['source']);
    if (kind === 'poll') {
      assert.equal(added.cohort, source.cohort);
      assert.equal(S.sections['flow-inspector'], 'question', 'a new step opens the guided sequence at What to ask');
      assert.equal(S.flowCohortPick, false);
      assert.ok(Object.values<any>(added.inputs).some(input => input.stage === 'source' && input.question === 'answer'));
    } else if (kind === 'aggregate') {
      assert.deepEqual(plain(added.inputs), [{ stage: 'source', question: 'answer', weight: 1 }]);
    } else {
      assert.deepEqual(plain(added.from), { stage: 'source', question: 'answer' });
    }
    assert.equal(S.stageId, added.id);
    assert.equal(S.dirty, true);
    assert.equal(S.plan, null);
  }
});

test('read-only node selection resets inspector to question without changing assignments, inputs or reviewed plan', async () => {
  const { S, pipeline, flowAction } = await flowHarness();
  S.sections['flow-inspector'] = 'answer';
  const before = JSON.stringify(pipeline);
  const plan = S.plan;
  flowAction('flow-select', { dataset: { id: 'source' } });
  assert.equal(S.stageId, 'source');
  assert.equal(S.sections['flow-inspector'], 'question');
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(S.dirty, false);
  assert.equal(S.plan, plan);
});

test('pending connection from another study cannot mutate current study on node selection', async () => {
  const { S, pipeline, flowAction, flowNode, target } = await flowHarness();
  S.flowSource = { pipelineId: 'other-study', stage: 'source', question: 'answer' };
  const before = JSON.stringify(pipeline);
  assert.doesNotMatch(flowNode(pipeline, target), /aria-label="Connect to /);
  flowAction('flow-select', { dataset: { id: 'target' } });
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(S.dirty, false);
  assert.ok(S.plan);
});

test('missing source output is refused before any destination mutation', async () => {
  const { pipeline, flowConnect } = await flowHarness();
  const before = JSON.stringify(pipeline);
  assert.throws(() => flowConnect(pipeline, 'source', 'removed_question', 'target'), /available output/);
  assert.equal(JSON.stringify(pipeline), before);
});

test('incomplete questions and missing inputs show actionable readiness state', async () => {
  const { pipeline, source, target, flowReadiness } = await flowHarness();
  source.questions.answer.label = '';
  assert.equal(flowReadiness(pipeline, source), 'Needs question');
  source.questions.answer.label = 'What should this phase decide?';
  assert.equal(flowReadiness(pipeline, source), 'Needs question');
  assert.equal(flowReadiness(pipeline, target), 'Needs an audience');
  const result = { id: 'result', kind: 'decision', label: 'Result', from: { stage: '', question: '' }, outputQuestion: 'result', dependsOn: [] };
  assert.equal(flowReadiness(pipeline, result), 'Needs input');
});

test('readiness requires a populated cohort and at least two named options or scale levels', async () => {
  const { S, pipeline, source, flowReadiness } = await flowHarness();
  pipeline.cohorts.audience = 'people';
  const cohort = { id: 'people', personas: [] as any[] };
  S.doc.cohorts.push(cohort);
  const before = JSON.stringify(pipeline);
  assert.equal(flowReadiness(pipeline, source), 'Needs an audience');
  assert.equal(JSON.stringify(pipeline), before, 'status inspection must not repair or mutate incomplete drafts');
  cohort.personas.push({ id: 'person' });
  assert.equal(flowReadiness(pipeline, source), 'Ready');
  source.questions.answer.criteria = { a: 'A' };
  assert.equal(flowReadiness(pipeline, source), 'Needs options');
  source.questions.answer.criteria = { a: 'A', b: ' ' };
  assert.equal(flowReadiness(pipeline, source), 'Needs options');
  source.questions.answer = { type: 'score', label: 'How strongly does this fit?', instructions: 'Rate fit.', criteria: ['Low'] };
  assert.equal(flowReadiness(pipeline, source), 'Needs options');
  source.questions.answer.criteria.push('High');
  assert.equal(flowReadiness(pipeline, source), 'Ready');
});

test('existing incompatible combine and final-result contracts remain visibly unready after question edits', async () => {
  const { pipeline, source, other, flowReadiness } = await flowHarness();
  const combine = { id: 'combine', label: 'Combined', kind: 'aggregate',
    inputs: [{ stage: 'source', question: 'answer', weight: 1 }, { stage: 'other', question: 'answer', weight: 1 }],
    outputQuestion: 'combined', dependsOn: ['source', 'other'] };
  const result = { id: 'result', label: 'Result', kind: 'decision', from: { stage: 'source', question: 'answer' }, outputQuestion: 'result', dependsOn: ['source'] };
  pipeline.stages.push(combine, result);
  other.questions.answer.criteria = { b: 'B', a: 'A' };
  assert.equal(flowReadiness(pipeline, combine), 'Ready', 'object key order does not change compatible option contracts');
  other.questions.answer.criteria.a = 'Different interpretation';
  const before = JSON.stringify(pipeline);
  assert.equal(flowReadiness(pipeline, combine), 'Options differ');
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(flowReadiness(pipeline, result), 'Ready');
  source.questions.answer = { type: 'noul', label: 'Should we do this?', instructions: 'Answer yes or no.' };
  assert.equal(flowReadiness(pipeline, result), 'Needs option scores');
  delete source.questions.answer;
  assert.equal(flowReadiness(pipeline, result), 'Needs input');
});

test('question and incoming-result labels are escaped in flow markup without mutating content', async () => {
  const { pipeline, source, target, flowNode, flowConnections } = await flowHarness();
  source.label = 'Review <img src=x onerror=unsafe()> "quoted"';
  source.questions.answer.label = '</button><script>unsafe()</script>';
  target.inputs = { incoming: { stage: source.id, question: 'answer', select: 'summary' } };
  target.dependsOn = [source.id];
  const before = JSON.stringify(pipeline);
  const html = flowNode(pipeline, source) + flowConnections(pipeline, target);
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
  assert.equal(JSON.stringify(pipeline), before);
});


test('independent question opens What to ask and offers audience creation inside the pipeline without changing existing nodes', async () => {
  const { S, pipeline, flowAction, flowCohortMap } = await flowHarness();
  const before = JSON.stringify(pipeline.stages);
  flowAction('flow-add', { dataset: { kind: 'independent' } });
  const added = pipeline.stages.at(-1);
  assert.equal(JSON.stringify(pipeline.stages.slice(0, -1)), before);
  assert.equal(added.kind, 'poll');
  assert.deepEqual(plain(added.dependsOn), []);
  assert.equal(S.tab, 'studies');
  assert.equal(S.sections['flow-inspector'], 'question');
  const html = flowCohortMap(pipeline, added);
  assert.match(html, /Create the audience/);
  assert.match(html, /data-act="flow-audience-generate"/);
  assert.doesNotMatch(html, /name="setupPrompt"/);
});

test('canvas create menu lists every step kind, filters by text and places the new step where the canvas was clicked', async () => {
  const { S, pipeline, flowAction, flowCreateMenu, flowKindMatches } = await flowHarness();
  assert.equal(flowCreateMenu(pipeline), '');
  S.flowCreate = { pipelineId: 'study', x: 412.4, y: 96.6, left: 0, top: 0, query: '', index: 0 };
  const menu = flowCreateMenu(pipeline);
  for (const label of ['Ask the audience', 'Final answer']) assert.match(menu, new RegExp(label));
  assert.doesNotMatch(menu, /Combine answers|Final choice|Final result/, 'one Final answer entry; how it decides is a setting on the step');
  assert.deepEqual(plain(flowKindMatches('comb').map((k: any) => k.kind)), ['choose']);
  assert.deepEqual(plain(flowKindMatches('winner').map((k: any) => k.kind)), ['choose']);
  const before = JSON.stringify(pipeline.stages);
  flowAction('flow-create', { dataset: { kind: 'choose' } });
  const added = pipeline.stages.at(-1);
  assert.equal(JSON.stringify(pipeline.stages.slice(0, -1)), before);
  assert.equal(added.kind, 'choose');
  assert.deepEqual(plain(added.inputs), {});
  assert.equal(added.cohort, undefined, 'a final choice has no audience');
  assert.deepEqual(plain(pipeline.layout[added.id]), { x: 412, y: 97 });
  assert.equal(S.stageId, added.id);
  assert.equal(S.flowCreate, null);
  assert.equal(S.dirty, true);
});

test('canvas create ignores unknown kinds and menus opened for another study', async () => {
  const { S, pipeline, flowAction } = await flowHarness();
  const count = pipeline.stages.length;
  S.flowCreate = { pipelineId: 'other-study', x: 0, y: 0, left: 0, top: 0, query: '', index: 0 };
  flowAction('flow-create', { dataset: { kind: 'poll' } });
  S.flowCreate = { pipelineId: 'study', x: 0, y: 0, left: 0, top: 0, query: '', index: 0 };
  flowAction('flow-create', { dataset: { kind: 'script' } });
  assert.equal(pipeline.stages.length, count);
  assert.equal(pipeline.layout, undefined);
});

test('a step asking more people than its cohort has needs more personas and opens the Cohort tab', async () => {
  const { S, pipeline, source, flowReadiness, flowTodo, flowNode, flowInspector, flowAction } = await flowHarness();
  const persona = (n: number, segment: string) => ({ id: `p${n}`, label: `P${n}`, segment, weight: 1 });
  S.doc.cohorts = [{ id: 'c1', name: 'Gamers', segments: [{ id: 'live', label: 'Live', weight: 1 }, { id: 'zero', label: 'Zero', weight: 0 }],
    personas: [...Array.from({ length: 8 }, (_, n) => persona(n, 'live')), persona(9, 'zero')] }];
  pipeline.cohorts = { audience: 'c1' };
  pipeline.stages = [source];
  source.size = 100;
  assert.equal(flowReadiness(pipeline, source), 'Needs more personas');
  assert.deepEqual(plain(flowTodo(pipeline)), [{ stageId: 'source', tab: 'cohort', pick: false }]);
  assert.match(flowNode(pipeline, source), /flow-sample-short">100 of 8 personas/);
  S.sections['flow-inspector'] = 'cohort'; S.flowPanel = true; S.stageId = 'source';
  assert.match(flowInspector(pipeline, source), /Asks 100 people but this cohort has 8\. Lower the sample size to 8 or add personas\./);
  assert.match(flowInspector(pipeline, source), /Use all 8/);
  // Repeats do not add people, and a size within the cohort stays ready.
  source.size = 8; source.repeats = 5;
  assert.equal(flowReadiness(pipeline, source), 'Ready');
  assert.equal(flowTodo(pipeline).length, 0);
  assert.match(flowNode(pipeline, source), /8 personas/);
  source.size = 100;
  flowAction('flow-sample-all', { dataset: { id: 'source' } });
  assert.equal(source.size, 8);
  assert.equal(flowReadiness(pipeline, source), 'Ready');
  delete source.size;
  assert.equal(flowReadiness(pipeline, source), 'Ready');
});

test('the guided stops advance with Next, skip Options for Yes / no, and block an unfinished stop', async () => {
  const { S, pipeline, flowAction, flowRoundTabs, flowInspector, source } = await flowHarness();
  Object.assign(S, { stageId: 'source', flowPanel: true });
  S.sections['flow-inspector'] = 'question';
  const q: any = source.questions.answer;
  const tabs = () => plain(flowRoundTabs(pipeline, source)).map((t: any) => t[0]);
  assert.deepEqual(tabs(), ['question', 'answers', 'cohort', 'connections', 'settings']);
  assert.match(flowInspector(pipeline, source), /Next: Options/);
  q.label = '';
  flowAction('flow-next', { dataset: {} });
  assert.equal(S.sections['flow-inspector'], 'question', 'an empty question blocks Next');
  assert.match(S.sections['flow-inspector-error'], /Write the question/);
  q.label = 'Which name?';
  flowAction('flow-next', { dataset: {} });
  assert.equal(S.sections['flow-inspector'], 'answers');
  assert.equal(S.sections['flow-inspector-error'], undefined);
  assert.match(flowInspector(pipeline, source), /Next: Who answers/);
  assert.match(flowInspector(pipeline, source), /data-section="question" aria-selected="false" data-done="true"/);
  q.type = 'noul'; q.criteria = {};
  assert.deepEqual(tabs(), ['question', 'cohort', 'connections', 'settings'], 'Yes / no has no Options stop');
  S.sections['flow-inspector'] = 'question';
  flowAction('flow-next', { dataset: {} });
  assert.equal(S.sections['flow-inspector'], 'cohort');
  flowAction('flow-next', { dataset: {} });
  assert.equal(S.sections['flow-inspector'], 'cohort', 'no cohort chosen yet blocks Done');
  assert.match(S.sections['flow-inspector-error'], /who answers/i);
  assert.match(flowInspector(pipeline, source), /Create the audience/);
});

/** A connected study: `target` reads `source` as a summary and `other` as individual answers, and `final` reads `target`. */
async function connectedFlow() {
  const harness = await flowHarness();
  const { pipeline, target, flowConnect } = harness;
  flowConnect(pipeline, 'source', 'answer', 'target');
  flowConnect(pipeline, 'other', 'answer', 'target');
  const key = Object.keys(target.inputs).find(k => target.inputs[k].stage === 'other')!;
  target.inputs[key].select = 'responses';
  const final: any = { id: 'final', label: 'Final result', kind: 'decision', from: { stage: 'target', question: 'answer' }, outputQuestion: 'decision', dependsOn: ['target'] };
  pipeline.stages.push(final);
  return { ...harness, final };
}

test('a step lists everything it reads, by step and projection, instead of labelling every wire', async () => {
  const { pipeline, target, flowReads, flowNode } = await connectedFlow();
  assert.deepEqual(plain(flowReads(pipeline, target).map((r: any) => [r.n, r.label])), [[1, 'Answer summary'], [2, 'Individual answers']]);
  const card = flowNode(pipeline, target);
  assert.match(card, /Uses steps 1, 2/);
  assert.match(card, /aria-label="Inputs: Answer summary from step 1; Individual answers from step 2"/, 'the full list is available to assistive tech');
  assert.doesNotMatch(WORKSPACE_FLOW_CLIENT, /flow-wire-label/, 'no label text is drawn on wires');
  assert.doesNotMatch(WORKSPACE_FLOW_CLIENT, /createElementNS\([^)]*'text'\)/);
  assert.match(WORKSPACE_FLOW_CLIENT, /flow-wire-hit/, 'a wire is named only while the pointer is on it');
  assert.match(WORKSPACE_FLOW_CSS, /\.flow-wire-hit\{[^}]*pointer-events:stroke/);
});

test('the wire tooltip stays inside the visible canvas and never under the slide-over', async () => {
  const { element, flowTipShow } = await flowHarness();
  const tip: any = { style: {}, offsetWidth: 140, offsetHeight: 44, replaceChildren() {}, setAttribute() {}, className: '', id: '' };
  const board: any = { querySelector: () => tip, append() {} };
  const viewport: any = { closest: () => board, clientWidth: 900, clientHeight: 500, getBoundingClientRect: () => ({ left: 100, top: 50, width: 900, height: 500 }) };
  const app = element('app');
  app.querySelector = (sel: string) => sel === '.round-panel' ? { getBoundingClientRect: () => ({ left: 700, right: 1000, top: 40, bottom: 700, width: 300 }) } : null;
  flowTipShow(viewport, ['Answer summary', 'Step 1 to step 3'], { x: 690, y: 300 });
  assert.ok(parseFloat(tip.style.left) + 140 <= 700 - 4, 'right edge stops before the slide-over');
  flowTipShow(viewport, ['Answer summary'], { x: 110, y: 52 });
  assert.ok(parseFloat(tip.style.left) >= 104 && parseFloat(tip.style.top) >= 54, 'clamped to the canvas top-left');
  app.querySelector = () => null;
  flowTipShow(viewport, ['Answer summary'], { x: 995, y: 300 });
  assert.ok(parseFloat(tip.style.left) + 140 <= 100 + 900 - 4, 'without a panel it stays inside the canvas');
});

test('at 700px and narrower the flow is a list of full-width steps in run order with Reads lines and no wires', async () => {
  const { setNarrow, pipeline, flowCanvas, flowWorkspace, flowListMode, S } = await connectedFlow();
  assert.equal(flowListMode(), false);
  assert.match(flowCanvas(pipeline), /class="flow-map"/);
  setNarrow(true);
  assert.equal(flowListMode(), true);
  const list = flowCanvas(pipeline);
  assert.match(list, /class="flow-list-view"/);
  assert.doesNotMatch(list, /flow-map|flow-viewport|flow-links/, 'no graph canvas, wires or pan area in list mode');
  assert.equal((list.match(/<li class="flow-list-item">/g) || []).length, 4);
  assert.match(list, /Reads step 1 <small>Answer summary<\/small>/);
  assert.match(list, /Reads step 2 <small>Individual answers<\/small>/);
  assert.match(list, /Reads step 3 <small>Probability distribution<\/small>/);
  assert.doesNotMatch(list, /Uses steps?/);
  assert.match(list, /data-act="flow-output"/, 'Connect actions stay');
  pipeline.stages.push({ id: 'tail', label: 'Tail', kind: 'poll', cohort: 'audience', dependsOn: [], inputs: {}, questions: pipeline.stages[0].questions });
  assert.match(flowCanvas(pipeline), /data-act="flow-add-menu" data-id="tail"/, 'Add next step stays');
  const workspace = flowWorkspace(pipeline, pipeline.stages[2]);
  assert.match(workspace, /data-act="flow-create-open"/);
  assert.doesNotMatch(workspace, /data-act="flow-fit"|data-act="flow-reset"/, 'fit and zoom make no sense on a list');
  S.flowAdd = 'target';
  assert.match(flowWorkspace(pipeline, pipeline.stages[2]), /<li class="flow-list-item">(?:(?!<\/li>).)*flow-action-bar/s, 'add actions sit under the step they extend');
  assert.match(ROUND_PANEL_CSS, /@media\(max-width:700px\)\{\.round-panel\{position:fixed;inset:0/, 'the slide-over fills the screen');
  assert.match(WORKSPACE_FLOW_CSS, /\.flow-list \.flow-node\{[^}]*touch-action:auto/, 'cards scroll rather than drag');
});

test('list mode orders steps so each follows what it reads, otherwise by step number', async () => {
  const { pipeline, flowRunOrder, source, target } = await connectedFlow();
  assert.deepEqual(plain(flowRunOrder(pipeline).map((s: any) => s.id)), ['source', 'other', 'target', 'final']);
  const late: any = { id: 'late', label: 'Late', kind: 'poll', cohort: 'audience', dependsOn: ['final'], inputs: {}, questions: source.questions };
  pipeline.stages.splice(0, 0, late);
  assert.deepEqual(plain(flowRunOrder(pipeline).map((s: any) => s.id)), ['source', 'other', 'target', 'final', 'late']);
  assert.equal(target.dependsOn.length, 2);
});

test('adding a step in list mode places no canvas position, so the wide layout stays untouched', async () => {
  const { setNarrow, S, pipeline, flowAction } = await connectedFlow();
  setNarrow(true);
  S.flowCreate = { pipelineId: 'study', x: 0, y: 0, left: 0, top: 0, query: '', index: 0 };
  flowAction('flow-create', { dataset: { kind: 'poll' } });
  assert.equal(pipeline.stages.at(-1).kind, 'poll');
  assert.equal(pipeline.layout, undefined);
  assert.equal(S.flowPanel, true);
});

test('dropping a dragged output on a step connects it and shows its Inputs when the panel is open; dropping elsewhere changes nothing', async () => {
  const { S, pipeline, flowWireEnd, flowInputs } = await flowHarness();
  const fake = (): any => ({ removeAttribute() {}, classList: { remove() {} }, querySelectorAll: () => [] });
  const drag = (target: any) => ({ p: pipeline, stage: 'source', question: 'answer', viewport: fake(), output: fake(), wire: { remove() {} }, target });
  const before = JSON.stringify(pipeline.stages);
  flowWireEnd(drag(null), false);
  assert.equal(JSON.stringify(pipeline.stages), before);
  assert.equal(S.dirty, false);
  flowWireEnd(drag({ dataset: { flowNode: 'target' } }), true);
  assert.equal(JSON.stringify(pipeline.stages), before, 'a cancelled drag never connects');
  S.flowSource = { pipelineId: 'study', stage: 'other', question: 'answer' };
  S.flowPanel = true;
  flowWireEnd(drag({ dataset: { flowNode: 'target' } }), false);
  assert.deepEqual(plain(flowInputs(pipeline, pipeline.stages[2]).map(([, input]: any) => [input.stage, input.question])), [['source', 'answer']]);
  assert.equal(S.stageId, 'target');
  assert.equal(S.sections['flow-inspector'], 'connections');
  assert.equal(S.flowSource, null, 'a pending click connection is cleared');
  assert.equal(S.dirty, true);
});

test('output sockets advertise dragging and the canvas styles live wires and drop targets', () => {
  assert.match(WORKSPACE_FLOW_CLIENT, /Drag onto the step that should use it/);
  assert.match(WORKSPACE_FLOW_CSS, /\.flow-drag-wire\{[^}]*pointer-events:none/);
  assert.match(WORKSPACE_FLOW_CSS, /\.flow-node\[data-drop-target=true\]/);
});

test('a drop with the step panel closed keeps the canvas clear for the next wire', async () => {
  const { S, pipeline, flowWireEnd } = await flowHarness();
  const fake = (): any => ({ removeAttribute() {}, classList: { remove() {} }, querySelectorAll: () => [] });
  S.flowPanel = false;
  flowWireEnd({ p: pipeline, stage: 'source', question: 'answer', viewport: fake(), output: fake(), wire: { remove() {} }, target: { dataset: { flowNode: 'other' } } }, false);
  assert.equal(S.flowPanel, false);
  assert.equal(S.stageId, 'other');
  assert.deepEqual(plain(pipeline.stages[1].dependsOn), ['source']);
});

test('a wire dropped on blank canvas opens the add-step menu there, and the step picked reads that output', async () => {
  const { S, pipeline, flowAction, flowCreateMenu, flowInputs } = await flowHarness();
  S.flowCreate = { pipelineId: 'study', x: 500.2, y: 220.7, left: 0, top: 0, query: '', index: 0, connect: { stage: 'source', question: 'answer' } };
  assert.match(flowCreateMenu(pipeline), /Add a step that uses this output/);
  flowAction('flow-create', { dataset: { kind: 'poll' } });
  const added = pipeline.stages.at(-1);
  assert.equal(added.kind, 'poll');
  assert.equal(added.cohort, 'audience', 'a follow-up asks the same audience as its source');
  assert.deepEqual(plain(pipeline.layout[added.id]), { x: 500, y: 221 });
  assert.deepEqual(plain(flowInputs(pipeline, added).map(([, input]: any) => [input.stage, input.question])), [['source', 'answer']]);
  assert.equal(S.stageId, added.id);
  assert.equal(S.flowCreate, null);
});

test('a dropped wire only offers step kinds that can use it', async () => {
  const { S, pipeline, flowAction, flowKindMatches } = await flowHarness();
  const connect = { stage: 'source', question: 'answer' };
  S.pipelineId = 'study';
  assert.deepEqual(plain(flowKindMatches('', connect).map((k: any) => k.kind)), ['poll', 'choose']);
  pipeline.stages[0].questions.answer = { type: 'score', label: 'How much?', instructions: 'Rate it.', scale: { min: 1, max: 5 } };
  assert.deepEqual(plain(flowKindMatches('', connect).map((k: any) => k.kind)), ['poll', 'choose'], 'a Final answer that Jev decides reads a Score too');
  const count = pipeline.stages.length;
  S.flowCreate = { pipelineId: 'study', x: 0, y: 0, left: 0, top: 0, query: '', index: 0, connect };
  flowAction('flow-create', { dataset: { kind: 'decision' } });
  assert.equal(pipeline.stages.length, count);
});

test('canvas cards keep the same rows whether a step is named, connected or not', async () => {
  const { pipeline, source, target, flowNode, flowConnect } = await flowHarness();
  source.label = 'name-voting';
  flowConnect(pipeline, 'source', 'answer', 'target');
  const named = flowNode(pipeline, source), wired = flowNode(pipeline, target);
  for (const card of [named, wired]) {
    assert.match(card, /<button class="flow-select"[^>]*><strong>[^<]*<\/strong><span>[^<]+<\/span><\/button>/, 'title plus one line under it');
    assert.match(card, /class="flow-next"/, 'Add next step on every Ask card');
  }
  assert.match(named, /class="flow-output-sent">Sent to step 3</);
  assert.match(wired, /Connect output /);
  assert.match(wired, /<div class="flow-node-header">[\s\S]*data-act="flow-inputs"[\s\S]*title="Uses step 1"[\s\S]*<\/div><button class="flow-select"/, 'inputs sit in the header, not their own row');
  assert.match(WORKSPACE_FLOW_CSS, /\.flow-map \.flow-node\[data-selected=true\]\{border:1px solid/, 'selection does not change card height');
});

test('a final choice dropped on an output reads every answer, starts from its options, and needs no audience', async () => {
  const { S, pipeline, flowAction, flowReadiness, flowRoundTabs, flowNode, flowConnections, flowTodo, stageForm } = await flowHarness();
  S.flowCreate = { pipelineId: 'study', x: 10, y: 10, left: 0, top: 0, query: '', index: 0, connect: { stage: 'source', question: 'answer' } };
  flowAction('flow-create', { dataset: { kind: 'choose' } });
  const added = pipeline.stages.at(-1);
  assert.equal(added.kind, 'choose');
  assert.deepEqual(plain(added.inputs), { answer_1: { stage: 'source', question: 'answer', select: 'responses' } });
  assert.deepEqual(plain(added.questions.choice.criteria), { a: 'A', b: 'B' });
  assert.deepEqual(plain(added.dependsOn), ['source']);
  assert.equal(flowReadiness(pipeline, added), 'Ready');
  assert.deepEqual(plain(flowRoundTabs(pipeline, added).map(([key, label]: any) => [key, label])), [['question', 'What to decide'], ['answers', 'Options'], ['connections', 'Reads'], ['settings', 'Settings']]);
  assert.match(flowNode(pipeline, added, false), /<span class="flow-kind">Final answer<\/span>/);
  assert.doesNotMatch(flowNode(pipeline, added, false), /flow-who/);
  assert.match(stageForm(pipeline, added, 'question'), /What should it decide\?/);
  const reads = flowConnections(pipeline, added);
  assert.match(reads, /reads it in slices and combines its own verdicts automatically/);
  assert.match(reads, /data-act="flow-choose-read"[^>]*data-mode="responses" aria-pressed="true"/);
  flowAction('flow-choose-read', { dataset: { id: added.id, key: 'answer_1', mode: 'summary' } });
  assert.equal(added.inputs.answer_1.select, 'summary');
  assert.ok(!flowTodo(pipeline).some((item: any) => item.stageId === added.id));
  flowAction('flow-disconnect', { dataset: { id: added.id, key: 'answer_1' } });
  assert.equal(flowReadiness(pipeline, added), 'Needs input');
  assert.deepEqual(plain(flowTodo(pipeline).find((item: any) => item.stageId === added.id)), { stageId: added.id, tab: 'connections' });
});

test('a Final answer\'s Reads tab lists each earlier output once with an Off / Summary / Every answer switch', async () => {
  const { S, pipeline, flowAction, flowConnections, flowInspector } = await flowHarness();
  S.flowCreate = { pipelineId: 'study', x: 10, y: 10, left: 0, top: 0, query: '', index: 0, connect: { stage: 'source', question: 'answer' } };
  flowAction('flow-create', { dataset: { kind: 'choose' } });
  const added = pipeline.stages.at(-1);
  added.questions.choice.optionsFrom = { stage: 'source', question: 'answer', top: 2 };
  const reads = flowConnections(pipeline, added);
  assert.match(reads, /What it can pick from is on the Options tab/);
  assert.doesNotMatch(reads, /Jev picks from|Gives the options/, 'what Jev picks from lives only on the Options tab');
  assert.doesNotMatch(reads, /Connected results|Connect an output|Options from|data-act="flow-disconnect"/);
  assert.equal(reads.match(/data-source="source" data-question="answer"[^>]*data-mode="off"/g)?.length, 1, 'the options source is one row, not two');
  assert.match(reads, /data-source="other" data-question="answer" data-mode="off" aria-pressed="true"/);
  flowAction('flow-choose-read', { dataset: { id: added.id, source: 'other', question: 'answer', mode: 'summary' } });
  const key = Object.keys(added.inputs).find((k: string) => added.inputs[k].stage === 'other')!;
  assert.equal(added.inputs[key].select, 'summary');
  assert.ok(added.dependsOn.includes('other'));
  flowAction('flow-choose-read', { dataset: { id: added.id, source: 'other', question: 'answer', mode: 'off' } });
  assert.ok(!Object.values(added.inputs).some((input: any) => input.stage === 'other'));
  assert.ok(!added.dependsOn.includes('other'));
  flowAction('flow-choose-read', { dataset: { id: added.id, source: 'source', question: 'answer', mode: 'off' } });
  assert.deepEqual(plain(added.inputs), {});
  assert.ok(added.dependsOn.includes('source'), 'the options source stays a dependency');
  assert.match(flowConnections(pipeline, added), /Turn on at least one output for Jev to read/);
  S.stageId = added.id; S.flowPanel = true; S.sections['flow-inspector'] = 'answers';
  assert.match(flowInspector(pipeline, added), /Next: Reads/, 'the Options footer names the Reads tab');
});

test('an existing Combine answers step switches to a Final choice that keeps its output name', async () => {
  const { S, pipeline, setupAction, resultSetup } = await flowHarness();
  const combine = { id: 'combine', kind: 'aggregate', label: 'Combined answers', dependsOn: ['source', 'other'], inputs: [{ stage: 'source', question: 'answer', weight: 1 }, { stage: 'other', question: 'answer', weight: 2 }], outputQuestion: 'combined' };
  pipeline.stages.push(combine, { id: 'result', kind: 'decision', label: 'Final result', dependsOn: ['combine'], from: { stage: 'combine', question: 'combined' }, outputQuestion: 'decision' });
  S.stageId = 'combine';
  assert.match(resultSetup(pipeline, combine), /Let Jev decide instead/);
  setupAction('setup-to-choice', { dataset: {} });
  assert.equal(combine.kind, 'choose');
  assert.equal(combine.label, 'Final answer');
  assert.deepEqual(Object.keys(combine), ['id', 'kind', 'label', 'questions', 'inputs', 'dependsOn']);
  assert.deepEqual(plain((combine as any).inputs), { answer_1: { stage: 'source', question: 'answer', select: 'responses' }, answer_2: { stage: 'other', question: 'answer', select: 'responses' } });
  assert.deepEqual(plain((combine as any).questions.combined.criteria), { a: 'A', b: 'B' });
  assert.equal(S.dirty, true);
});

test('a Final answer switches between letting Jev decide and taking the top option, keeping its output name', async () => {
  const { S, pipeline, flowAction, flowInspector } = await flowHarness();
  S.pipelineId = 'study';
  S.flowCreate = { pipelineId: 'study', x: 10, y: 10, left: 0, top: 0, query: '', index: 0, connect: { stage: 'source', question: 'answer' } };
  flowAction('flow-create', { dataset: { kind: 'choose' } });
  const added = pipeline.stages.at(-1);
  S.stageId = added.id; S.sections['flow-inspector'] = 'question';
  const jev = flowInspector(pipeline, added);
  assert.match(jev, /How should it decide\?/);
  assert.match(jev, /data-mode="jev" aria-pressed="true"/);
  assert.match(jev, /data-mode="top" aria-pressed="false">/, 'top option is offered once a Choice is connected');
  flowAction('flow-answer-mode', { dataset: { id: added.id, mode: 'top' } });
  assert.equal(added.kind, 'decision');
  assert.equal(added.label, 'Final answer');
  assert.deepEqual(plain(added.from), { stage: 'source', question: 'answer' });
  assert.equal(added.outputQuestion, 'choice');
  assert.deepEqual(plain(added.dependsOn), ['source']);
  assert.match(flowInspector(pipeline, added), /data-mode="top" aria-pressed="true"/);
  flowAction('flow-answer-mode', { dataset: { id: added.id, mode: 'jev' } });
  assert.equal(added.kind, 'choose');
  assert.deepEqual(Object.keys(added.questions), ['choice']);
  assert.deepEqual(plain(added.inputs), { answer_1: { stage: 'source', question: 'answer', select: 'responses' } });
  assert.deepEqual(plain(added.questions.choice.criteria), { a: 'A', b: 'B' });
  flowAction('flow-disconnect', { dataset: { id: added.id, key: 'answer_1' } });
  assert.match(flowInspector(pipeline, added), /data-mode="top" aria-pressed="false" disabled/, 'top option needs a connected Choice');
});

test('deleting a step removes every reference to it and leaves later steps in place', async () => {
  const { pipeline, source, other, target, removeStep, stepReaders } = await flowHarness();
  const combine: any = { id: 'combine', kind: 'aggregate', label: 'Combined', dependsOn: ['source', 'other'], outputQuestion: 'answer', inputs: [{ stage: 'source', question: 'answer', weight: 1 }, { stage: 'other', question: 'answer', weight: 1 }] };
  const top: any = { id: 'top', kind: 'decision', label: 'Top', dependsOn: ['source'], from: { stage: 'source', question: 'answer' }, outputQuestion: 'answer' };
  pipeline.stages.push(combine, top);
  pipeline.layout = { source: { x: 0, y: 0 }, other: { x: 0, y: 200 } };
  target.inputs = { answer_1: { stage: 'source', question: 'answer', select: 'summary' }, answer_2: { stage: 'other', question: 'answer', select: 'summary' } };
  target.dependsOn = ['source', 'other'];
  target.when = { all: [{ stage: 'source', question: 'answer', metric: 'margin', op: 'gt', value: 0.1 }, { stage: 'other', question: 'answer', metric: 'margin', op: 'gt', value: 0.1 }] };
  other.questions.answer.optionsFrom = { stage: 'source', question: 'answer' };
  assert.deepEqual(stepReaders(pipeline, 'source').map((x: any) => x.id), ['other', 'target', 'combine', 'top']);
  removeStep(pipeline, 'source');
  assert.deepEqual(pipeline.stages.map((x: any) => x.id), ['other', 'target', 'combine', 'top']);
  assert.equal(pipeline.layout.source, undefined);
  assert.deepEqual(plain(target.inputs), { answer_2: { stage: 'other', question: 'answer', select: 'summary' } });
  assert.deepEqual(plain(target.dependsOn), ['other']);
  assert.deepEqual(plain(target.when), { stage: 'other', question: 'answer', metric: 'margin', op: 'gt', value: 0.1 }, 'a group left with one rule becomes that rule');
  assert.deepEqual(plain(combine.inputs), [{ stage: 'other', question: 'answer', weight: 1 }]);
  assert.deepEqual(plain(combine.dependsOn), ['other']);
  assert.deepEqual(plain(top.from), { stage: '', question: '' });
  assert.deepEqual(plain(top.dependsOn), []);
  assert.equal(other.questions.answer.optionsFrom, undefined);
  assert.deepEqual(plain(other.questions.answer.criteria), { a: 'A', b: 'B' }, 'options read from the deleted step stay as typed options');
  assert.equal(JSON.stringify(pipeline).includes('"source"'), false, 'nothing still points at the deleted step');
});

test('every kind of step offers delete in its panel and on its card, behind one confirmation', async () => {
  const { S, pipeline, flowInspector, flowNode, flowNewStage, requestStepDeletion, stepDeletionAction, element } = await flowHarness();
  const combine: any = { id: 'combine', kind: 'aggregate', label: 'Combined', dependsOn: ['source'], outputQuestion: 'answer', inputs: [{ stage: 'source', question: 'answer', weight: 1 }] };
  const top: any = { id: 'top', kind: 'decision', label: 'Top', dependsOn: ['source'], from: { stage: 'source', question: 'answer' }, outputQuestion: 'answer' };
  pipeline.stages.push(combine, top, { ...flowNewStage(pipeline, 'choose'), id: 'jev' });
  S.flowPanel = true;
  for (const stage of pipeline.stages) {
    S.stageId = stage.id;
    assert.match(flowInspector(pipeline, stage), new RegExp(`data-act="step-delete" data-id="${stage.id}"`), `${stage.kind} panel`);
    assert.match(flowNode(pipeline, stage, false), new RegExp(`data-act="step-delete" data-id="${stage.id}"`), `${stage.kind} card`);
  }
  let opened = 0; const dialog = element('deleteStepDialog'); dialog.showModal = () => { opened++; }; dialog.close = () => {};
  requestStepDeletion('source');
  assert.equal(opened, 1);
  assert.equal(pipeline.stages.length, 6, 'asking does not delete');
  assert.match(element('deleteStepImpact').textContent, /Steps 4, 5 will stay but stop reading from it/);
  stepDeletionAction('step-delete-close', { dataset: {} });
  assert.equal(S.stepDeletion, null);
  assert.equal(pipeline.stages.length, 6, 'cancel keeps the step');
});

test('a confirmed delete can be undone, but never over a later edit', async () => {
  const { S, pipeline, target, requestStepDeletion, stepDeletionAction, undoStepDeletion, element } = await flowHarness();
  const dialog = element('deleteStepDialog'); dialog.showModal = () => {}; dialog.close = () => {};
  target.inputs = { answer_1: { stage: 'source', question: 'answer', select: 'summary' } }; target.dependsOn = ['source'];
  pipeline.layout = { source: { x: 10, y: 20 } };
  const before = JSON.stringify(pipeline.stages);
  S.stageId = 'source'; S.flowPanel = true;
  requestStepDeletion('source'); stepDeletionAction('step-delete-confirm', { dataset: {} });
  assert.deepEqual(plain(pipeline.stages.map((x: any) => x.id)), ['other', 'target']);
  assert.equal(S.flowPanel, false, 'the panel of a deleted step closes');
  assert.equal(S.dirty, true);
  assert.ok(undoStepDeletion());
  assert.equal(JSON.stringify(pipeline.stages), before, 'undo restores the step and its connections');
  assert.deepEqual(plain(pipeline.layout.source), { x: 10, y: 20 });
  assert.equal(S.stageId, 'source'); assert.equal(S.flowPanel, true);
  requestStepDeletion('other'); stepDeletionAction('step-delete-confirm', { dataset: {} });
  pipeline.stages[0].label = 'Edited after the delete';
  undoStepDeletion();
  assert.deepEqual(plain(pipeline.stages.map((x: any) => x.id)), ['source', 'target'], 'a later edit is kept rather than overwritten');
  assert.equal(pipeline.stages[0].label, 'Edited after the delete');
});
