import assert from 'node:assert/strict';
import test from 'node:test';
import type { Answer, ChooseStage, Cohort, Evaluation, EvaluationRequest, Json, Persona, Pipeline, PollInputBinding, PollStage, Provider, Question } from '../src/types.js';
import { runPipeline } from '../src/engine.js';
import { estimateBudgets, estimateRequestTokens, JEV_STATE_AND_QUESTION_LIMIT } from '../src/request-budget.js';
import { parsePipeline } from '../src/schema.js';
import { parseRun } from '../src/run-record.js';
import { emptyWorkspaceDocument, workspacePlan } from '../src/workspace-store.js';

function makeCohort(id: string, count: number): Cohort {
  const personas: Persona[] = Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, label: `${id} ${index}`, segment: index % 2 ? 's2' : 's1', age: 30 + (index % 20), background: 'Plays games.', attributes: { platform: index % 3 ? 'pc' : 'console' }, sourceIds: [], syntheticFields: [], weight: 1 }));
  return { version: 1, id, name: id, description: 'Test.', population: 'adults', createdAt: '2026-01-01T00:00:00Z', sources: [], assumptions: [], segments: [{ id: 's1', label: 'Casual', description: 'One.', weight: 1, weightBasis: 'assumed', sourceIds: [] }, { id: 's2', label: 'Core', description: 'Two.', weight: 1, weightBasis: 'assumed', sourceIds: [] }], personas };
}
const names: Question = { type: 'choice', label: 'Which name?', instructions: 'Pick one', criteria: { nova: 'Nova', ember: 'Ember', drift: 'Drift' } };
function answerFor(question: Question, bias: number): Answer {
  if (question.type === 'noul') return { type: 'noul', noul: 0.5 };
  if (question.type === 'score') return { type: 'score', score: 1, probabilities: { '0': 0.5, '1': 0.5 }, legend: { '0': question.criteria[0]!, '1': question.criteria[1]! }, confidence: 0.5 };
  const keys = Object.keys(question.criteria), winner = keys[bias % keys.length]!;
  const rest = 0.4 / (keys.length - 1);
  return { type: 'choice', choice: winner, probabilities: Object.fromEntries(keys.map((key) => [key, key === winner ? 0.6 : rest])), confidence: 0.6 };
}
function provider(log: EvaluationRequest[] = []): Provider {
  return {
    name: 'mock',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      log.push(request);
      return { model: request.model, usage: { inputTokens: 1, outputTokens: 1 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, answerFor(q, request.seed.length)])) };
    },
  };
}
/** Two audience steps, then a final choice that reads both. */
function study(select: PollInputBinding['select'] = 'responses'): Pipeline {
  const gamers: PollStage = { id: 'gamers', kind: 'poll', label: 'Gamers', cohort: 'gamers', dependsOn: [], questions: { pick: names } };
  const board: PollStage = { id: 'board', kind: 'poll', label: 'Exec board', cohort: 'board', dependsOn: [], questions: { pick: names } };
  const final: ChooseStage = { id: 'final', kind: 'choose', label: 'Final choice', dependsOn: ['gamers', 'board'], questions: { name: { ...names, label: 'Which name should we ship?' } }, inputs: { gamers: { stage: 'gamers', question: 'pick', select }, board: { stage: 'board', question: 'pick', select } } };
  return { version: 1, id: 'flow', name: 'Flow', description: 'A study.', context: { decisionQuestion: 'Name the game' }, cohorts: { gamers: 'gamers', board: 'board' }, stages: [gamers, board, final] };
}
const options = { model: 'jev', seed: 'seed', concurrency: 8 };
const finalRequests = (log: EvaluationRequest[]) => log.filter((request) => request.seed.includes(':final:'));
const workspace = (pipeline: Pipeline, cohorts: Cohort[]) => ({ ...emptyWorkspaceDocument(), cohorts, pipelines: [pipeline], projects: [{ id: 'proj', name: 'P', description: '', cohortIds: cohorts.map((c) => c.id), pipelineIds: [pipeline.id] }] });

test('a final choice validates, needs no audience, and answers once from every input', async () => {
  const pipeline = parsePipeline(study());
  const log: EvaluationRequest[] = [];
  const record = await runPipeline(pipeline, { gamers: makeCohort('gamers', 20), board: makeCohort('board', 4) }, { ...options, provider: provider(log) });
  const result = record.stages.final!;
  assert.equal(result.status, 'completed');
  assert.equal(result.votes.length, 1);
  assert.equal(result.summaries.name!.respondentCount, 1);
  assert.ok(['nova', 'ember', 'drift'].includes(result.summaries.name!.winner!));
  const requests = finalRequests(log);
  assert.equal(requests.length, 1);
  const state = requests[0]!.state as { persona?: Json; role: string; sources: Record<string, { step: string }>; inputs: Record<string, Json[]>; respondents: Record<string, Json> };
  assert.equal(state.persona, undefined);
  assert.match(state.role, /one final choice/);
  assert.deepEqual(Object.keys(state.inputs).sort(), ['board', 'gamers']);
  assert.equal(state.inputs.gamers!.length, 20);
  assert.equal(state.sources.board!.step, 'Exec board');
  assert.ok(state.respondents.gamers);
  assert.equal(result.batching, undefined);
  assert.deepEqual(parseRun(JSON.parse(JSON.stringify(record))).stages.final!.summaries, result.summaries);
});

