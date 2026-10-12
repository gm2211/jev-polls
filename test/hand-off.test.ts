import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cohort, Evaluation, EvaluationRequest, Persona, Pipeline, PollInputBinding, PollStage, Provider } from '../src/types.js';
import { runPipeline } from '../src/engine.js';
import { resolveHandOffs } from '../src/hand-off.js';
import { estimateBudgets } from '../src/request-budget.js';
import { emptyWorkspaceDocument, workspacePlan } from '../src/workspace-store.js';

function makeCohort(id: string, count: number): Cohort {
  const personas: Persona[] = Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, label: `${id} ${index}`, segment: 's1', age: 30, background: 'Plays games.', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 }));
  return { version: 1, id, name: id, description: 'Test.', population: 'adults', createdAt: '2026-01-01T00:00:00Z', sources: [], assumptions: [], segments: [{ id: 's1', label: 'S1', description: 'One.', weight: 1, weightBasis: 'assumed', sourceIds: [] }], personas };
}
const question = { type: 'choice' as const, label: 'Pick', instructions: 'Pick one', criteria: { x: 'X', y: 'Y' } };
function study(binding: PollInputBinding): Pipeline {
  const crowd: PollStage = { id: 'crowd', kind: 'poll', label: 'Gamers', cohort: 'crowd', dependsOn: [], questions: { pick: question } };
  const board: PollStage = { id: 'board', kind: 'poll', label: 'Board', cohort: 'board', dependsOn: ['crowd'], questions: { pick: question }, inputs: { gamers: binding } };
  return { version: 1, id: 'flow', name: 'Flow', description: 'A study.', context: {}, cohorts: { crowd: 'crowd', board: 'board' }, stages: [crowd, board] };
}
function provider(log: EvaluationRequest[]): Provider {
  return { name: 'mock', async evaluate(request): Promise<Evaluation> { log.push(request); return { model: request.model, usage: { inputTokens: 1, outputTokens: 1 }, answers: { pick: { type: 'choice', choice: 'x', probabilities: { x: 0.7, y: 0.3 }, confidence: 0.7 } } }; } };
}
const options = { model: 'jev', seed: 'seed', concurrency: 8 };
const each: PollInputBinding = { stage: 'crowd', question: 'pick', select: 'responses' };

test('every answer of a step too large for one request is split into batches automatically', async () => {
  const cohorts = { crowd: makeCohort('crowd', 3000), board: makeCohort('board', 8) };
  assert.equal(estimateBudgets(study(each), cohorts, study(each).stages).board!.status, 'blocked', 'without the hand-off the plan would block');
  const { pipeline, handOffs } = resolveHandOffs(study(each), cohorts);
  assert.deepEqual(handOffs, [{ stage: 'board', alias: 'gamers', from: 'crowd', answers: 3000, readers: 8 }]);
  assert.deepEqual((pipeline.stages[1] as PollStage).inputs!.gamers, { ...each, batch: 'auto' });
  assert.deepEqual(resolveHandOffs(pipeline, cohorts).handOffs, [], 'idempotent');
  const log: EvaluationRequest[] = [];
  const record = await runPipeline(study(each), cohorts, { ...options, provider: provider(log) });
  assert.equal(record.stages.board!.status, 'completed');
  assert.ok(record.stages.board!.batching!.batches > 1);
});

test('inputs that fit, summaries and explicit batches are left alone', () => {
  const big = { crowd: makeCohort('crowd', 3000), board: makeCohort('board', 8) };
  assert.deepEqual(resolveHandOffs(study({ ...each, batch: { size: 100 } }), big).handOffs, []);
  assert.deepEqual(resolveHandOffs(study({ ...each, select: 'summary' }), big).handOffs, []);
  assert.deepEqual(resolveHandOffs(study(each), { crowd: makeCohort('crowd', 40), board: makeCohort('board', 8) }).handOffs, []);
});

test('the plan prices and names the automatic split instead of blocking', () => {
  const doc = { ...emptyWorkspaceDocument(), cohorts: [makeCohort('crowd', 3000), makeCohort('board', 8)], pipelines: [study(each)], projects: [{ id: 'proj', name: 'P', description: '', cohortIds: ['crowd', 'board'], pipelineIds: ['flow'] }] };
  const plan = workspacePlan(doc, 'flow');
  const board = plan.stages.find((stage) => stage.id === 'board')!;
  assert.equal(board.handOffs?.[0]?.answers, 3000);
  assert.ok(board.batching && board.requests === 8 * board.batching.requestsPerRun);
  assert.ok(board.usage!.inputTokens > 0);
});
