import assert from 'node:assert/strict';
import test from 'node:test';
import type { Answer, Cohort, Evaluation, EvaluationRequest, Json, Persona, Pipeline, PollInputBinding, PollStage, Provider, Question } from '../src/types.js';
import { runPipeline } from '../src/engine.js';
import { chunk, compactAnswer } from '../src/batching.js';
import { estimateBudgets, enforceBudgets, estimateRequestTokens, JEV_STATE_AND_QUESTION_LIMIT } from '../src/request-budget.js';
import { parsePipeline } from '../src/schema.js';
import { emptyWorkspaceDocument, workspacePlan } from '../src/workspace-store.js';

function makeCohort(id: string, count: number): Cohort {
  const personas: Persona[] = Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, label: `${id} ${index}`, segment: 's1', age: 30, background: 'Plays games.', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 }));
  return { version: 1, id, name: id, description: 'Test.', population: 'adults', createdAt: '2026-01-01T00:00:00Z', sources: [], assumptions: [], segments: [{ id: 's1', label: 'S1', description: 'One.', weight: 1, weightBasis: 'assumed', sourceIds: [] }], personas };
}
const optionCount = (n: number): Question => ({ type: 'choice', label: 'Pick', instructions: 'Pick one', criteria: Object.fromEntries(Array.from({ length: n }, (_, i) => [`o${i}`, `Option ${i}`])) });
function answerFor(question: Question, bias: number): Answer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (question.type === 'score') return { type: 'score', score: 1, probabilities: { '0': 0.5, '1': 0.5 }, legend: { '0': question.criteria[0]!, '1': question.criteria[1]! } };
  const keys = Object.keys(question.criteria), winner = keys[bias % keys.length]!;
  const rest = 0.4 / (keys.length - 1);
  return { type: 'choice', choice: winner, probabilities: Object.fromEntries(keys.map((key) => [key, key === winner ? 0.6 : rest])), confidence: 0.6 };
}
function provider(log: EvaluationRequest[] = []): Provider {
  return {
    name: 'mock',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      log.push(request);
      const bias = request.seed.length;
      return { model: request.model, usage: { inputTokens: 1, outputTokens: 1 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, answerFor(q, bias)])) };
    },
  };
}
function study(question: Question, binding: PollInputBinding | PollInputBinding[], extra: Partial<PollStage> = {}): Pipeline {
  const bindings = Array.isArray(binding) ? binding : [binding];
  const first: PollStage = { id: 'crowd', kind: 'poll', label: 'Gamers', cohort: 'crowd', dependsOn: [], questions: { pick: question, other: question } };
  const second: PollStage = { id: 'board', kind: 'poll', label: 'Board', cohort: 'board', dependsOn: ['crowd'], questions: { pick: question }, inputs: Object.fromEntries(bindings.map((item, index) => [`gamers${index + 1}`, item])), ...extra };
  return { version: 1, id: 'flow', name: 'Flow', description: 'A study.', context: {}, cohorts: { crowd: 'crowd', board: 'board' }, stages: [first, second] };
}
const responses = (size?: number): PollInputBinding => ({ stage: 'crowd', question: 'pick', select: 'responses', batch: size ? { size } : 'auto' });
const options = { model: 'jev', seed: 'seed', concurrency: 8 };
const boardRequests = (log: EvaluationRequest[]) => log.filter((request) => request.seed.includes(':board:'));

test('chunking is deterministic and keeps order', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.deepEqual(compactAnswer({ type: 'choice', choice: 'a', probabilities: { a: 0.123456, b: 0.876544 } }), { choice: 'a', probabilities: { a: 0.123, b: 0.877 } });
});

