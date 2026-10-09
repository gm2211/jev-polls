import type { Cohort, Json, Persona, PollInputBinding, PollStage, Pipeline, Question, Stage } from './types.js';
import { resolveQuestion } from './engine-utils.js';

/** Jev hard limits (https://docs.typesafe.ai/models.md): 64k tokens per request, 32k for state plus the longest question. */
export const JEV_STATE_AND_QUESTION_LIMIT = 32_000;
export const JEV_REQUEST_LIMIT = 64_000;
/** Above this share of a limit the review warns without blocking. */
export const BUDGET_WARNING_RATIO = 0.8;

/** Conservative estimate, not the tokenizer: one token per three UTF-8 bytes of the JSON that is sent. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}
const tokensOf = (value: unknown): number => estimateTokens(JSON.stringify(value) ?? 'null');

/** What the provider sends for one question (see toApiQuestion in provider.ts). */
function questionPayload(question: Question): unknown {
  return { question: question.label, instructions: question.instructions, ...(question.type === 'noul' ? {} : { criteria: question.criteria }), type: question.type };
}

/** Builds the exact state object sent for one persona; engine and budget estimate share it so they cannot drift. */
export function buildPollState(pipeline: Pipeline, cohort: Cohort, stage: PollStage, persona: Persona, upstream: { inputs?: Json; upstream?: Json }): Json {
  const state: Record<string, Json> = {
    pipelineContext: pipeline.context,
    cohort: { id: cohort.id, name: cohort.name, population: cohort.population, description: cohort.description },
    persona: persona as unknown as Json,
    sharedContext: persona.attributes,
    stageContext: stage.context ?? null,
  };
  if (upstream.inputs !== undefined) state.inputs = upstream.inputs;
  else state.upstream = upstream.upstream ?? [];
  return state;
}

export interface RequestSize { stateTokens: number; longestQuestionTokens: number; allQuestionsTokens: number; stateAndLongest: number; total: number }

/** Token estimate for an arbitrary state and question set, as sent to Jev. Reusable by batching code. */
export function estimateRequestTokens(state: Json, questions: Record<string, Question>): RequestSize {
  return requestSize(state, questions);
}

/** Estimated tokens for one serialized upstream vote record (an element of a `responses` input) for this question. */
export function estimateVoteRecordTokens(question: Question, personaId = LONG_ID, segment = LONG_ID): number {
  return Math.ceil((Buffer.byteLength(JSON.stringify(voteRecord(question, personaId, segment, 1)), 'utf8') + 1) / 3);
}

export function requestSize(state: Json, questions: Record<string, Question>): RequestSize {
  const stateTokens = tokensOf(state);
  const each = Object.values(questions).map((question) => tokensOf(questionPayload(question)));
  const longestQuestionTokens = Math.max(0, ...each);
  const allQuestionsTokens = each.reduce((sum, value) => sum + value, 0);
  return { stateTokens, longestQuestionTokens, allQuestionsTokens, stateAndLongest: stateTokens + longestQuestionTokens, total: stateTokens + allQuestionsTokens };
}

/** Runtime guard: returns a user-facing reason when an actual request would exceed a Jev limit. */
export function requestSizeProblem(state: Json, questions: Record<string, Question>): string | undefined {
  const size = requestSize(state, questions);
  if (size.stateAndLongest > JEV_STATE_AND_QUESTION_LIMIT) {
    return `request too large for Jev: about ${size.stateAndLongest.toLocaleString('en-US')} tokens of persona details plus the longest question, limit ${JEV_STATE_AND_QUESTION_LIMIT.toLocaleString('en-US')}; not sent`;
  }
  if (size.total > JEV_REQUEST_LIMIT) {
    return `request too large for Jev: about ${size.total.toLocaleString('en-US')} tokens in total, limit ${JEV_REQUEST_LIMIT.toLocaleString('en-US')}; not sent`;
  }
  return undefined;
}

export interface StageBudget {
  stageId: string;
  label: string;
  /** Largest request: persona details plus the longest question, compared with `limit`. */
  largestRequestTokens: number;
  limit: number;
  /** Largest persona details plus every question, compared with `totalLimit`. */
  totalRequestTokens: number;
  totalLimit: number;
  status: 'ok' | 'warning' | 'blocked';
  /** Plain-language findings; present when status is warning or blocked. */
  message?: string;
  largestPart: { name: string; tokens: number };
}

