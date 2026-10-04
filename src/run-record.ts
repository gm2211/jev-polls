import { z } from 'zod';
import { readJson } from './io.js';
import { outputQuestions, parseCohort, parsePipeline } from './schema.js';
import { hashValue } from './engine-utils.js';
import type { Answer, Question, RunRecord, SummaryBase } from './types.js';
const probability = z.number().finite().min(0).max(1);
const probabilities = z.record(z.string(), probability);
const summary = z.object({ type: z.enum(['choice', 'score', 'noul']), label: z.string(), probabilities: probabilities.optional(), mean: z.number().finite().optional(), winner: z.string().optional(), margin: probability.optional(), topProbability: probability.optional(), meanConfidence: probability.optional(), respondentCount: z.number().int().nonnegative(), totalWeight: z.number().finite().nonnegative() }).strict();
const answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities, confidence: probability }).strict(),
  z.object({ type: z.literal('score'), score: z.number().finite(), probabilities, confidence: probability, legend: z.record(z.string(), z.string()) }).strict(),
  z.object({ type: z.literal('noul'), noul: probability }).strict(),
]);
export const runSchema = z.object({
  version: z.literal(1), id: z.string(), createdAt: z.string(), finishedAt: z.string(), pipeline: z.unknown(), pipelineHash: z.string(), provider: z.enum(['mock', 'typesafe']), model: z.string(), seed: z.string(), status: z.enum(['completed', 'failed']), cohorts: z.record(z.string(), z.unknown()), warnings: z.array(z.string()),
  usage: z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative(), requests: z.number().nonnegative(), cacheHits: z.number().nonnegative() }).strict(),
  stages: z.record(z.string(), z.object({ id: z.string(), kind: z.enum(['poll', 'aggregate', 'decision']), label: z.string(), status: z.enum(['completed', 'skipped', 'failed']), reason: z.string().optional(), dependsOn: z.array(z.string()), startedAt: z.string(), finishedAt: z.string(),
    votes: z.array(z.object({ personaId: z.string(), cohortId: z.string().optional(), segment: z.string(), repeat: z.number().int().nonnegative(), weight: z.number().finite().nonnegative(), answers: z.record(z.string(), answer), cacheHit: z.boolean(), model: z.string() }).strict()),
    summaries: z.record(z.string(), summary.extend({ bySegment: z.record(z.string(), summary), byRepeat: z.record(z.string(), summary) }).strict()),
  }).strict()),
}).strict();

function assertKeys(actual: string[], expected: string[], where: string): void {
  const a = [...actual].sort();
  const e = [...expected].sort();
  if (a.length !== e.length || e.some((key, index) => key !== a[index])) {
    throw new Error(`Saved run has mismatched fields at ${where}`);
  }
}

function validateDistribution(values: Record<string, number> | undefined, expectedKeys: string[], where: string): void {
  if (!values) throw new Error(`Saved run is missing probabilities at ${where}`);
  assertKeys(Object.keys(values), expectedKeys, where);
  const total = Object.values(values).reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-5) throw new Error(`Saved run probabilities do not sum to one at ${where}`);
}

function validateAnswerForQuestion(answer: Answer, question: Question, where: string): void {
  if (answer.type !== question.type) throw new Error(`Saved run answer type does not match its question at ${where}`);
  if (question.type === 'noul' && answer.type === 'noul') return;
  if (question.type === 'choice' && answer.type === 'choice') {
    const options = Object.keys(question.criteria);
    validateDistribution(answer.probabilities, options, where);
    const maximum = Math.max(...Object.values(answer.probabilities));
    if (!options.includes(answer.choice) || answer.probabilities[answer.choice]! < maximum - 1e-8) {
      throw new Error(`Saved run choice is not a most likely option at ${where}`);
    }
    return;
  }
  if (question.type === 'score' && answer.type === 'score') {
    const levels = question.criteria.map((_, index) => String(index));
    validateDistribution(answer.probabilities, levels, where);
    if (answer.score < 0 || answer.score > levels.length - 1) throw new Error(`Saved run score is outside its rubric at ${where}`);
    const expectedLegend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
    if (JSON.stringify(Object.keys(answer.legend).sort().map(key => [key, answer.legend[key]])) !==
        JSON.stringify(Object.keys(expectedLegend).sort().map(key => [key, expectedLegend[key]]))) {
      throw new Error(`Saved run score legend does not match its rubric at ${where}`);
    }
    const expectedScore = levels.reduce((sum, key, index) => sum + answer.probabilities[key]! * index, 0);
    // The API may round its probability-weighted Score to two decimal places.
    if (Math.abs(answer.score - expectedScore) > 0.0101) throw new Error(`Saved run score is inconsistent with its distribution at ${where}`);
  }
}

