import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ProviderError } from '../src/provider.js';
import type { Cohort, Evaluation, EvaluationRequest, Pipeline, Provider, Question, RunOptions } from '../src/types.js';
import { runPipeline, selectPersonas } from '../src/engine.js';
import { simulateVotes } from '../src/analysis.js';

const choiceQuestion: Question = {
  type: 'choice', label: 'Pick one', instructions: 'Pick one', criteria: { a: 'A', b: 'B' },
};
const cohort: Cohort = {
  version: 1, id: 'audience', name: 'Audience', description: '', population: 'test people', createdAt: '2026-01-01T00:00:00Z',
  sources: [], assumptions: [],
  segments: [
    { id: 's1', label: 'S1', description: '', weight: 0.7, weightBasis: 'assumed', sourceIds: [] },
    { id: 's2', label: 'S2', description: '', weight: 0.3, weightBasis: 'assumed', sourceIds: [] },
  ],
  personas: [
    ...['p1', 'p2'].map((id) => ({ id, label: id, segment: 's1', age: 30, background: '', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 })),
    ...['p3', 'p4'].map((id) => ({ id, label: id, segment: 's2', age: 30, background: '', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 })),
  ],
};

function pipeline(stages: Pipeline['stages']): Pipeline {
  return { version: 1, id: 'flow', name: 'Flow', description: '', context: {}, cohorts: { audience: 'audience.json' }, stages };
}

function poll(id: string, dependsOn: string[] = [], extra: Partial<Extract<Pipeline['stages'][number], { kind: 'poll' }>> = {}) {
  return { id, kind: 'poll' as const, label: id, cohort: 'audience', dependsOn, questions: { pick: choiceQuestion }, ...extra };
}

function fixedProvider(choice = 'a', hooks: { onCall?: (request: EvaluationRequest) => Promise<void> | void; malformed?: boolean } = {}): Provider & { calls: number } {
  const provider = {
    name: 'mock' as const,
    calls: 0,
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      provider.calls += 1;
      await hooks.onCall?.(request);
      const answer = hooks.malformed
        ? { type: 'choice' as const, choice: 'unknown', probabilities: { a: 1, b: 0 }, confidence: 1 }
        : { type: 'choice' as const, choice, probabilities: choice === 'a' ? { a: 0.8, b: 0.2 } : { a: 0.2, b: 0.8 }, confidence: 0.6 };
      return { model: request.model, usage: { inputTokens: 10, outputTokens: 2 }, answers: { pick: answer } };
    },
  };
  return provider;
}

function options(provider: Provider, overrides: Partial<RunOptions> = {}): RunOptions {
  return { provider, model: 'test-model', seed: 'seed', concurrency: 3, ...overrides };
}

test('branches select by upstream summary and any-join rejoins completed branches', async () => {
  const provider = fixedProvider('a');
  const flow = pipeline([
    poll('base'),
    poll('branch-a', ['base'], { when: { stage: 'base', question: 'pick', metric: 'winner', op: 'eq', value: 'a' } }),
    poll('branch-b', ['base'], { when: { stage: 'base', question: 'pick', metric: 'winner', op: 'eq', value: 'b' } }),
    { id: 'rejoin', kind: 'poll', label: 'Rejoin', cohort: 'audience', dependsOn: ['branch-a', 'branch-b'], join: 'any', questions: { pick: choiceQuestion } },
  ]);
  const run = await runPipeline(flow, { audience: cohort }, options(provider));
  assert.equal(run.stages['branch-a']?.status, 'completed');
  assert.equal(run.stages['branch-b']?.status, 'skipped');
  assert.equal(run.stages.rejoin?.status, 'completed');
  assert.equal(run.stages.rejoin?.dependsOn.length, 2);
});

test('live member progress emits queued, running, and completed states with actual answers', async () => {
  const events: NonNullable<RunOptions['onMemberProgress']> extends (event: infer E) => void ? E[] : never = [];
  const provider = fixedProvider('b', { async onCall() { await new Promise(resolve => setTimeout(resolve, 2)); } });
  await runPipeline(pipeline([poll('live', [], { size: 2 })]), { audience: cohort }, options(provider, { concurrency: 1, onMemberProgress: event => events.push(event) }));
  assert.equal(events.filter(event => event.status === 'queued').length, 2);
  assert.equal(events.filter(event => event.status === 'running').length, 2);
  const completed = events.filter(event => event.status === 'completed');
  assert.equal(completed.length, 2);
  assert.ok(completed.every(event => event.answers?.pick?.type === 'choice' && event.answers.pick.choice === 'b'));
});