interface SourceStats { votes: number; segments: string[]; repeats: number }

function eligiblePersonas(cohort: Cohort): Persona[] {
  const ids = new Set(cohort.segments.filter((segment) => segment.weight > 0).map((segment) => segment.id));
  return cohort.personas.filter((persona) => ids.has(persona.segment));
}

function sourceStats(pipeline: Pipeline, cohorts: Record<string, Cohort>, stageId: string, seen = new Set<string>()): SourceStats {
  const stage = pipeline.stages.find((item) => item.id === stageId);
  if (!stage || seen.has(stageId)) return { votes: 0, segments: [], repeats: 1 };
  seen.add(stageId);
  if (stage.kind === 'poll') {
    const cohort = cohorts[stage.cohort];
    if (!cohort) return { votes: 0, segments: [], repeats: 1 };
    const repeats = stage.repeats ?? 1;
    const size = stage.size ?? eligiblePersonas(cohort).length;
    return { votes: size * repeats, segments: cohort.segments.filter((s) => s.weight > 0).map((s) => s.id), repeats };
  }
  if (stage.kind === 'decision') return sourceStats(pipeline, cohorts, stage.from.stage, seen);
  const parts = stage.inputs.map((input) => sourceStats(pipeline, cohorts, input.stage, new Set(seen)));
  return { votes: parts.reduce((sum, p) => sum + p.votes, 0), segments: [...new Set(parts.flatMap((p) => p.segments))], repeats: Math.max(1, ...parts.map((p) => p.repeats)) };
}

const LONG_NUMBER = 0.1234567890123456;
const LONG_ID = 'x'.repeat(36);

function representativeAnswer(question: Question): Json {
  if (question.type === 'noul') return { type: 'noul', noul: LONG_NUMBER };
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    return { type: 'choice', choice: longest(keys), probabilities: Object.fromEntries(keys.map((key) => [key, LONG_NUMBER])), confidence: LONG_NUMBER };
  }
  const keys = question.criteria.map((_, index) => String(index));
  return { type: 'score', score: LONG_NUMBER, probabilities: Object.fromEntries(keys.map((key) => [key, LONG_NUMBER])), confidence: LONG_NUMBER, legend: Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion])) };
}
function voteRecord(question: Question, personaId: string, segment: string, repeat: number): Json {
  return { personaId, cohortId: LONG_ID, segment, repeat, weight: LONG_NUMBER, model: 'jev-1.13.0', answer: representativeAnswer(question) } as unknown as Json;
}
const longest = (values: string[]): string => values.reduce((best, value) => value.length > best.length ? value : best, '');

/** Upper-bound stand-in for a summary that does not exist yet: every option, segment and repeat present. */
function placeholderSummary(question: Question, stats: SourceStats): Json {
  const base = (): Record<string, Json> => {
    const item: Record<string, Json> = { type: question.type, label: question.label, respondentCount: stats.votes, totalWeight: LONG_NUMBER };
    if (question.type === 'noul') return { ...item, mean: LONG_NUMBER, topProbability: LONG_NUMBER };
    const keys = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    item.probabilities = Object.fromEntries(keys.map((key) => [key, LONG_NUMBER]));
    item.winner = longest(keys);
    item.topProbability = LONG_NUMBER;
    item.meanConfidence = LONG_NUMBER;
    if (question.type === 'choice') item.margin = LONG_NUMBER; else item.mean = LONG_NUMBER;
    return item;
  };
  return {
    ...base(),
    bySegment: Object.fromEntries(stats.segments.map((segment) => [segment, base()])),
    byRepeat: Object.fromEntries(Array.from({ length: stats.repeats }, (_, index) => [String(index + 1), base()])),
  };
}

interface Resolved { value: Json; extraTokens: number; kind: 'responses' | 'other' }

