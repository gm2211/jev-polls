import assert from 'node:assert/strict';
import test from 'node:test';
import type { Answer, Cohort, Evaluation, EvaluationRequest, Json, Persona, Pipeline, PollInputBinding, PollStage, Provider, Question, Vote } from '../src/types.js';
import { runPipeline } from '../src/engine.js';
import { estimateBudgets } from '../src/request-budget.js';
import { respondentLookup, respondentsSummary } from '../src/respondents.js';

const platforms = ['PC', 'Console', 'Mobile'];
function makeCohort(id: string, count: number, background = 'Plays games after work.'): Cohort {
  const personas: Persona[] = Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index}`, label: `${id} ${index}`, segment: index % 4 === 0 ? 'casual' : 'core', age: 20 + index % 30, background,
    attributes: { platform: platforms[index % 3]!, weeklyHours: 2 + index % 20, genres: index % 2 ? ['strategy', 'puzzle'] : ['shooter'], nested: { a: 1 } },
    sourceIds: [], syntheticFields: ['attributes'], weight: 1,
  }));
  return {
    version: 1, id, name: `${id} players`, description: 'Test.', population: 'adult players', createdAt: '2026-01-01T00:00:00Z', sources: [], assumptions: [],
    segments: [{ id: 'core', label: 'Core players', description: 'Core.', weight: 3, weightBasis: 'assumed', sourceIds: [] }, { id: 'casual', label: 'Casual players', description: 'Casual.', weight: 1, weightBasis: 'assumed', sourceIds: [] }],
    personas,
  };
}
const pick: Question = { type: 'choice', label: 'Pick a name', instructions: 'Pick one', criteria: { a: 'Alpha', b: 'Beta', c: 'Gamma' } };
function answerFor(question: Question, personaId: string): Answer {
  if (question.type !== 'choice') return { type: 'noul', noul: 0.5 };
  // PC players lean to "a", everyone else to "b", so the split by platform is visible.
  const index = Number(personaId.split('-').at(-1));
  const winner = index % 3 === 0 ? 'a' : 'b';
  return { type: 'choice', choice: winner, probabilities: { a: winner === 'a' ? 0.7 : 0.2, b: winner === 'b' ? 0.7 : 0.2, c: 0.1 }, confidence: 0.7 };
}
function provider(log: EvaluationRequest[]): Provider {
  return {
    name: 'mock',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      log.push(request);
      const personaId = ((request.state as { persona: { id: string } }).persona).id;
      return { model: request.model, usage: { inputTokens: 1, outputTokens: 1 }, answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, answerFor(q, personaId)])) };
    },
  };
}
function study(binding?: PollInputBinding): Pipeline {
  const first: PollStage = { id: 'crowd', kind: 'poll', label: 'Gamers', cohort: 'crowd', dependsOn: [], questions: { pick } };
  const second: PollStage = { id: 'board', kind: 'poll', label: 'Board', cohort: 'board', dependsOn: ['crowd'], questions: { pick }, ...(binding ? { inputs: { gamers: binding } } : {}) };
  return { version: 1, id: 'flow', name: 'Flow', description: 'A study.', context: {}, cohorts: { crowd: 'crowd', board: 'board' }, stages: [first, second] };
}
const options = { model: 'jev', seed: 'seed', concurrency: 4 };
const boardRequests = (log: EvaluationRequest[]) => log.filter((request) => request.seed.includes(':board:'));

test('each individual response carries who gave it when it fits', async () => {
  const log: EvaluationRequest[] = [];
  const pipeline = study({ stage: 'crowd', question: 'pick', select: 'responses' });
  const cohorts = { crowd: makeCohort('crowd', 12), board: makeCohort('board', 2) };
  assert.deepEqual(estimateBudgets(pipeline, cohorts, pipeline.stages).board!.respondents, { gamers: 'profiles' });
  const record = await runPipeline(pipeline, cohorts, { ...options, provider: provider(log) });
  assert.equal(record.stages.board!.status, 'completed');
  const state = boardRequests(log)[0]!.state as { inputs: { gamers: Array<{ personaId: string; respondent: { label: string; segment: string; age: number; attributes: Record<string, Json> } }> }; respondents: { gamers: { profiles: string; people: number } } };
  assert.equal(state.inputs.gamers.length, 12);
  const first = state.inputs.gamers.find((entry) => entry.personaId === 'crowd-0')!;
  assert.deepEqual(first.respondent, { label: 'crowd 0', age: 20, segment: 'Casual players', background: 'Plays games after work.', attributes: { platform: 'PC', weeklyHours: 2, genres: ['shooter'], nested: { a: 1 } } });
  assert.equal(state.respondents.gamers.profiles, 'with each response');
  assert.equal(state.respondents.gamers.people, 12);
});

test('when profiles would not fit, responses go plain and a summary of who answered remains', async () => {
  const log: EvaluationRequest[] = [];
  const pipeline = study({ stage: 'crowd', question: 'pick', select: 'responses' });
  // ~140 tokens of background each: 300 plain responses fit, 300 profiles do not.
  const cohorts = { crowd: makeCohort('crowd', 300, 'Plays games after work. '.repeat(18)), board: makeCohort('board', 2) };
  assert.deepEqual(estimateBudgets(pipeline, cohorts, pipeline.stages).board!.respondents, { gamers: 'summary' });
  const record = await runPipeline(pipeline, cohorts, { ...options, provider: provider(log) });
  assert.equal(record.stages.board!.status, 'completed');
  const state = boardRequests(log)[0]!.state as { inputs: { gamers: Array<Record<string, Json>> }; respondents: { gamers: { profiles: string; people: number; distributions: Record<string, Json> } } };
  assert.equal(state.inputs.gamers.length, 300);
  assert.ok(state.inputs.gamers.every((entry) => entry.respondent === undefined));
  assert.equal(state.respondents.gamers.profiles, 'left out to fit the request limit');
  assert.equal(state.respondents.gamers.people, 300);
  assert.ok(state.respondents.gamers.distributions.platform);
});

test('summary inputs and steps without named inputs carry a summary of who answered', async () => {
  for (const pipeline of [study({ stage: 'crowd', question: 'pick', select: 'winner' }), study()]) {
    const log: EvaluationRequest[] = [];
    const cohorts = { crowd: makeCohort('crowd', 12), board: makeCohort('board', 2) };
    const budget = estimateBudgets(pipeline, cohorts, pipeline.stages).board!;
    const record = await runPipeline(pipeline, cohorts, { ...options, provider: provider(log) });
    assert.equal(record.stages.board!.status, 'completed');
    const state = boardRequests(log)[0]!.state as { inputs?: { gamers: Json }; respondents?: { gamers: Record<string, Json> }; upstream?: Array<{ respondents: Record<string, Json> }> };
    if (state.inputs) {
      assert.equal(state.inputs.gamers, 'b');
      assert.equal(state.respondents!.gamers.profiles, undefined);
      assert.equal(state.respondents!.gamers.people, 12);
      assert.deepEqual(budget.respondents, { gamers: 'summary' });
    } else {
      assert.equal(state.upstream![0]!.respondents.people, 12);
      assert.deepEqual(budget.respondents, { crowd: 'summary' });
    }
  }
});

test('the summary weights shares, folds rare values, splits numbers at the median, and shows how answers split', () => {
  const cohort = makeCohort('crowd', 12);
  const votes: Vote[] = cohort.personas.map((persona) => ({ personaId: persona.id, cohortId: cohort.id, segment: persona.segment, repeat: 1, weight: persona.segment === 'core' ? 3 / 9 / 1 : 1 / 3 / 1, answers: { pick: answerFor(pick, persona.id) }, cacheHit: false, model: 'jev' }));
  const summary = respondentsSummary(votes, ['pick'], respondentLookup([cohort])) as Record<string, any>;
  assert.equal(summary.people, 12);
  assert.match(summary.note, /Synthetic personas/);
  assert.deepEqual(summary.cohorts, [{ id: 'crowd', name: 'crowd players', population: 'adult players' }]);
  // 9 core personas at 1/9 of 0.75 each, 3 casual at 1/3 of 0.25 each, as the engine weights them.
  const total = 9 * (1 / 3) + 3 * (1 / 3);
  assert.equal(summary.distributions.segment['Core players'], Math.round(9 * (1 / 3) / total * 1000) / 1000);
  assert.deepEqual(Object.keys(summary.distributions.platform).sort(), ['Console', 'Mobile', 'PC']);
  assert.deepEqual(summary.distributions.weeklyHours, { min: 2, max: 13, mean: 7.5 });
  assert.ok(summary.distributions.genres.strategy > 0);
  assert.equal(summary.distributions.nested, undefined);
  assert.equal(summary.omittedAttributes, 1);
  assert.deepEqual(summary.answersBy.pick.platform.PC, { people: 4, answer: { a: 0.7, b: 0.2, c: 0.1 } });
  assert.deepEqual(summary.answersBy.pick.platform.Console, { people: 4, answer: { b: 0.7, a: 0.2, c: 0.1 } });
  assert.deepEqual(Object.keys(summary.answersBy.pick.age).sort(), ['25.5 or more', 'under 25.5']);
});

test('respondents beyond the six most common values of an attribute are grouped as other', () => {
  const cohort = makeCohort('crowd', 10);
  cohort.personas.forEach((persona, index) => { persona.attributes = { city: `City ${index}` }; });
  const votes: Vote[] = cohort.personas.map((persona) => ({ personaId: persona.id, cohortId: cohort.id, segment: persona.segment, repeat: 1, weight: 0.1, answers: { pick: answerFor(pick, persona.id) }, cacheHit: false, model: 'jev' }));
  const summary = respondentsSummary(votes, ['pick'], respondentLookup([cohort])) as Record<string, any>;
  assert.equal(Object.keys(summary.distributions.city).length, 7);
  assert.equal(summary.distributions.city.other, 0.4);
  assert.equal(summary.answersBy.pick.city.other.people, 4);
});