function validateSummaryBase(summary: SummaryBase, question: Question, where: string, expectedLabel?: string): void {
  if (summary.type !== question.type || (expectedLabel !== undefined && summary.label !== expectedLabel)) {
    throw new Error(`Saved run summary does not match its question at ${where}`);
  }
  if (summary.totalWeight === 0) {
    if (summary.respondentCount !== 0 || summary.probabilities || summary.mean !== undefined || summary.winner !== undefined ||
        summary.margin !== undefined || summary.topProbability !== undefined || summary.meanConfidence !== undefined) {
      throw new Error(`Saved run has metrics for an empty summary at ${where}`);
    }
    return;
  }
  if (summary.respondentCount < 1) throw new Error(`Saved run has weighted results without respondents at ${where}`);

  if (question.type === 'noul') {
    if (summary.mean === undefined || summary.mean < 0 || summary.mean > 1 || summary.topProbability === undefined ||
        Math.abs(summary.topProbability - summary.mean) > 1e-8 || summary.probabilities || summary.winner !== undefined || summary.margin !== undefined) {
      throw new Error(`Saved run has invalid Noul summary metrics at ${where}`);
    }
    return;
  }

  const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  validateDistribution(summary.probabilities, keys, where);
  const ranked = Object.entries(summary.probabilities!).sort(([, left], [, right]) => right - left);
  const top = ranked[0]!;
  const winningProbability = summary.winner === undefined ? undefined : summary.probabilities?.[summary.winner];
  const hasWinningProbability = winningProbability !== undefined && Math.abs(winningProbability - top[1]) <= 1e-8;
  if (!hasWinningProbability || summary.topProbability === undefined || Math.abs(summary.topProbability - top[1]) > 1e-8) {
    throw new Error(`Saved run winner does not match its summary distribution at ${where}`);
  }
  if (question.type === 'choice') {
    const margin = top[1] - (ranked[1]?.[1] ?? 0);
    if (summary.margin === undefined || Math.abs(summary.margin - margin) > 1e-8 || summary.mean !== undefined) {
      throw new Error(`Saved run Choice summary metrics are inconsistent at ${where}`);
    }
  } else {
    const expectedMean = keys.reduce((sum, key, index) => sum + summary.probabilities![key]! * index, 0);
    if (summary.mean === undefined || Math.abs(summary.mean - expectedMean) > 0.0101 || summary.margin !== undefined) {
      throw new Error(`Saved run Score summary metrics are inconsistent at ${where}`);
    }
  }
}

function validateQuestionSummary(value: z.infer<typeof runSchema>['stages'][string]['summaries'][string], question: Question, where: string): void {
  validateSummaryBase(value, question, where);
  for (const [segment, summary] of Object.entries(value.bySegment)) validateSummaryBase(summary, question, `${where}.bySegment.${segment}`);
  for (const [repeat, summary] of Object.entries(value.byRepeat)) validateSummaryBase(summary, question, `${where}.byRepeat.${repeat}`);
}

export function parseRun(input: unknown): RunRecord {
  const run = runSchema.parse(input);
  const pipeline = parsePipeline(run.pipeline);
  if (hashValue(pipeline) !== run.pipelineHash) throw new Error('Run pipeline hash does not match its saved snapshot');
  for (const name of Object.keys(pipeline.cohorts)) {
    if (!Object.hasOwn(run.cohorts, name)) throw new Error(`Run is missing cohort snapshot: ${name}`);
  }
  for (const c of Object.values(run.cohorts)) parseCohort(c);
  const questionsByStage = outputQuestions(pipeline);
  const ids = pipeline.stages.map(s => s.id);
  if (ids.length !== Object.keys(run.stages).length) throw new Error('Run stages do not match its saved pipeline');
  for (const stage of pipeline.stages) {
    const result = run.stages[stage.id];
    if (!result || result.id !== stage.id || result.kind !== stage.kind) throw new Error(`Run is missing or mismatches stage: ${stage.id}`);
    if (result.status !== 'completed' && Object.keys(result.summaries).length) throw new Error(`Incomplete stage ${stage.id} must not expose full-panel summaries`);
    if (result.label !== stage.label || JSON.stringify(result.dependsOn) !== JSON.stringify(stage.dependsOn)) throw new Error(`Run stage metadata does not match pipeline stage: ${stage.id}`);
    const questions = questionsByStage[stage.id]!;
    for (const [index, vote] of result.votes.entries()) {
      assertKeys(Object.keys(vote.answers), Object.keys(questions), `${stage.id}.votes[${index}].answers`);
      for (const [questionId, answer] of Object.entries(vote.answers)) {
        validateAnswerForQuestion(answer, questions[questionId]!, `${stage.id}.votes[${index}].${questionId}`);
      }
    }
    if (result.status === 'completed') {
      assertKeys(Object.keys(result.summaries), Object.keys(questions), `${stage.id}.summaries`);
      for (const [questionId, question] of Object.entries(questions)) {
        validateQuestionSummary(result.summaries[questionId]!, question, `${stage.id}.summaries.${questionId}`);
      }
    }
  }
  if (run.status === 'completed' && Object.values(run.stages).some(s => s.status === 'failed')) throw new Error('Run status contradicts a failed stage');
  return run as RunRecord;
}
export async function loadRun(path: string) { return parseRun(await readJson(path)); }