function placeholderInput(pipeline: Pipeline, cohorts: Record<string, Cohort>, binding: PollInputBinding, personaId: string, personaSegment: string): Resolved {
  const question = resolveQuestion(pipeline.stages, binding.stage, binding.question);
  if (!question) return { value: null, extraTokens: 0, kind: 'other' };
  const stats = sourceStats(pipeline, cohorts, binding.stage);
  const select = binding.select ?? 'summary';
  const options = question.type === 'noul' ? [] : question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  if (select === 'summary') return { value: placeholderSummary(question, stats), extraTokens: 0, kind: 'other' };
  if (select === 'winner') return { value: longest(options), extraTokens: 0, kind: 'other' };
  if (select === 'mean') return { value: LONG_NUMBER, extraTokens: 0, kind: 'other' };
  if (select === 'probabilities') return { value: Object.fromEntries(options.map((key) => [key, LONG_NUMBER])), extraTokens: 0, kind: 'other' };
  const entry = voteRecord(question, longest([personaId, LONG_ID]), longest([...stats.segments, personaSegment]), stats.repeats);
  // One representative entry stands in the array; the rest is added as bytes (entry plus comma) / 3.
  const extraBytes = Math.max(0, stats.votes - 1) * (Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1);
  return { value: [entry], extraTokens: Math.ceil(extraBytes / 3), kind: 'responses' };
}