test('1000 responses read by 8 board members in batches of 100 take 10 map and 1 combine request each', async () => {
  const log: EvaluationRequest[] = [];
  const pipeline = study(optionCount(2), responses(100));
  const cohorts = { crowd: makeCohort('crowd', 1000), board: makeCohort('board', 8) };
  const record = await runPipeline(pipeline, cohorts, { ...options, provider: provider(log) });
  assert.equal(record.stages.board!.status, 'completed');
  const board = boardRequests(log);
  assert.equal(board.length, 8 * 11);
  const mapRequests = board.filter((request) => (request.state as { inputs: Record<string, { batch?: number }> }).inputs.gamers1!.batch !== undefined);
  assert.equal(mapRequests.length, 80);
  for (const request of mapRequests) {
    const input = (request.state as { inputs: { gamers1: { batches: number; totalResponses: number; responses: unknown[] } }; inputGuide: string }).inputs.gamers1;
    assert.equal(input.batches, 10); assert.equal(input.totalResponses, 1000); assert.equal(input.responses.length, 100);
    assert.match((request.state as { inputGuide: string }).inputGuide, /slice/);
  }
  const combine = board.filter((request) => (request.state as { inputs: Record<string, { combine?: boolean }> }).inputs.gamers1!.combine);
  assert.equal(combine.length, 8);
  const verdicts = (combine[0]!.state as { inputs: { gamers1: { batches: Array<{ batch: number; responses: number; answers: { pick: { probabilities: Record<string, number> } } }> } } }).inputs.gamers1.batches;
  assert.equal(verdicts.length, 10);
  assert.equal(verdicts[0]!.responses, 100);
  assert.ok(Object.values(verdicts[0]!.answers.pick.probabilities).every((value) => Math.round(value * 1000) / 1000 === value));
  const result = record.stages.board!;
  assert.equal(result.votes.length, 8);
  assert.equal(result.layers!.length, 1);
  assert.equal(result.layers![0]!.kind, 'map');
  assert.equal(result.layers![0]!.votes.length, 80);
  assert.equal(result.batching!.batches, 10);
  assert.match(result.batching!.note, /Board read 1,000 responses from Gamers in 10 batches of 100, then combined them in 1 round/);
  assert.equal(record.usage.requests, 1000 + 88);
});

test('the plan counts the same requests the engine makes', async () => {
  const log: EvaluationRequest[] = [];
  const pipeline = study(optionCount(2), responses(100));
  const crowd = makeCohort('crowd', 1000), board = makeCohort('board', 8);
  const doc = { ...emptyWorkspaceDocument(), cohorts: [crowd, board], pipelines: [{ ...pipeline, cohorts: { crowd: 'crowd', board: 'board' } }], projects: [{ id: 'proj', name: 'P', description: '', cohortIds: ['crowd', 'board'], pipelineIds: ['flow'] }] };
  const plan = workspacePlan(doc, 'flow');
  const record = await runPipeline(pipeline, { crowd, board }, { ...options, provider: provider(log) });
  assert.equal(plan.maxRequests, record.usage.requests);
  const stage = plan.stages.find((item) => item.id === 'board')!;
  assert.equal(stage.requests, 88);
  assert.equal(stage.batching!.batches, 10);
  assert.equal(stage.batching!.reduceRounds, 1);
  assert.equal(stage.budget!.status, 'ok');
  assert.equal(stage.budget!.batching!.line, 'Board reads 1,000 responses from Gamers in 10 batches of 100, then combines them in 1 round');
});

test('a step that failed the limit passes once its input is batched', () => {
  const crowd = makeCohort('crowd', 1000), board = makeCohort('board', 8);
  const plain = study(optionCount(2), { stage: 'crowd', question: 'pick', select: 'responses' });
  const unbatched = estimateBudgets(plain, { crowd, board }, plain.stages);
  assert.equal(unbatched.board!.status, 'blocked');
  const split = study(optionCount(2), responses());
  const batched = estimateBudgets(split, { crowd, board }, split.stages);
  assert.equal(batched.board!.status, 'ok');
  assert.deepEqual(enforceBudgets(batched), []);
  assert.ok(batched.board!.largestRequestTokens <= JEV_STATE_AND_QUESTION_LIMIT * 0.85 + 1);
});

test('auto picks the largest batch size under the limit and every request respects it', async () => {
  const log: EvaluationRequest[] = [];
  const pipeline = study(optionCount(2), responses());
  const crowd = makeCohort('crowd', 1000), board = makeCohort('board', 8);
  const plan = estimateBudgets(pipeline, { crowd, board }, pipeline.stages).board!.batching!;
  assert.ok(plan.batches > 1);
  assert.ok(plan.batchSize > 10);
  const record = await runPipeline(pipeline, { crowd, board }, { ...options, provider: provider(log) });
  assert.equal(record.stages.board!.status, 'completed');
  assert.equal(record.stages.board!.batching!.batchSize, plan.batchSize);
  const board_ = boardRequests(log);
  assert.equal(board_.length, 8 * plan.requestsPerRun);
  for (const request of board_) assert.ok(estimateRequestTokens(request.state as Json, request.questions).stateAndLongest <= JEV_STATE_AND_QUESTION_LIMIT * 0.85);
  // one more response per batch would not fit
  assert.ok(plan.mapLargest + 60 > JEV_STATE_AND_QUESTION_LIMIT * 0.85 - 1);
});

