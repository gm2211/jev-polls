import { createHash } from 'node:crypto';
import type { Json, Pipeline, PollStage, Question, Stage, StageResult } from './types.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(',')}}`;
}

export function hashValue(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function seededRandom(seed: string): () => number {
  // SHA-256 counter mode gives deterministic independent streams for any seed.
  let counter = 0;
  return () => {
    const bytes = createHash('sha256').update(`${seed}\0${counter++}`).digest();
    return bytes.readUInt32BE(0) / 0x1_0000_0000;
  };
}

export function isFiniteProbability(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isJson(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJson);
  }
  return false;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveQuestion(stages: Stage[], stageId: string, questionId: string, seen = new Set<string>()): Question | undefined {
  const key = `${stageId}.${questionId}`;
  if (seen.has(key)) return undefined;
  seen.add(key);
  const stage = stages.find((candidate) => candidate.id === stageId);
  if (!stage) return undefined;
  if (stage.kind === 'poll') {
    const question = stage.questions[questionId];
    if (question?.type !== 'choice' || !question.optionsFrom) return question;
    const source = resolveQuestion(stages, question.optionsFrom.stage, question.optionsFrom.question, seen);
    return source?.type === 'choice' ? { ...question, criteria: source.criteria } : undefined;
  }
  if (stage.kind === 'decision' && stage.outputQuestion === questionId) return resolveQuestion(stages, stage.from.stage, stage.from.question, seen);
  if (stage.kind === 'aggregate' && stage.outputQuestion === questionId) {
    const input = stage.inputs[0];
    return input ? resolveQuestion(stages, input.stage, input.question, seen) : undefined;
  }
  return undefined;
}

/** Jev rounds probabilities to two decimals, so its chosen option can trail the reported maximum by up to one rounding step (plus renormalization). */
export const CHOICE_WINNER_TOLERANCE = 0.011;

/**
 * The questions a poll step asks in this run. A Choice question whose options come from an earlier step takes that
 * step's options ranked by share (ties keep the source's order), the first `top` of them; the rest ask as written.
 * `optionsFrom` is dropped, so the request matches a typed list with the same options.
 */
export function resolveOptionsFrom(pipeline: Pipeline, stage: PollStage, stages: Record<string, StageResult>): Record<string, Question> {
  return Object.fromEntries(Object.entries(stage.questions).map(([id, question]) => {
    if (question.type !== 'choice' || !question.optionsFrom) return [id, question];
    const { optionsFrom: from, ...asked } = question;
    const source = resolveQuestion(pipeline.stages, from.stage, from.question);
    const summary = stages[from.stage]?.status === 'completed' ? stages[from.stage]!.summaries[from.question] : undefined;
    if (source?.type !== 'choice' || !summary?.probabilities) throw new Error(`options come from '${from.stage}.${from.question}', which has no completed option shares`);
    const order = Object.keys(source.criteria);
    const ranked = Object.keys(summary.probabilities).filter((key) => Object.hasOwn(source.criteria, key))
      .sort((a, b) => summary.probabilities![b]! - summary.probabilities![a]! || order.indexOf(a) - order.indexOf(b));
    const kept = ranked.slice(0, from.top ?? ranked.length);
    if (kept.length < 2) throw new Error(`options come from '${from.stage}.${from.question}', which ranked fewer than two options`);
    return [id, { ...asked, criteria: Object.fromEntries(kept.map((key) => [key, source.criteria[key]!])) }];
  }));
}
