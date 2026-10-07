import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderWorkspace } from '../src/workspace-ui.js';

// Execute the served browser client so connection tests use the real graph and
// dependency helpers, including legacy bindings and nested branch conditions.
async function flowHarness() {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', hidden: false, inert: false,
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: () => null, querySelectorAll: () => [], focus() {},
    });
    return elements.get(id);
  };
  const snapshot = {
    revision: 1,
    document: { version: 1, cohorts: [], pipelines: [] },
    auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null,
  };
  const context: any = {
    location: { origin: 'http://127.0.0.1:4180' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} },
    fetch: async (path: string) => ({ ok: true, json: async () => structuredClone(
      path === '/api/local-agents' ? { engines: [] } :
      path === '/api/chatgpt/status' ? { connected: false, planEnabled: false } : snapshot,
    ) }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
    navigator: {}, URL, Blob, TextEncoder, FormData,
  };
  const html = renderWorkspace('flow-test', 'token');
  const script = html.match(/<script nonce="flow-test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.flowTest={S,flowAction,flowConnect,flowDisconnect,flowInputs,flowNode,flowReadiness,flowConnections};})();');
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
  return { ...client, pipeline, source: pipeline.stages[0], other: pipeline.stages[1], target: pipeline.stages[2], element };
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
  assert.equal(flowReadiness(pipeline, target), 'Needs cohort');
  const result = { id: 'result', kind: 'decision', label: 'Result', from: { stage: '', question: '' }, outputQuestion: 'result', dependsOn: [] };
  assert.equal(flowReadiness(pipeline, result), 'Needs input');
});

test('readiness requires a populated cohort and at least two named options or scale levels', async () => {
  const { S, pipeline, source, flowReadiness } = await flowHarness();
  pipeline.cohorts.audience = 'people';
  const cohort = { id: 'people', personas: [] as any[] };
  S.doc.cohorts.push(cohort);
  const before = JSON.stringify(pipeline);
  assert.equal(flowReadiness(pipeline, source), 'Needs cohort');
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
