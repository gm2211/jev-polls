import assert from 'node:assert/strict';
import test from 'node:test';
import { runPipeline } from '../src/engine.js';
import { parseRun } from '../src/run-record.js';
import { parsePipeline } from '../src/schema.js';
import { resolveOptionsFrom } from '../src/engine-utils.js';
import type { Cohort, Evaluation, EvaluationRequest, Pipeline, Provider } from '../src/types.js';

const cohort: Cohort = {
  version: 1, id: 'audience', name: 'Audience', description: 'People', population: 'test people', createdAt: '2026-01-01T00:00:00Z',
  sources: [], assumptions: [],
  segments: [{ id: 's1', label: 'S1', description: 'Everyone', weight: 1, weightBasis: 'assumed', sourceIds: [] }],
  personas: ['p1', 'p2', 'p3'].map((id) => ({ id, label: id, segment: 's1', age: 30, background: 'A tester', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 })),
};

/** Everyone leans the same way: Beta, then Gamma, Delta, Alpha. Shares are renormalized over the options asked. */
const lean: Record<string, number> = { a: 0.1, b: 0.4, c: 0.3, d: 0.2 };
function leaningProvider(log: EvaluationRequest[]): Provider {
  return {
    name: 'mock',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      log.push(request);
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        const keys = question.type === 'choice' ? Object.keys(question.criteria) : [];
        const total = keys.reduce((sum, key) => sum + (lean[key] ?? 0.05), 0);
        const probabilities = Object.fromEntries(keys.map((key) => [key, (lean[key] ?? 0.05) / total]));
        const choice = keys.reduce((best, key) => probabilities[key]! > probabilities[best]! ? key : best, keys[0]!);
        return [id, { type: 'choice' as const, choice, probabilities, confidence: 0.7 }];
      }));
      return { model: request.model, usage: { inputTokens: 10, outputTokens: 2 }, answers };
    },
  };
}

const names = { a: 'Alpha', b: { label: 'Beta', description: 'The second letter' }, c: 'Gamma', d: 'Delta' };
function funnel(top?: number, extra: Pipeline['stages'] = []): Pipeline {
  return {
    version: 1, id: 'funnel', name: 'Funnel', description: 'Funnel', context: {}, cohorts: { audience: 'audience.json' },
    stages: [
      { id: 'rank', kind: 'poll', label: 'Rank', cohort: 'audience', dependsOn: [], questions: { pick: { type: 'choice', label: 'Best name?', instructions: 'Pick one.', criteria: names } } },
      { id: 'board', kind: 'poll', label: 'Board', cohort: 'audience', dependsOn: ['rank'], inputs: {}, questions: { pick: { type: 'choice', label: 'Launch which?', instructions: 'Pick one.', criteria: names, optionsFrom: { stage: 'rank', question: 'pick', ...(top ? { top } : {}) } } } },
      ...extra,
    ],
  };
}
const run = (flow: Pipeline, log: EvaluationRequest[] = []) => runPipeline(flow, { audience: cohort }, { provider: leaningProvider(log), model: 'm', seed: 'seed', concurrency: 2 });

test('a step asks only the top options of the earlier step it takes them from', async () => {
  const log: EvaluationRequest[] = [];
  const record = await run(parsePipeline(funnel(2)), log);
  const board = record.stages.board!;
  assert.equal(board.status, 'completed');
  assert.deepEqual(Object.keys(board.summaries.pick!.probabilities!).sort(), ['b', 'c']);
  const asked = log.filter((request) => Object.keys((request.questions.pick as { criteria: object }).criteria).length === 2);
  assert.equal(asked.length, 3);
  // The request carries the source's labels and descriptions and no trace of where they came from.
  assert.deepEqual((asked[0]!.questions.pick as { criteria: object }).criteria, { b: names.b, c: 'Gamma' });
  assert.equal('optionsFrom' in asked[0]!.questions.pick!, false);
});

test('without a limit the step asks every option the earlier step ranked', async () => {
  const record = await run(parsePipeline(funnel()));
  assert.deepEqual(Object.keys(record.stages.board!.summaries.pick!.probabilities!).sort(), ['a', 'b', 'c', 'd']);
});

test('a saved run with taken options, and a decision on it, loads back', async () => {
  const flow = parsePipeline(funnel(3, [{ id: 'final', kind: 'decision', label: 'Final', dependsOn: ['board'], from: { stage: 'board', question: 'pick' }, outputQuestion: 'winner' }]));
  const record = await run(flow);
  assert.equal(record.stages.final!.status, 'completed');
  const loaded = parseRun(JSON.parse(JSON.stringify(record)));
  assert.deepEqual(Object.keys(loaded.stages.board!.summaries.pick!.probabilities!).sort(), ['b', 'c', 'd']);
});

test('the step fails, not guesses, when the earlier step has no result', () => {
  const flow = parsePipeline(funnel(2));
  const board = flow.stages[1] as Extract<Pipeline['stages'][number], { kind: 'poll' }>;
  assert.throws(() => resolveOptionsFrom(flow, board, {}), /has no completed option shares/);
});

test('the source must be a declared dependency and a choice question', () => {
  const loose = funnel(2);
  (loose.stages[1] as { dependsOn: string[] }).dependsOn = [];
  assert.throws(() => parsePipeline(loose), /options source rank must be in dependsOn/);
  const tooFew = funnel(2);
  ((tooFew.stages[1] as { questions: { pick: { optionsFrom: { top: number } } } }).questions.pick.optionsFrom.top) = 1;
  assert.throws(() => parsePipeline(tooFew));
  const scored = funnel(2);
  (scored.stages[0] as { questions: object }).questions = { pick: { type: 'noul', label: 'Yes?', instructions: 'Answer.' } };
  assert.throws(() => parsePipeline(scored), /options can come only from a choice question/);
});