test('verdicts that do not fit one request are combined in more layers', async () => {
  const log: EvaluationRequest[] = [];
  const pipeline = study(optionCount(120), responses(5));
  const crowd = makeCohort('crowd', 1000), board = makeCohort('board', 8);
  const plan = estimateBudgets(pipeline, { crowd, board }, pipeline.stages).board!.batching!;
  assert.equal(plan.batches, 200);
  assert.ok(plan.reduceRounds >= 2);
  const record = await runPipeline(pipeline, { crowd, board }, { ...options, provider: provider(log) });
  const result = record.stages.board!;
  assert.equal(result.status, 'completed');
  assert.equal(boardRequests(log).length, 8 * plan.requestsPerRun);
  assert.equal(result.layers!.length, plan.reduceRounds);
  assert.equal(result.layers![0]!.kind, 'map');
  assert.equal(result.layers![1]!.kind, 'reduce');
  // final summaries come from the last layer: one vote per persona, none of them tagged as intermediate
  assert.equal(result.votes.length, 8);
  assert.ok(result.votes.every((vote) => vote.batch === undefined));
  assert.equal(result.summaries.pick!.respondentCount, 8);
  for (const request of boardRequests(log)) assert.ok(estimateRequestTokens(request.state as Json, request.questions).stateAndLongest <= JEV_STATE_AND_QUESTION_LIMIT);
});

test('a single batch behaves like one ordinary request', async () => {
  const log: EvaluationRequest[] = [];
  const record = await runPipeline(study(optionCount(2), responses(5000)), { crowd: makeCohort('crowd', 20), board: makeCohort('board', 3) }, { ...options, provider: provider(log) });
  assert.equal(boardRequests(log).length, 3);
  assert.equal(record.stages.board!.layers, undefined);
  assert.equal(record.stages.board!.batching!.batches, 1);
});

test('caching keys on the batch content', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'jev-batch-'));
  try {
    const cohorts = { crowd: makeCohort('crowd', 12), board: makeCohort('board', 2) };
    const first = await runPipeline(study(optionCount(2), responses(4)), cohorts, { ...options, provider: provider(), cacheDir: dir });
    const again = await runPipeline(study(optionCount(2), responses(4)), cohorts, { ...options, provider: provider(), cacheDir: dir });
    assert.equal(again.usage.requests, 0);
    assert.equal(again.usage.cacheHits, first.usage.requests);
    const changed = await runPipeline(study(optionCount(2), responses(6)), cohorts, { ...options, provider: provider(), cacheDir: dir });
    assert.ok(changed.usage.requests > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('validation rejects two batched inputs and a batch on any other selector', () => {
  const base = study(optionCount(2), [responses(10), { ...responses(10), question: 'other' }]);
  assert.throws(() => parsePipeline(base), /only one input can be split into batches/);
  const summary = study(optionCount(2), { stage: 'crowd', question: 'pick', select: 'summary', batch: 'auto' });
  assert.throws(() => parsePipeline(summary), /only when it reads individual responses/);
  assert.doesNotThrow(() => parsePipeline(study(optionCount(2), responses())));
  assert.throws(() => parsePipeline(study(optionCount(2), { ...responses(), batch: { size: 0 } })));
});

test('the engine rejects the same invalid shapes', async () => {
  const cohorts = { crowd: makeCohort('crowd', 4), board: makeCohort('board', 1) };
  await assert.rejects(runPipeline(study(optionCount(2), [responses(10), { ...responses(10), question: 'other' }]), cohorts, { ...options, provider: provider() }), /only one input into batches/);
  await assert.rejects(runPipeline(study(optionCount(2), { stage: 'crowd', question: 'pick', select: 'mean', batch: 'auto' } as PollInputBinding), cohorts, { ...options, provider: provider() }), /incompatible|only when/);
});
