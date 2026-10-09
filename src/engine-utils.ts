import { createHash } from 'node:crypto';
import type { Json, Question, Stage } from './types.js';

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
  if (stage.kind === 'poll') return stage.questions[questionId];
  if (stage.kind === 'decision' && stage.outputQuestion === questionId) return resolveQuestion(stages, stage.from.stage, stage.from.question, seen);
  if (stage.kind === 'aggregate' && stage.outputQuestion === questionId) {
    const input = stage.inputs[0];
    return input ? resolveQuestion(stages, input.stage, input.question, seen) : undefined;
  }
  return undefined;
}
