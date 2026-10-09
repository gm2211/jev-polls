import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cohort, Evaluation, EvaluationRequest, Persona, Pipeline, PollInputBinding, PollStage, Provider } from '../src/types.js';
import { runPipeline } from '../src/engine.js';
import { estimateRequestTokens, estimateVoteRecordTokens, enforceBudgets, estimateBudgets, estimateTokens, JEV_STATE_AND_QUESTION_LIMIT } from '../src/request-budget.js';
import { emptyWorkspaceDocument, workspacePlan } from '../src/workspace-store.js';

function persona(id: string, background = 'Lives in a small town.'): Persona {
  return { id, label: `Person ${id}`, segment: 's1', age: 40, background, attributes: { city: 'Springfield' }, sourceIds: [], syntheticFields: [], weight: 1 };
}
function cohort(count: number, background?: string): Cohort {
  return {
    version: 1, id: 'crowd', name: 'Crowd', description: 'A crowd.', population: 'adults', createdAt: '2026-01-01T00:00:00Z', sources: [], assumptions: [],
    segments: [{ id: 's1', label: 'S1', description: 'First segment.', weight: 1, weightBasis: 'assumed', sourceIds: [] }],
    personas: Array.from({ length: count }, (_, index) => persona(`p${index}`, background)),
  };
}
const question = { type: 'choice' as const, label: 'Pick', instructions: 'Pick one', criteria: { a: 'A', b: 'B' } };
function study(inputs?: Record<string, PollInputBinding>, cohortAlias = 'crowd'): Pipeline {
  const first: PollStage = { id: 'first', kind: 'poll', label: 'First look', cohort: cohortAlias, dependsOn: [], questions: { pick: question } };
  const second: PollStage = { id: 'second', kind: 'poll', label: 'Second look', cohort: cohortAlias, dependsOn: ['first'], questions: { pick: question }, ...(inputs ? { inputs } : {}) };
  return { version: 1, id: 'flow', name: 'Flow', description: 'A study.', context: {}, cohorts: { crowd: 'crowd' }, stages: [first, second] };
}
const budgets = (pipeline: Pipeline, c: Cohort) => estimateBudgets(pipeline, { crowd: c }, pipeline.stages);

test('a small study fits and reports a modest size', () => {
  const result = budgets(study({ earlier: { stage: 'first', question: 'pick', select: 'summary' } }), cohort(10));
  assert.equal(result.first!.status, 'ok');
  assert.equal(result.second!.status, 'ok');
  assert.ok(result.second!.largestRequestTokens > 0 && result.second!.largestRequestTokens < 2000);
  assert.deepEqual(enforceBudgets(result), []);
});

test('token estimate is bytes divided by three, rounded up', () => {
  assert.equal(estimateTokens('abcd'), 2);
  assert.equal(estimateTokens('é'), 1);
});

test('a huge persona background fails and names the step', () => {
  const result = budgets(study(), cohort(5, 'long story. '.repeat(8_200)));
  assert.equal(result.first!.status, 'blocked');
  assert.throws(() => enforceBudgets(result), (error: Error) => {
    assert.match(error.message, /Step "First look" is too large for Jev/);
    assert.match(error.message, /Jev allows 32,000/);
    assert.match(error.message, /profile of Person p0/);
    return true;
  });
});

test('every individual response from a 1000-person step fails and suggests the summary', () => {
  const pipeline = study({ earlier: { stage: 'first', question: 'pick', select: 'responses' } });
  const result = budgets(pipeline, cohort(1000));
  assert.equal(result.first!.status, 'ok');
  assert.equal(result.second!.status, 'blocked');
  assert.ok(result.second!.largestRequestTokens > JEV_STATE_AND_QUESTION_LIMIT);
  assert.throws(() => enforceBudgets(result), (error: Error) => {
    assert.match(error.message, /Step "Second look"/);
    assert.match(error.message, /input "earlier"/);
    assert.match(error.message, /Switch the input "earlier" to its summary/);
    return true;
  });
});

test('the summary of the same 1000-person step fits', () => {
  const result = budgets(study({ earlier: { stage: 'first', question: 'pick', select: 'summary' } }), cohort(1000));
  assert.equal(result.second!.status, 'ok');
  assert.ok(result.second!.largestRequestTokens < 5000);
});

test('legacy upstream summaries are estimated too', () => {
  const result = budgets(study(), cohort(1000));
  assert.equal(result.second!.status, 'ok');
  assert.ok(result.second!.largestRequestTokens > result.first!.largestRequestTokens);
});

test('close to the limit warns without blocking', () => {
  // Calibrate a background that lands between 80% and 100% of the limit.
  const base = budgets(study(), cohort(1, '')).first!.largestRequestTokens;
  const background = 'x'.repeat((Math.floor(JEV_STATE_AND_QUESTION_LIMIT * 0.9) - base) * 3);
  const result = budgets(study(), cohort(1, background));
  assert.equal(result.first!.status, 'warning');
  const warnings = enforceBudgets(result);
  assert.ok(warnings.some((warning) => /Step "First look" is close to Jev's limit/.test(warning)));
});

test('workspace plan carries per-step estimates and rejects over-limit steps', () => {
  const small = cohort(3);
  const doc = { ...emptyWorkspaceDocument(), cohorts: [small], pipelines: [study()], projects: [{ id: 'proj', name: 'P', description: '', cohortIds: ['crowd'], pipelineIds: ['flow'] }] };
  const plan = workspacePlan(doc, 'flow');
  assert.equal(plan.stages[0]!.budget?.status, 'ok');
  const huge = { ...doc, cohorts: [cohort(2, 'long story. '.repeat(8_200))] };
  assert.throws(() => workspacePlan(huge, 'flow'), /Step "First look" is too large for Jev/);
  assert.doesNotThrow(() => workspacePlan(huge, 'flow', 'gliner'));
});

test('the engine refuses to send an over-limit request and fails that respondent', async () => {
  const sent: EvaluationRequest[] = [];
  const provider: Provider = {
    name: 'mock',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> { sent.push(request); throw new Error('must not be called'); },
  };
  const record = await runPipeline({ ...study(), stages: [study().stages[0]!] }, { crowd: cohort(2, 'long story. '.repeat(8_200)) }, { provider, model: 'jev', seed: 's', concurrency: 1 });
  assert.equal(sent.length, 0);
  assert.equal(record.stages.first!.status, 'failed');
  assert.match(record.stages.first!.reason!, /request too large for Jev/);
});

test('reusable estimators are exported', () => {
  assert.ok(estimateVoteRecordTokens(question) > 20);
  const size = estimateRequestTokens({ a: 'x'.repeat(300) }, { pick: question });
  assert.equal(size.total, size.stateTokens + size.allQuestionsTokens);
});