test('explicit poll inputs project only selected named outputs and preserve legacy omission', async () => {
  const seen: EvaluationRequest[] = [];
  const provider = fixedProvider('a', { onCall(request) { seen.push(request); } });
  const run = await runPipeline(pipeline([
    poll('source'),
    poll('selected', ['source'], { inputs: {
      distribution: { stage: 'source', question: 'pick', select: 'probabilities' },
      response_rows: { stage: 'source', question: 'pick', select: 'responses' },
      choice: { stage: 'source', question: 'pick', select: 'winner' },
    } }),
    poll('legacy', ['source']),
  ]), { audience: cohort }, options(provider));
  const selected = seen.find((request) => Object.hasOwn(request.state as object, 'inputs'))!;
  const state = selected.state as any;
  assert.deepEqual(Object.keys(state.inputs).sort(), ['choice', 'distribution', 'response_rows']);
  assert.ok(Math.abs(state.inputs.distribution.a - 0.8) < 1e-12);
  assert.ok(Math.abs(state.inputs.distribution.b - 0.2) < 1e-12);
  assert.equal(state.inputs.choice, 'a');
  assert.equal(state.inputs.response_rows.length, 4);
  assert.deepEqual(state.inputs.response_rows[0].answer, { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 });
  assert.equal('answers' in state.inputs.response_rows[0], false);
  assert.equal('upstream' in state, false);
  const legacy = seen.find((request) => Object.hasOwn(request.state as object, 'upstream'))!;
  assert.equal(Array.isArray((legacy.state as any).upstream), true);
  assert.equal(run.stages.selected?.status, 'completed');
});

test('explicit optional input is null when its source branch was skipped', async () => {
  const seen: EvaluationRequest[] = [];
  const provider = fixedProvider('a', { onCall(request) { seen.push(request); } });
  const run = await runPipeline(pipeline([
    poll('base'),
    poll('inactive', ['base'], { when: { stage: 'base', question: 'pick', metric: 'winner', op: 'eq', value: 'b' } }),
    poll('rejoin', ['base', 'inactive'], { join: 'any', inputs: { optional: { stage: 'inactive', question: 'pick' } } }),
  ]), { audience: cohort }, options(provider));
  assert.equal(run.stages.inactive?.status, 'skipped');
  assert.equal(run.stages.rejoin?.status, 'completed');
  const request = seen.find((candidate) => (candidate.state as any).inputs !== undefined)!;
  assert.deepEqual((request.state as any).inputs, { optional: null });
  assert.equal('upstream' in (request.state as any), false);
});

test('runtime rejects invalid bindings when callers bypass parsePipeline', async () => {
  const flow = pipeline([
    poll('source'),
    poll('consumer', ['source'], { inputs: { estimate: { stage: 'source', question: 'pick', select: 'mean' } } }),
  ]);
  await assert.rejects(() => runPipeline(flow, { audience: cohort }, options(fixedProvider())), /incompatible with choice/);
});

test('any-join aggregate consumes only completed inputs and normalizes their weights', async () => {
  const flow = pipeline([
    poll('base'),
    poll('inactive', ['base'], { when: { stage: 'base', question: 'pick', metric: 'winner', op: 'eq', value: 'b' } }),
    {
      id: 'aggregate', kind: 'aggregate', label: 'Combined', dependsOn: ['base', 'inactive'], join: 'any',
      inputs: [{ stage: 'base', question: 'pick', weight: 3 }, { stage: 'inactive', question: 'pick', weight: 1 }], outputQuestion: 'combined',
    },
  ]);
  const run = await runPipeline(flow, { audience: cohort }, options(fixedProvider()));
  assert.equal(run.stages.inactive?.status, 'skipped');
  assert.equal(run.stages.aggregate?.status, 'completed');
  assert.ok(Math.abs(run.stages.aggregate!.summaries.combined!.probabilities!.a! - 0.8) < 1e-12);
  assert.ok(Math.abs(run.stages.aggregate!.summaries.combined!.probabilities!.b! - 0.2) < 1e-12);
  assert.equal(run.stages.aggregate?.votes.length, 4);
  assert.equal(run.stages.aggregate?.summaries.combined?.respondentCount, 4);
  const simulation = simulateVotes(run, 'aggregate', 'combined', 100, 'fixed');
  assert.equal(simulation.respondentCount, 4);
});