function placeholderUpstream(pipeline: Pipeline, cohorts: Record<string, Cohort>, stage: PollStage): Json {
  return stage.dependsOn.flatMap((id) => {
    const source = pipeline.stages.find((item) => item.id === id);
    if (!source) return [];
    const stats = sourceStats(pipeline, cohorts, id);
    const questions: Record<string, Question> = source.kind === 'poll' ? source.questions : (() => {
      const question = resolveQuestion(pipeline.stages, id, source.outputQuestion);
      return question ? { [source.outputQuestion]: { ...question, label: source.label } as Question } : {};
    })();
    return [{ stage: id, label: source.label, summaries: Object.fromEntries(Object.entries(questions).map(([qid, question]) => [qid, placeholderSummary(question, stats)])) } as unknown as Json];
  });
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function personaLabel(persona: Persona): string { return persona.label || persona.id; }

/**
 * Worst-case Jev request size for a poll step, before anything runs. The worst case is the largest eligible
 * persona, since the sample is chosen at run time. Upstream results that do not exist yet use upper-bound placeholders.
 */
export function estimateStageBudget(pipeline: Pipeline, cohorts: Record<string, Cohort>, stage: PollStage): StageBudget | undefined {
  const cohort = cohorts[stage.cohort];
  if (!cohort) return undefined;
  const personas = eligiblePersonas(cohort);
  if (!personas.length) return undefined;
  let worst: { persona: Persona; size: RequestSize; extra: number; parts: Array<{ name: string; tokens: number; responses?: string }> } | undefined;
  const longestId = longest(personas.map((persona) => persona.id)), longestSegment = longest(personas.map((persona) => persona.segment));
  const inputs: Record<string, Resolved> = stage.inputs === undefined ? {} : Object.fromEntries(Object.entries(stage.inputs).map(([alias, binding]) => [alias, placeholderInput(pipeline, cohorts, binding, longestId, longestSegment)]));
  const upstreamPlaceholder = stage.inputs === undefined ? placeholderUpstream(pipeline, cohorts, stage) : null;
  for (const persona of personas) {
    const state = buildPollState(pipeline, cohort, stage, persona, stage.inputs === undefined ? { upstream: upstreamPlaceholder! } : { inputs: Object.fromEntries(Object.entries(inputs).map(([alias, item]) => [alias, item.value])) });
    const extra = Object.values(inputs).reduce((sum, item) => sum + item.extraTokens, 0);
    const size = requestSize(state, stage.questions);
    if (worst && size.stateTokens + extra <= worst.size.stateTokens + worst.extra) continue;
    const parts: Array<{ name: string; tokens: number; responses?: string }> = [
      { name: `the profile of ${personaLabel(persona)} (background and details)`, tokens: tokensOf({ ...persona, attributes: undefined }) + tokensOf(persona.attributes) * 2 },
      { name: 'the shared and step context', tokens: tokensOf(pipeline.context) + tokensOf(stage.context ?? null) + tokensOf({ id: cohort.id, name: cohort.name, population: cohort.population, description: cohort.description }) },
    ];
    if (stage.inputs === undefined) parts.push({ name: 'the results from earlier steps', tokens: tokensOf(upstreamPlaceholder) });
    for (const [alias, item] of Object.entries(inputs)) {
      const binding = stage.inputs![alias]!;
      const source = pipeline.stages.find((candidate) => candidate.id === binding.stage);
      parts.push({ name: `the input "${alias}" (${item.kind === 'responses' ? 'every individual response' : `the ${binding.select ?? 'summary'}`} from ${source?.label ?? binding.stage})`, tokens: tokensOf(item.value) + item.extraTokens, ...(item.kind === 'responses' ? { responses: alias } : {}) });
    }
    parts.push({ name: 'the longest question and its options', tokens: size.longestQuestionTokens });
    worst = { persona, size, extra, parts };
  }
  const size = worst!.size, extra = worst!.extra;
  const largest = size.stateAndLongest + extra;
  const total = size.total + extra;
  const top = worst!.parts.reduce((best, part) => part.tokens > best.tokens ? part : best);
  const blocked = largest > JEV_STATE_AND_QUESTION_LIMIT || total > JEV_REQUEST_LIMIT;
  const warned = largest > JEV_STATE_AND_QUESTION_LIMIT * BUDGET_WARNING_RATIO || total > JEV_REQUEST_LIMIT * BUDGET_WARNING_RATIO;
  const over = largest > JEV_STATE_AND_QUESTION_LIMIT
    ? `its largest request is about ${fmt(largest)} tokens (persona details plus the longest question), but Jev allows ${fmt(JEV_STATE_AND_QUESTION_LIMIT)}`
    : `its largest request is about ${fmt(total)} tokens in total (persona details plus all questions), but Jev allows ${fmt(JEV_REQUEST_LIMIT)}`;
  let message: string | undefined;
  if (blocked) {
    message = `Step "${stage.label}" is too large for Jev: ${over}. The biggest part is ${top.name}, about ${fmt(top.tokens)} tokens.`;
    if (top.responses) message += ` Switch the input "${top.responses}" to its summary (the overall distribution) or split it into batches, instead of sending every individual response.`;
    else if (stage.inputs && Object.values(stage.inputs).some((b) => b.select === 'responses')) message += ' Also consider switching inputs that send individual responses to their summary.';
    else message += ' Shorten that part, or split the step.';
  } else if (warned) {
    message = `Step "${stage.label}" is close to Jev's limit: its largest request is about ${fmt(largest)} of ${fmt(JEV_STATE_AND_QUESTION_LIMIT)} tokens (${fmt(total)} of ${fmt(JEV_REQUEST_LIMIT)} in total). The biggest part is ${top.name}, about ${fmt(top.tokens)} tokens.`;
  }
  return {
    stageId: stage.id, label: stage.label,
    largestRequestTokens: largest, limit: JEV_STATE_AND_QUESTION_LIMIT,
    totalRequestTokens: total, totalLimit: JEV_REQUEST_LIMIT,
    status: blocked ? 'blocked' : warned ? 'warning' : 'ok',
    ...(message ? { message } : {}),
    largestPart: { name: top.name, tokens: top.tokens },
  };
}

export function estimateBudgets(pipeline: Pipeline, cohorts: Record<string, Cohort>, stages: Stage[]): Record<string, StageBudget> {
  const result: Record<string, StageBudget> = {};
  for (const stage of stages) {
    if (stage.kind !== 'poll') continue;
    const budget = estimateStageBudget(pipeline, cohorts, stage);
    if (budget) result[stage.id] = budget;
  }
  return result;
}

/** Throws one clear message naming every over-limit step; returns warnings for steps near the limit. */
export function enforceBudgets(budgets: Record<string, StageBudget>): string[] {
  const blocked = Object.values(budgets).filter((budget) => budget.status === 'blocked');
  if (blocked.length) throw new Error(blocked.map((budget) => budget.message!).join('\n'));
  return Object.values(budgets).filter((budget) => budget.status === 'warning').map((budget) => budget.message!);
}
