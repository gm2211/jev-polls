import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderWorkspace } from '../src/workspace-ui.js';

async function harness() {
  const element = { innerHTML: '', textContent: '', value: '', hidden: false, inert: false,
    classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], focus() {}, addEventListener() {} };
  const snapshot = { revision: 1, document: { version: 1, cohorts: [], pipelines: [] }, auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null };
  const context: any = {
    location: { origin: 'http://127.0.0.1:4180' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => element, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} }, navigator: {}, URL, Blob, TextEncoder, FormData,
    fetch: async (path: string) => ({ ok: true, json: async () => structuredClone(path === '/api/local-agents' ? { engines: [] } : path === '/api/chatgpt/status' ? { connected: false, planEnabled: false } : snapshot) }),
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
  };
  const client = renderWorkspace('connection-test', 'token').match(/<script nonce="connection-test">([\s\S]*?)<\/script>/)![1]!;
  new Script(client.replace(/\}\)\(\);$/, 'globalThis.flow={S,flowAction,flowNode,flowConnections,flowCanConnect,flowOutputLabel};})();')).runInNewContext(context);
  await new Promise<void>(resolve => setImmediate(resolve));
  const flow = context.flow;
  const poll = (id: string): any => ({ id, kind: 'poll', label: id, cohort: 'people', dependsOn: [], inputs: {}, questions: {
    answer: { type: 'choice', label: 'Which name?', instructions: 'Compare names', criteria: { a: 'A', b: 'B' } },
    second: { type: 'noul', label: 'Is it memorable?', instructions: 'Judge memorability' },
  } });
  const pipeline = { id: 'study', name: 'Study', cohorts: {}, context: {}, stages: [poll('source'), poll('target'), poll('downstream')] };
  flow.S.doc.pipelines = [pipeline];
  flow.S.doc.projects = [{ id: 'project', name: 'Project', description: '', cohortIds: [], pipelineIds: ['study'] }];
  Object.assign(flow.S, { projectId: 'project', pipelineId: 'study', stageId: 'target', tab: 'studies', dirty: false, plan: { revision: 1, stages: [], warnings: [], provider: 'typesafe', model: 'jev', maxRequests: 0 } });
  return { ...flow, pipeline, source: pipeline.stages[0], target: pipeline.stages[1], downstream: pipeline.stages[2] };
}

test('output affordance names action and distinguishes probabilities from local relative scores', async () => {
  const { S, pipeline, source, flowNode } = await harness();
  let html = flowNode(pipeline, source);
  assert.match(html, /Connect output /);
  assert.match(html, /Probability distribution/);
  assert.match(html, /data-question="second"/);
  S.evaluationProvider = 'gliner';
  html = flowNode(pipeline, source);
  assert.match(html, /Relative score distribution/);
  assert.doesNotMatch(html, /Probability distribution/);
});

test('Connect here appears only on compatible acyclic destinations', async () => {
  const { S, pipeline, source, target, downstream, flowNode } = await harness();
  downstream.dependsOn = ['source'];
  S.flowSource = { pipelineId: pipeline.id, stage: 'downstream', question: 'answer' };
  assert.doesNotMatch(flowNode(pipeline, source), /data-act="flow-connect"/);
  assert.doesNotMatch(flowNode(pipeline, downstream), /data-act="flow-connect"/);
  assert.match(flowNode(pipeline, target), /Connect here/);
  const aggregate: any = { id: 'combine', kind: 'aggregate', label: 'Combined', inputs: [{ stage: 'source', question: 'answer', weight: 1 }], outputQuestion: 'combined', dependsOn: ['source'] };
  pipeline.stages.push(aggregate);
  S.flowSource.question = 'second';
  assert.doesNotMatch(flowNode(pipeline, aggregate), /data-act="flow-connect"/);
});

test('Inputs picker excludes cycles and existing bindings, and preserves question identity', async () => {
  const { pipeline, source, target, downstream, flowConnections } = await harness();
  target.inputs = { custom: { stage: 'source', question: 'answer', select: 'winner' } };
  target.dependsOn = ['source'];
  downstream.dependsOn = ['target'];
  const html = flowConnections(pipeline, target);
  assert.match(html, /Connect an output/);
  assert.match(html, /data-source="source" data-question="second"/);
  assert.doesNotMatch(html, /data-source="source" data-question="answer"/);
  assert.doesNotMatch(html, /data-source="downstream"/);
  assert.equal(source.questions.second.type, 'noul');
});

test('picker connects selected output directly, preserving prior projections and invalidating review', async () => {
  const { S, pipeline, target, flowAction } = await harness();
  target.inputs = { old: { stage: 'source', question: 'answer', select: 'winner' } };
  target.dependsOn = ['source'];
  flowAction('flow-connect-input', { dataset: { id: 'target', source: 'source', question: 'second' } });
  assert.equal(target.inputs.old.select, 'winner');
  assert.ok(Object.values<any>(target.inputs).some(input => input.question === 'second'));
  assert.deepEqual([...target.dependsOn], ['source']);
  assert.equal(S.stageId, 'target');
  assert.equal(S.sections['flow-inspector'], 'connections');
  assert.equal(S.dirty, true);
  assert.equal(S.plan, null);
  const connected = JSON.stringify(pipeline);
  flowAction('flow-connect-input', { dataset: { id: 'target', source: 'source', question: 'second' } });
  assert.equal(JSON.stringify(pipeline), connected);
});

test('stale Connect here and cancellation never alter current study', async () => {
  const { S, pipeline, flowAction } = await harness();
  const before = JSON.stringify(pipeline), plan = S.plan;
  S.flowSource = { pipelineId: 'another-study', stage: 'source', question: 'answer' };
  flowAction('flow-connect', { dataset: { id: 'target' } });
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(S.dirty, false);
  assert.equal(S.plan, plan);
  flowAction('flow-cancel', { dataset: {} });
  assert.equal(S.flowSource, null);
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(S.plan, plan);
});

test('direct picker refuses cycle without mutation or losing reviewed plan', async () => {
  const { S, pipeline, target, downstream, flowAction } = await harness();
  downstream.dependsOn = ['target'];
  const before = JSON.stringify(pipeline), plan = S.plan;
  assert.throws(() => flowAction('flow-connect-input', { dataset: { id: target.id, source: downstream.id, question: 'answer' } }), /loop/);
  assert.equal(JSON.stringify(pipeline), before);
  assert.equal(S.dirty, false);
  assert.equal(S.plan, plan);
});