test('aggregate retains source votes and applies declared weights before summarizing', async () => {
  const provider: Provider = {
    name: 'mock',
    async evaluate(request) {
      const side = (request.state as { stageContext?: { side?: string } }).stageContext?.side;
      const choice = side === 'right' ? 'b' : 'a';
      return {
        model: request.model, usage: { inputTokens: 0, outputTokens: 0 },
        answers: { pick: { type: 'choice', choice, probabilities: choice === 'a' ? { a: 0.8, b: 0.2 } : { a: 0.2, b: 0.8 }, confidence: 0.6 } },
      };
    },
  };
  const run = await runPipeline(pipeline([
    poll('left', [], { context: { side: 'left' } }),
    poll('right', [], { context: { side: 'right' } }),
    { id: 'combine', kind: 'aggregate', label: 'Weighted', dependsOn: ['left', 'right'], inputs: [
      { stage: 'left', question: 'pick', weight: 3 }, { stage: 'right', question: 'pick', weight: 1 },
    ], outputQuestion: 'choice' },
  ]), { audience: cohort }, options(provider));
  const stage = run.stages.combine!;
  assert.equal(stage.votes.length, 8);
  assert.equal(stage.summaries.choice?.respondentCount, 4);
  assert.ok(Math.abs(stage.summaries.choice!.probabilities!.a! - 0.65) < 1e-12);
  assert.ok(Math.abs(stage.summaries.choice!.totalWeight - 1) < 1e-12);
});

test('any-join entry stages run and missing evidence stays unknown under not', async () => {
  const run = await runPipeline(pipeline([
    poll('entry', [], { join: 'any' }),
    poll('base'),
    poll('skipped', ['base'], { when: { stage: 'base', question: 'pick', metric: 'winner', op: 'eq', value: 'b' } }),
    poll('not-of-missing', ['base', 'skipped'], {
      join: 'any',
      when: { not: { stage: 'skipped', question: 'pick', metric: 'winner', op: 'eq', value: 'a' } },
    }),
  ]), { audience: cohort }, options(fixedProvider()));
  assert.equal(run.stages.entry?.status, 'completed');
  assert.equal(run.stages.skipped?.status, 'skipped');
  assert.equal(run.stages['not-of-missing']?.status, 'skipped');
  assert.equal(run.stages['not-of-missing']?.reason, 'stage condition was false');
});

test('failed voters remain visible and descendants skip; malformed provider answers are rejected', async () => {
  let calls = 0;
  const partialProvider = fixedProvider('a', { onCall: () => { calls += 1; if (calls === 2) throw new Error('private detail'); } });
  const run = await runPipeline(pipeline([poll('first', [], { size: 4 }), poll('child', ['first'])]), { audience: cohort }, options(partialProvider, { concurrency: 1 }));
  assert.equal(run.status, 'failed');
  assert.equal(run.stages.first?.status, 'failed');
  assert.match(run.stages.first?.reason ?? '', /p[1-4]/);
  assert.doesNotMatch(run.stages.first?.reason ?? '', /private detail/);
  assert.equal(run.stages.first?.votes.length, 3);
  assert.deepEqual(run.stages.first?.summaries, {});
  assert.equal(run.stages.child?.status, 'skipped');

  const malformed = await runPipeline(pipeline([poll('bad')]), { audience: cohort }, options(fixedProvider('a', { malformed: true })));
  assert.equal(malformed.stages.bad?.status, 'failed');
  assert.equal(malformed.stages.bad?.votes.length, 0);
});

test('live response failures report only fixed provider validation guidance', async () => {
  const secret = 'fake-upstream-body-must-not-appear';
  const provider: Provider = {
    name: 'typesafe',
    async evaluate(): Promise<Evaluation> {
      throw new ProviderError('TYPESAFE_RESPONSE_INVALID', `upstream echoed ${secret}`, undefined, 'choice_winner');
    },
  };
  const run = await runPipeline(pipeline([poll('invalid')]), { audience: cohort }, options(provider, { concurrency: 1 }));
  const reason = run.stages.invalid?.reason ?? '';
  assert.match(reason, /selected Choice is not the most probable option/);
  assert.doesNotMatch(reason, /upstream echoed|fake-upstream-body-must-not-appear/);
});

