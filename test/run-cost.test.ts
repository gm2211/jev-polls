import test from 'node:test';
import assert from 'node:assert/strict';
import { runCost, usdForTokens } from '../src/run-cost.js';
import { JEV_USD_PER_MILLION_TOKENS } from '../src/request-budget.js';
import type { RunRecord, StageResult } from '../src/types.js';

const stage = (id: string, status: StageResult['status'], usage?: StageResult['usage']): StageResult => ({ id, kind: 'poll', label: `Step ${id}`, status, dependsOn: [], votes: [], summaries: {}, startedAt: '', finishedAt: '', ...(usage ? { usage } : {}) });
const record = (provider: RunRecord['provider'], stages: StageResult[], usage: RunRecord['usage']): RunRecord => ({
  version: 1, id: 'run', createdAt: '', finishedAt: '', pipelineHash: '', provider, model: 'jev', seed: 's', status: 'completed', cohorts: {}, warnings: [], usage,
  pipeline: { version: 1, id: 'p', name: 'P', description: '', context: {}, cohorts: {}, stages: stages.map((item) => ({ id: item.id, kind: 'poll', label: item.label, dependsOn: [], cohort: 'c', questions: {} })) } as unknown as RunRecord['pipeline'],
  stages: Object.fromEntries(stages.map((item) => [item.id, item])),
});

test('a TypeSafe run costs its billed tokens at the observed rate, per step in run order', () => {
  const cost = runCost(record('typesafe', [stage('a', 'completed', { inputTokens: 800_000, outputTokens: 200_000, requests: 10, cacheHits: 0 }), stage('b', 'completed', { inputTokens: 0, outputTokens: 0, requests: 0, cacheHits: 6 }), stage('c', 'skipped')], { inputTokens: 800_000, outputTokens: 200_000, requests: 10, cacheHits: 6 }));
  assert.equal(cost.billing, 'typesafe');
  assert.equal(cost.total.usd, JEV_USD_PER_MILLION_TOKENS);
  assert.deepEqual(cost.steps?.map((step) => [step.id, step.requests, step.reused, step.usd, step.status]), [['a', 10, 0, JEV_USD_PER_MILLION_TOKENS, 'completed'], ['b', 0, 6, 0, 'completed'], ['c', 0, 0, 0, 'skipped']]);
  assert.equal(usdForTokens(500_000, 500_000), JEV_USD_PER_MILLION_TOKENS);
});

test('demo and local runs bill nothing, and runs saved before per-step usage show only the total', () => {
  assert.equal(runCost(record('mock', [stage('a', 'completed', { inputTokens: 0, outputTokens: 0, requests: 4, cacheHits: 0 })], { inputTokens: 0, outputTokens: 0, requests: 4, cacheHits: 0 })).billing, 'demo');
  const local = runCost(record('gliner', [stage('a', 'completed', { inputTokens: 0, outputTokens: 0, requests: 4, cacheHits: 0 })], { inputTokens: 0, outputTokens: 0, requests: 4, cacheHits: 0, tokenUsage: 'unreported' }));
  assert.equal(local.billing, 'local'); assert.equal(local.total.usd, 0);
  const legacy = runCost(record('typesafe', [stage('a', 'completed')], { inputTokens: 1000, outputTokens: 100, requests: 2, cacheHits: 0 }));
  assert.equal(legacy.steps, undefined);
  assert.ok(legacy.total.usd > 0);
});
