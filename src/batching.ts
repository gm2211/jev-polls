import type { Answer, Json, PollInputBinding, PollStage } from './types.js';

/** Fixed guidance added to the state of every batched request, so Jev knows what it is looking at. */
export const MAP_GUIDE = 'The input marked with batch is one slice of a larger set of individual responses (batch k of batches, out of totalResponses). Answer the same questions for this slice only.';
export const COMBINE_GUIDE = 'The input marked with combine holds your own earlier verdicts, one per batch of individual responses, each saying how many responses it covered and your answers to the same questions. Answer the same questions for everything those batches cover together.';

/** The one binding of a step that reads its responses in batches, if any. */
export function batchedBinding(stage: PollStage): { alias: string; binding: PollInputBinding } | undefined {
  const found = Object.entries(stage.inputs ?? {}).find(([, binding]) => binding.batch !== undefined);
  return found ? { alias: found[0], binding: found[1] } : undefined;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size));
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += width) result.push(items.slice(index, index + width));
  return result;
}

export function mapInput(batch: number, batches: number, totalResponses: number, responses: Json[]): Json {
  return { batch, batches, totalResponses, responses };
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;
const roundMap = (values: Record<string, number>): Json => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, round3(value)]));

/** The compact form of one answer inside a verdict: the winner and a rounded distribution. */
export function compactAnswer(answer: Answer): Json {
  if (answer.type === 'choice') return { choice: answer.choice, probabilities: roundMap(answer.probabilities) };
  if (answer.type === 'score') return { score: round3(answer.score), probabilities: roundMap(answer.probabilities) };
  return { noul: round3(answer.noul) };
}

export interface Verdict { batch: number; responses: number; answers: Record<string, Answer> }
export function verdictEntry(verdict: Verdict): Json {
  return { batch: verdict.batch, responses: verdict.responses, answers: Object.fromEntries(Object.entries(verdict.answers).map(([id, answer]) => [id, compactAnswer(answer)])) };
}
export function reduceInput(round: number, totalResponses: number, verdicts: Verdict[]): Json {
  return { combine: true, round, totalResponses, batches: verdicts.map(verdictEntry) };
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
}

export interface BatchShape { totalResponses: number; batchSize: number; batches: number; reduceRounds: number }
/** "read 1000 responses from Gamers in 10 batches of 100, then combined them in 1 round" */
export function describeBatching(label: string, sourceLabel: string, shape: BatchShape, tense: 'past' | 'future' = 'past'): string {
  const read = tense === 'past' ? 'read' : 'reads';
  const combined = tense === 'past' ? 'combined them' : 'combines them';
  const from = sourceLabel ? ` from ${sourceLabel}` : '';
  if (shape.batches <= 1) return `${label} ${read} all ${plural(shape.totalResponses, 'response')}${from} in one request`;
  return `${label} ${read} ${plural(shape.totalResponses, 'response')}${from} in ${plural(shape.batches, 'batch', 'batches')} of ${shape.batchSize.toLocaleString('en-US')}, then ${combined} in ${plural(shape.reduceRounds, 'round')}`;
}