test('inputs too large for one request are read in slices and combined automatically', async () => {
  const pipeline = study();
  const gamers = makeCohort('gamers', 1000), board = makeCohort('board', 8);
  const log: EvaluationRequest[] = [];
  const record = await runPipeline(pipeline, { gamers, board }, { ...options, provider: provider(log) });
  const result = record.stages.final!;
  assert.equal(result.status, 'completed');
  assert.equal(result.votes.length, 1);
  const requests = finalRequests(log);
  for (const request of requests) assert.ok(estimateRequestTokens(request.state as Json, request.questions).stateAndLongest <= JEV_STATE_AND_QUESTION_LIMIT * 0.85);
  const maps = requests.filter((request) => /:(gamers|board)\.b\d+$/.test(request.seed));
  const combines = requests.filter((request) => /:r\d+\.\d+$/.test(request.seed));
  assert.ok(maps.length > 2, `expected several slices, got ${maps.length}`);
  assert.ok(combines.length >= 1);
  const slices = maps.map((request) => (request.state as { inputs: Record<string, { responses?: Json[] }> }).inputs);
  assert.equal(slices.reduce((sum, inputs) => sum + Object.values(inputs).reduce((n, input) => n + (input?.responses?.length ?? 0), 0), 0), 1008);
  const last = combines.at(-1)!.state as { inputs: { combine: { batches: Array<{ input?: string }> } }; inputGuide: string };
  assert.match(last.inputGuide, /all of the earlier outputs together/);
  assert.ok(last.inputs.combine.batches.length >= 1);
  assert.equal(result.batching!.totalResponses, 1008);
  assert.match(result.batching!.note, /^Final choice read 1,000 responses from Gamers and 8 responses from Exec board in \d+ batches, then combined them in 1 round$/);

  const plan = workspacePlan(workspace(pipeline, [gamers, board]), 'flow');
  const step = plan.stages.find((item) => item.id === 'final')!;
  assert.equal(step.kind, 'choose');
  assert.equal(step.requests, requests.length);
  assert.equal(step.budget!.status, 'ok');
  assert.equal(step.budget!.choose!.mapRequests, maps.length);
  assert.equal(plan.maxRequests, record.usage.requests);
});

test('summaries fit one request, and the review says so', () => {
  const pipeline = study('summary');
  const budgets = estimateBudgets(pipeline, { gamers: makeCohort('gamers', 1000), board: makeCohort('board', 8) }, pipeline.stages);
  assert.equal(budgets.final!.choose!.requestsPerRun, 1);
  assert.equal(budgets.final!.choose!.line, 'Final choice reads all 2 inputs in one request');
});

test('a final choice with no inputs, or with a manual batch, is rejected', () => {
  const pipeline = study();
  const final = pipeline.stages[2] as ChooseStage;
  assert.throws(() => parsePipeline({ ...pipeline, stages: [pipeline.stages[0], pipeline.stages[1], { ...final, inputs: {} }] }), /at least one earlier output/);
  assert.throws(() => parsePipeline({ ...pipeline, stages: [pipeline.stages[0], pipeline.stages[1], { ...final, inputs: { gamers: { stage: 'gamers', question: 'pick', select: 'responses', batch: 'auto' } } }] }), /automatically/);
});

test('a later step can read a final choice', async () => {
  const pipeline = study('summary');
  pipeline.stages.push({ id: 'result', kind: 'decision', label: 'Result', dependsOn: ['final'], from: { stage: 'final', question: 'name' }, outputQuestion: 'result' });
  parsePipeline(pipeline);
  const record = await runPipeline(pipeline, { gamers: makeCohort('gamers', 6), board: makeCohort('board', 2) }, { ...options, provider: provider() });
  assert.equal(record.stages.result!.status, 'completed');
  assert.equal(record.stages.result!.summaries.result!.winner, record.stages.final!.summaries.name!.winner);
});

test('a finished final choice reports its pick, shares and reads for the run view', async () => {
  const { stageOutcome } = await import('../src/stage-outcome.js');
  const pipeline = parsePipeline(study());
  const record = await runPipeline(pipeline, { gamers: makeCohort('gamers', 20), board: makeCohort('board', 4) }, { ...options, provider: provider() });
  const outcome = stageOutcome(record.pipeline, record.stages.final)!;
  const summary = record.stages.final!.summaries.name!;
  assert.equal(outcome.answers.length, 1);
  assert.equal(outcome.answers[0]!.label, 'Which name should we ship?');
  assert.equal(outcome.answers[0]!.winner, names.type === 'choice' ? names.criteria[summary.winner!] : undefined);
  assert.deepEqual(outcome.answers[0]!.options.map((option) => option.share), Object.values(summary.probabilities!).sort((a, b) => b - a));
  assert.deepEqual(outcome.reads, ['Gamers · Which name? (every answer)', 'Exec board · Which name? (every answer)']);
  assert.equal(stageOutcome(record.pipeline, record.stages.gamers), undefined, 'audience steps keep their tile map');
});