test('cycles are rejected before provider calls', async () => {
  const provider = fixedProvider();
  await assert.rejects(runPipeline(pipeline([poll('a', ['b']), poll('b', ['a'])]), { audience: cohort }, options(provider)), /cycle/);
  assert.equal(provider.calls, 0);
});

test('cache reuses exact requests and changes when state changes', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'jev-cache-'));
  try {
    const provider = fixedProvider();
    const original = pipeline([poll('poll')]);
    const first = await runPipeline(original, { audience: cohort }, options(provider, { cacheDir }));
    const second = await runPipeline(original, { audience: cohort }, options(provider, { cacheDir }));
    assert.equal(first.usage.cacheHits, 0);
    assert.equal(second.usage.cacheHits, 4);
    assert.equal(provider.calls, 4);
    const changed = { ...original, context: { changed: true } };
    const third = await runPipeline(changed, { audience: cohort }, options(provider, { cacheDir }));
    assert.equal(third.usage.cacheHits, 0);
    assert.equal(provider.calls, 8);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('branching game-naming fixture is bit-identical after a complete warm-cache resume', async () => {
  const [pipelineText, playersText, reviewersText] = await Promise.all([
    readFile(new URL('../examples/game-naming/pipeline.json', import.meta.url), 'utf8'),
    readFile(new URL('../examples/game-naming/players.json', import.meta.url), 'utf8'),
    readFile(new URL('../examples/game-naming/reviewers.json', import.meta.url), 'utf8'),
  ]);
  const flow = JSON.parse(pipelineText) as Pipeline;
  const cohorts = { players: JSON.parse(playersText) as Cohort, reviewers: JSON.parse(reviewersText) as Cohort };
  const provider: Provider = {
    name: 'mock',
    async evaluate(request) {
      const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
        if (question.type === 'noul') return [id, { type: 'noul' as const, noul: 0.61 }];
        if (question.type === 'choice') {
          const options = Object.keys(question.criteria);
          const index = [...request.seed].reduce((value, char) => (value * 33 + char.charCodeAt(0)) >>> 0, 5381) % options.length;
          const probabilities = Object.fromEntries(options.map((key) => [key, options.indexOf(key) === index ? 0.7 : 0.3 / (options.length - 1)]));
          return [id, { type: 'choice' as const, choice: options[index]!, probabilities, confidence: 0.6 }];
        }
        const probabilities = { '0': 0.1, '1': 0.2, '2': 0.3, '3': 0.4 };
        const legend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
        return [id, { type: 'score' as const, score: 2, probabilities, confidence: 0.5, legend }];
      }));
      return { model: request.model, usage: { inputTokens: 3, outputTokens: 2 }, answers };
    },
  };
  const cacheDir = await mkdtemp(join(tmpdir(), 'jev-branch-cache-'));
  try {
    const first = await runPipeline(flow, cohorts, options(provider, { cacheDir }));
    const second = await runPipeline(flow, cohorts, options(provider, { cacheDir }));
    assert.equal(first.status, 'completed', JSON.stringify(Object.fromEntries(Object.entries(first.stages).map(([id, stage]) => [id, { status: stage.status, reason: stage.reason }]))));
    assert.equal(first.usage.requests, 60);
    assert.equal(second.usage.requests, 0);
    assert.equal(second.usage.cacheHits, 60);
    assert.ok(first.stages.audience!.votes.every((vote) => !vote.cacheHit));
    assert.ok(second.stages.audience!.votes.every((vote) => vote.cacheHit));
    assert.equal(second.stages['close-review']?.status === 'completed' || second.stages['clear-review']?.status === 'completed', true);
    const stageOutcomes = (run: Awaited<ReturnType<typeof runPipeline>>) => Object.fromEntries(Object.entries(run.stages).map(([id, stage]) => [id, { status: stage.status, summaries: stage.summaries }]));
    assert.deepEqual(stageOutcomes(second), stageOutcomes(first));
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('repeats preserve person count and segment weights; sampling is deterministic', async () => {
  assert.deepEqual(selectPersonas(cohort, 4, 'same').map((persona) => persona.id), selectPersonas(cohort, 4, 'same').map((persona) => persona.id));
  const run = await runPipeline(pipeline([poll('poll', [], { repeats: 2 })]), { audience: cohort }, options(fixedProvider()));
  const summary = run.stages.poll!.summaries.pick!;
  assert.equal(summary.respondentCount, 4);
  assert.ok(Math.abs(summary.totalWeight - 1) < 1e-12);
  assert.equal(summary.bySegment.s1?.respondentCount, 2);
  assert.ok(Math.abs(summary.bySegment.s1!.totalWeight - 0.7) < 1e-12);
  assert.ok(Math.abs(summary.bySegment.s2!.totalWeight - 0.3) < 1e-12);
  assert.equal(summary.byRepeat['1']?.respondentCount, 4);
  assert.ok(Math.abs(summary.byRepeat['1']!.totalWeight - 0.5) < 1e-12);
});

test('default sample excludes zero-weight profiles and explicit oversampling fails', async () => {
  const extended = {
    ...cohort,
    segments: [...cohort.segments, { id: 'excluded', label: 'Excluded', description: '', weight: 0, weightBasis: 'assumed' as const, sourceIds: [] }],
    personas: [...cohort.personas, { id: 'p5', label: 'p5', segment: 'excluded', age: 25, background: '', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 }],
  };
  const defaultRun = await runPipeline(pipeline([poll('default')]), { audience: extended }, options(fixedProvider()));
  assert.equal(defaultRun.stages.default?.votes.length, 4);
  const oversampled = await runPipeline(pipeline([poll('too-many', [], { size: 5 })]), { audience: extended }, options(fixedProvider()));
  assert.equal(oversampled.stages['too-many']?.status, 'failed');
  assert.match(oversampled.stages['too-many']?.reason ?? '', /positive-weight cohort size 4/);
  const unsupported = { ...cohort, segments: [...cohort.segments, { id: 'missing', label: 'Missing', description: '', weight: 0.1, weightBasis: 'assumed' as const, sourceIds: [] }] };
  const invalid = await runPipeline(pipeline([poll('invalid')]), { audience: unsupported }, options(fixedProvider()));
  assert.equal(invalid.stages.invalid?.status, 'failed');
  assert.match(invalid.stages.invalid?.reason ?? '', /has no personas/);
});

test('seed deterministically varies the Choice option order sent to the model', async () => {
  const observed: Array<{ seed: string; order: string[] }> = [];
  const provider: Provider = {
    name: 'mock',
    async evaluate(request) {
      const order = Object.keys(request.questions.pick!.type === 'choice' ? request.questions.pick.criteria : {});
      observed.push({ seed: request.seed, order });
      const choice = order[0]!;
      const probabilities = Object.fromEntries(order.map((key, index) => [key, index === 0 ? 0.8 : 0.2]));
      return { model: request.model, usage: { inputTokens: 0, outputTokens: 0 }, answers: { pick: { type: 'choice', choice, probabilities, confidence: 0.6 } } };
    },
  };
  const flow = pipeline([poll('poll')]);
  await runPipeline(flow, { audience: cohort }, options(provider, { seed: 'order-seed' }));
  const first = observed.splice(0).sort((a, b) => a.seed.localeCompare(b.seed));
  await runPipeline(flow, { audience: cohort }, options(provider, { seed: 'order-seed' }));
  const repeated = observed.splice(0).sort((a, b) => a.seed.localeCompare(b.seed));
  assert.deepEqual(first, repeated);
  await runPipeline(flow, { audience: cohort }, options(provider, { seed: 'different-order-seed' }));
  const changed = observed.splice(0).sort((a, b) => a.seed.localeCompare(b.seed));
  assert.notDeepEqual(first.map((item) => item.order), changed.map((item) => item.order));
});

test('global request limit and concurrency bound apply across work', async () => {
  let active = 0;
  let maximumActive = 0;
  const provider = fixedProvider('a', { onCall: async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
  } });
  const run = await runPipeline(pipeline([poll('one'), poll('two')]), { audience: cohort }, options(provider, { concurrency: 2, maxRequests: 5 }));
  assert.equal(run.usage.requests, 5);
  assert.equal(provider.calls, 5);
  assert.ok(maximumActive <= 2);
  assert.equal(run.status, 'failed');
});

test('synchronous provider completions still obey one global limiter across ready stages', async () => {
  let active = 0;
  let maximumActive = 0;
  const provider: Provider = {
    name: 'mock',
    async evaluate(request) {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
      return {
        model: request.model, usage: { inputTokens: 0, outputTokens: 0 },
        answers: { pick: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.6 } },
      };
    },
  };
  const run = await runPipeline(pipeline([poll('left'), poll('right')]), { audience: cohort }, options(provider, { concurrency: 2 }));
  assert.equal(run.usage.requests, 8);
  assert.ok(maximumActive <= 2);
});
