import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChoiceQuestion, RunRecord, Vote } from '../src/types.js';
import { compareRuns, simulateVotes, summarizeVotes } from '../src/analysis.js';
import { runPipeline } from '../src/engine.js';
import type { Provider } from '../src/types.js';

const question: ChoiceQuestion = { type: 'choice', label: 'Pick', instructions: 'Pick', criteria: { x: 'X', y: 'Y' } };

test('weighted summaries retain segment and repeat breakdowns without multiplying sample size', () => {
  const votes: Vote[] = [
    { personaId: 'p1', segment: 'urban', repeat: 1, weight: 0.2, answers: { q: { type: 'choice', choice: 'x', probabilities: { x: 1, y: 0 }, confidence: 1 } }, cacheHit: false, model: 'm' },
    { personaId: 'p1', segment: 'urban', repeat: 2, weight: 0.2, answers: { q: { type: 'choice', choice: 'x', probabilities: { x: 1, y: 0 }, confidence: 1 } }, cacheHit: false, model: 'm' },
    { personaId: 'p2', segment: 'rural', repeat: 1, weight: 0.3, answers: { q: { type: 'choice', choice: 'y', probabilities: { x: 0, y: 1 }, confidence: 1 } }, cacheHit: false, model: 'm' },
    { personaId: 'p2', segment: 'rural', repeat: 2, weight: 0.3, answers: { q: { type: 'choice', choice: 'y', probabilities: { x: 0, y: 1 }, confidence: 1 } }, cacheHit: false, model: 'm' },
  ];
  const summary = summarizeVotes({ q: question }, votes).q!;
  assert.equal(summary.respondentCount, 2);
  assert.ok(Math.abs(summary.totalWeight - 1) < 1e-12);
  assert.ok(Math.abs(summary.probabilities!.x - 0.4) < 1e-12);
  assert.equal(summary.bySegment.urban?.respondentCount, 1);
  assert.ok(Math.abs(summary.bySegment.rural!.totalWeight - 0.6) < 1e-12);
  assert.equal(summary.byRepeat['1']?.respondentCount, 2);
  assert.ok(Math.abs(summary.byRepeat['1']!.totalWeight - 0.5) < 1e-12);
});

const cohort = {
  version: 1 as const, id: 'c', name: 'C', description: '', population: '', createdAt: '', sources: [], assumptions: [],
  segments: [{ id: 'all', label: 'All', description: '', weight: 1, weightBasis: 'assumed' as const, sourceIds: [] }],
  personas: [1, 2, 3].map((n) => ({ id: `p${n}`, label: `p${n}`, segment: 'all', age: 30, background: '', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 })),
};
const flow = {
  version: 1 as const, id: 'flow', name: 'Flow', description: '', context: {}, cohorts: { c: 'c.json' },
  stages: [{ id: 'poll', kind: 'poll' as const, label: 'Poll', cohort: 'c', dependsOn: [], questions: { pick: question } }],
};
const provider: Provider = {
  name: 'mock',
  async evaluate(request) {
    return {
      model: request.model, usage: { inputTokens: 1, outputTokens: 1 },
      answers: { pick: { type: 'choice', choice: 'x', probabilities: { x: 0.65, y: 0.35 }, confidence: 0.3 } },
    };
  },
};

async function sampleRun(): Promise<RunRecord> {
  return runPipeline(flow, { c: cohort }, { provider, model: 'm', seed: 's', concurrency: 2 });
}

test('Monte Carlo output is reproducible and explicitly conditional on model outputs', async () => {
  const run = await sampleRun();
  const a = simulateVotes(run, 'poll', 'pick', 1200, 'analysis-seed');
  const b = simulateVotes(run, 'poll', 'pick', 1200, 'analysis-seed');
  assert.deepEqual(a, b);
  assert.equal(a.label, 'conditional on model outputs');
  assert.equal(a.respondentCount, 3);
  assert.equal(a.intervalsArePopulationConfidenceIntervals, false);
  assert.ok(a.winnerFrequency);
  assert.equal(a.tieCount, 0);
  assert.ok(a.intervals.x!.lower <= a.intervals.x!.mean);
  assert.ok(a.intervals.x!.mean <= a.intervals.x!.upper);
  assert.ok(Math.abs(a.intervals.x!.mean - 0.65) < 0.04);
});

test('run comparisons keep runs separate and reject incomparable providers', async () => {
  const run = await sampleRun();
  const second = { ...run, id: 'second', createdAt: 'later' };
  const comparison = compareRuns([run, second], 'poll', 'pick');
  assert.equal(comparison.runs.length, 2);
  assert.equal(comparison.baselineRunId, run.id);
  assert.ok(comparison.differencesFromBaseline.every((difference) => difference.difference === 0));
  assert.equal(comparison.averagesAcrossRuns.probabilities?.x, 0.65);
  const changedSample = {
    ...second,
    pipeline: { ...second.pipeline, stages: second.pipeline.stages.map((stage) => stage.kind === 'poll' ? { ...stage, size: 2 } : stage) },
    pipelineHash: 'sample-config-changed',
    cohorts: { c: { ...cohort, segments: cohort.segments.map((segment) => ({ ...segment, weight: segment.id === 'all' ? 0.8 : segment.weight })) } },
  };
  const comparedSample = compareRuns([run, changedSample], 'poll', 'pick');
  assert.ok(comparedSample.notes.some((note) => note.includes('weight differs')));
  const incompatible = { ...second, provider: 'typesafe' as const };
  assert.throws(() => compareRuns([run, incompatible], 'poll', 'pick'), /different providers/);
  const aliasChanged = { ...second, stages: { ...second.stages, poll: { ...second.stages.poll!, votes: second.stages.poll!.votes.map((vote) => ({ ...vote, model: 'jev-new-alias-target' })) } } };
  assert.throws(() => compareRuns([run, aliasChanged], 'poll', 'pick'), /resolved to different provider models/);
});

test('structured choice comparisons ignore property order and retain normalized weighted probabilities', async () => {
  const run = await sampleRun();
  const stage = run.pipeline.stages[0]!;
  assert.ok(stage.kind === 'poll' && stage.questions.pick?.type === 'choice');
  stage.questions.pick.criteria = { x: { label: 'Everyday', description: 'For daily use.' }, y: { label: 'Occasional', description: '' } };
  const second = structuredClone(run); second.id = 'second';
  const secondStage = second.pipeline.stages[0]!;
  assert.ok(secondStage.kind === 'poll' && secondStage.questions.pick?.type === 'choice');
  secondStage.questions.pick.criteria.x = { description: 'For daily use.', label: 'Everyday' };
  const comparison = compareRuns([run, second], 'poll', 'pick');
  assert.deepEqual(comparison.averagesAcrossRuns.probabilities, { x: 0.65, y: 0.35 });
  secondStage.questions.pick.criteria.x.description = 'For rare occasions.';
  assert.throws(() => compareRuns([run, second], 'poll', 'pick'), /different questions/);
});
