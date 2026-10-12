import type { Answer, ChooseStage, Cohort, Json, Persona, PollInputBinding, PollStage, Pipeline, Question, Stage, Vote } from './types.js';
import { respondentLookup, respondentProfile, respondentsSummary } from './respondents.js';
import { resolveQuestion } from './engine-utils.js';
import { batchedBinding, COMBINE_GUIDE, describeBatching, FINAL_CHOICE_ROLE, FINAL_COMBINE_GUIDE, FINAL_MAP_GUIDE, MAP_GUIDE, mapInput, plural, reduceInput, verdictEntry, type BatchShape } from './batching.js';

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
export function buildPollState(pipeline: Pipeline, cohort: Cohort, stage: PollStage, persona: Persona, upstream: { inputs?: Json; upstream?: Json; guide?: string; respondents?: Json }): Json {
  const state: Record<string, Json> = {
    pipelineContext: pipeline.context,
    cohort: { id: cohort.id, name: cohort.name, population: cohort.population, description: cohort.description },
    persona: persona as unknown as Json,
    sharedContext: persona.attributes,
    stageContext: stage.context ?? null,
  };
  if (upstream.inputs !== undefined) state.inputs = upstream.inputs;
  else state.upstream = upstream.upstream ?? [];
  if (upstream.inputs !== undefined && upstream.respondents !== undefined) state.respondents = upstream.respondents;
  if (upstream.guide !== undefined) state.inputGuide = upstream.guide;
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

/** Whether a request stays within the share of Jev's limits that automatic sizing aims for. */
export function fitsWithHeadroom(state: Json, questions: Record<string, Question>): boolean {
  const size = requestSize(state, questions);
  return size.stateAndLongest <= BATCH_HEADROOM * JEV_STATE_AND_QUESTION_LIMIT && size.total <= BATCH_HEADROOM * JEV_REQUEST_LIMIT;
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
  /** Mean estimated tokens of one request across the step's eligible personas (the map layer when batched); feeds the cost estimate. */
  meanRequestTokens: number;
  /** Estimated tokens of one reply: every question's answer, with its probabilities. */
  replyTokens: number;
  /** Present when a `responses` input is read in batches and then combined. */
  batching?: BatchPlan;
  /** Final choice only: how its inputs are read, in one request or in slices then combined. */
  choose?: ChoosePlan;
  /** Who answered each input (by input name, or earlier step id without named inputs): each respondent's profile with their response, or only a summary of the group. */
  respondents?: Record<string, 'profiles' | 'summary'>;
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
  if (stage.kind === 'choose') return { votes: 1, segments: [], repeats: 1 };
  const parts = stage.inputs.map((input) => sourceStats(pipeline, cohorts, input.stage, new Set(seen)));
  return { votes: parts.reduce((sum, p) => sum + p.votes, 0), segments: [...new Set(parts.flatMap((p) => p.segments))], repeats: Math.max(1, ...parts.map((p) => p.repeats)) };
}

/** Answers a step produces when it runs in full: respondents times repeats, summed through combine and decision steps. */
export function sourceAnswerCount(pipeline: Pipeline, cohorts: Record<string, Cohort>, stageId: string): number {
  return sourceStats(pipeline, cohorts, stageId).votes;
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

function placeholderInput(pipeline: Pipeline, cohorts: Record<string, Cohort>, binding: PollInputBinding, personaId: string, personaSegment: string, profile?: Json): Resolved {
  const question = resolveQuestion(pipeline.stages, binding.stage, binding.question);
  if (!question) return { value: null, extraTokens: 0, kind: 'other' };
  const stats = sourceStats(pipeline, cohorts, binding.stage);
  const select = binding.select ?? 'summary';
  const options = question.type === 'noul' ? [] : question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  if (select === 'summary') return { value: placeholderSummary(question, stats), extraTokens: 0, kind: 'other' };
  if (select === 'winner') return { value: longest(options), extraTokens: 0, kind: 'other' };
  if (select === 'mean') return { value: LONG_NUMBER, extraTokens: 0, kind: 'other' };
  if (select === 'probabilities') return { value: Object.fromEntries(options.map((key) => [key, LONG_NUMBER])), extraTokens: 0, kind: 'other' };
  const record = voteRecord(question, longest([personaId, LONG_ID]), longest([...stats.segments, personaSegment]), stats.repeats);
  const entry = profile === undefined ? record : { ...(record as Record<string, Json>), respondent: profile } as Json;
  // One representative entry stands in the array; the rest is added as bytes (entry plus comma) / 3.
  const extraBytes = Math.max(0, stats.votes - 1) * (Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1);
  return { value: [entry], extraTokens: Math.ceil(extraBytes / 3), kind: 'responses' };
}

function placeholderUpstream(pipeline: Pipeline, cohorts: Record<string, Cohort>, stage: PollStage): Json {
  return stage.dependsOn.flatMap((id) => {
    const source = pipeline.stages.find((item) => item.id === id);
    if (!source) return [];
    const stats = sourceStats(pipeline, cohorts, id);
    const questions: Record<string, Question> = source.kind === 'poll' || source.kind === 'choose' ? source.questions : (() => {
      const question = resolveQuestion(pipeline.stages, id, source.outputQuestion);
      return question ? { [source.outputQuestion]: { ...question, label: source.label } as Question } : {};
    })();
    const respondents = placeholderRespondents(pipeline, cohorts, id, Object.keys(questions));
    return [{ stage: id, label: source.label, summaries: Object.fromEntries(Object.entries(questions).map(([qid, question]) => [qid, placeholderSummary(question, stats)])), ...(respondents !== null ? { respondents } : {}) } as unknown as Json];
  });
}

/** Every cohort whose personas can answer a step, following Final result and Combine answers steps to their sources. */
function sourceCohorts(pipeline: Pipeline, cohorts: Record<string, Cohort>, stageId: string, seen = new Set<string>()): Cohort[] {
  const stage = pipeline.stages.find((item) => item.id === stageId);
  if (!stage || seen.has(stageId)) return [];
  seen.add(stageId);
  if (stage.kind === 'poll') return cohorts[stage.cohort] ? [cohorts[stage.cohort]!] : [];
  if (stage.kind === 'decision') return sourceCohorts(pipeline, cohorts, stage.from.stage, seen);
  if (stage.kind === 'choose') return [];
  return [...new Set(stage.inputs.flatMap((input) => sourceCohorts(pipeline, cohorts, input.stage, new Set(seen))))];
}

/** Stand-in for who answered a step that has not run: every eligible persona of its cohorts, with worst-case answers. */
function placeholderRespondents(pipeline: Pipeline, cohorts: Record<string, Cohort>, stageId: string, questionIds: string[]): Json {
  const sources = sourceCohorts(pipeline, cohorts, stageId);
  const answers = Object.fromEntries(questionIds.flatMap((id) => { const question = resolveQuestion(pipeline.stages, stageId, id); return question ? [[id, representativeAnswer(question) as unknown as Answer]] : []; }));
  const votes: Vote[] = sources.flatMap((cohort) => eligiblePersonas(cohort).map((persona) => ({ personaId: persona.id, cohortId: cohort.id, segment: persona.segment, repeat: 1, weight: persona.weight, answers, cacheHit: false, model: 'estimate' })));
  return respondentsSummary(votes, questionIds, respondentLookup(sources));
}

/** The largest respondent profile a step's responses could carry. */
function largestProfile(pipeline: Pipeline, cohorts: Record<string, Cohort>, stageId: string): Json | undefined {
  let best: Json | undefined, size = -1;
  for (const cohort of sourceCohorts(pipeline, cohorts, stageId)) for (const persona of eligiblePersonas(cohort)) {
    const profile = respondentProfile(persona, cohort), bytes = bytesOf(profile);
    if (bytes > size) { best = profile; size = bytes; }
  }
  return best;
}

/** Share of a Jev limit that automatic batching aims for, leaving room for estimate error. */
export const BATCH_HEADROOM = 0.85;

export interface BatchPlan extends BatchShape {
  alias: string; sourceStage: string; sourceLabel: string;
  /** Verdicts one combine request reads. */
  groupSize: number;
  explicit: boolean;
  /** Requests per persona and repeat in each layer: the map layer first, then each reduce round. */
  layerRequests: number[];
  requestsPerRun: number;
  mapLargest: number; mapTotal: number; reduceLargest: number; reduceTotal: number;
  /** Largest and total request estimates across all layers, compared with the Jev limits. */
  largest: number; total: number;
  fits: boolean;
  line: string;
}

const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');

function verdictAnswers(stage: PollStage): Record<string, Answer> {
  return Object.fromEntries(Object.entries(stage.questions).map(([id, question]) => [id, representativeAnswer(question) as unknown as Answer]));
}

/**
 * Decides how a batched `responses` input is split and combined, from the worst-case persona. Engine and review share it,
 * so the reviewed request count is the count the run uses. `others` are the step's other resolved inputs.
 */
export function planBatching(pipeline: Pipeline, cohort: Cohort, stage: PollStage, alias: string, personas: Persona[], totalResponses: number, others: Record<string, Json>, handoff: { respondents?: Json; profileBytes?: number } = {}): BatchPlan | undefined {
  const binding = stage.inputs?.[alias];
  if (!binding || binding.batch === undefined || !personas.length) return undefined;
  const question = resolveQuestion(pipeline.stages, binding.stage, binding.question);
  if (!question) return undefined;
  const source = pipeline.stages.find((item) => item.id === binding.stage);
  const stateOf = (persona: Persona, value: Json, guide: string): Json => buildPollState(pipeline, cohort, stage, persona, { inputs: { ...others, [alias]: value }, guide, ...(handoff.respondents !== undefined ? { respondents: handoff.respondents } : {}) });
  const emptyMap = (persona: Persona): RequestSize => requestSize(stateOf(persona, mapInput(totalResponses, totalResponses, totalResponses, []), MAP_GUIDE), stage.questions);
  let worst = personas[0]!, empty = emptyMap(worst);
  for (const persona of personas.slice(1)) {
    const size = emptyMap(persona);
    if (size.stateTokens > empty.stateTokens) { worst = persona; empty = size; }
  }
  const room = (size: RequestSize): number => Math.min(BATCH_HEADROOM * JEV_STATE_AND_QUESTION_LIMIT - size.stateTokens - size.longestQuestionTokens, BATCH_HEADROOM * JEV_REQUEST_LIMIT - size.stateTokens - size.allQuestionsTokens);
  // Each response may carry its respondent's profile: `,"respondent":` plus the largest profile.
  const entryBytes = bytesOf(voteRecord(question, LONG_ID, LONG_ID, 1)) + 1 + (handoff.profileBytes ? handoff.profileBytes + 15 : 0);
  const explicit = binding.batch !== 'auto';
  const wanted = binding.batch === 'auto' ? Math.max(1, Math.floor(room(empty) * 3 / entryBytes)) : Math.max(1, Math.floor(binding.batch.size));
  const batchSize = Math.max(1, Math.min(wanted, Math.max(1, totalResponses)));
  const batches = Math.max(1, Math.ceil(totalResponses / batchSize));
  const mapState = empty.stateTokens + Math.ceil(Math.min(batchSize, totalResponses) * entryBytes / 3);
  const mapLargest = mapState + empty.longestQuestionTokens, mapTotal = mapState + empty.allQuestionsTokens;

  const sample = verdictAnswers(stage);
  const verdictBytes = bytesOf(verdictEntry({ batch: totalResponses, responses: totalResponses, answers: sample })) + 1;
  const emptyReduce = requestSize(stateOf(worst, reduceInput(99, totalResponses, []), COMBINE_GUIDE), stage.questions);
  const groupSize = Math.max(2, Math.floor(room(emptyReduce) * 3 / verdictBytes));
  const layerRequests = [batches];
  let reduceRounds = 0;
  if (batches > 1) {
    let count = batches;
    while (count > groupSize) { count = Math.ceil(count / groupSize); layerRequests.push(count); reduceRounds += 1; }
    layerRequests.push(1);
    reduceRounds += 1;
  }
  const reduceState = batches > 1 ? emptyReduce.stateTokens + Math.ceil(Math.min(groupSize, batches) * verdictBytes / 3) : 0;
  const reduceLargest = batches > 1 ? reduceState + emptyReduce.longestQuestionTokens : 0;
  const reduceTotal = batches > 1 ? reduceState + emptyReduce.allQuestionsTokens : 0;
  const largest = Math.max(mapLargest, reduceLargest), total = Math.max(mapTotal, reduceTotal);
  const shape: BatchShape = { totalResponses, batchSize, batches, reduceRounds };
  return {
    ...shape, alias, sourceStage: binding.stage, sourceLabel: source?.label ?? binding.stage, groupSize, explicit, layerRequests,
    requestsPerRun: layerRequests.reduce((sum, count) => sum + count, 0),
    mapLargest, mapTotal, reduceLargest, reduceTotal, largest, total,
    fits: largest <= JEV_STATE_AND_QUESTION_LIMIT && total <= JEV_REQUEST_LIMIT,
    line: describeBatching(stage.label, source?.label ?? binding.stage, shape, 'future'),
  };
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
  const bindings = Object.entries(stage.inputs ?? {});
  const profiles = Object.fromEntries(bindings.filter(([, binding]) => binding.select === 'responses').map(([alias, binding]) => [alias, largestProfile(pipeline, cohorts, binding.stage)]));
  const summaries = Object.fromEntries(bindings.map(([alias, binding]) => [alias, placeholderRespondents(pipeline, cohorts, binding.stage, [binding.question])]).filter(([, summary]) => summary !== null)) as Record<string, Json>;
  const batched = batchedBinding(stage);
  // Same rule as the run: responses carry profiles while the largest request fits; batched responses always do.
  const profiled = new Set(Object.keys(profiles).filter((alias) => profiles[alias] !== undefined && summaries[alias] !== undefined));
  const resolveInputs = (): Record<string, Resolved> => Object.fromEntries(bindings.map(([alias, binding]) => [alias, placeholderInput(pipeline, cohorts, binding, longestId, longestSegment, profiled.has(alias) ? profiles[alias] : undefined)]));
  const respondentsState = (): Json | undefined => Object.keys(summaries).length ? Object.fromEntries(Object.entries(summaries).map(([alias, summary]) => [alias, stage.inputs![alias]!.select === 'responses' ? { ...(summary as Record<string, Json>), profiles: profiled.has(alias) ? 'with each response' : 'left out to fit the request limit' } : summary])) : undefined;
  let inputs = resolveInputs();
  const heaviest = personas.reduce((best, persona) => JSON.stringify(persona).length > JSON.stringify(best).length ? persona : best, personas[0]!);
  for (;;) {
    const unbatched = [...profiled].filter((alias) => alias !== batched?.alias);
    if (!unbatched.length) break;
    const state = buildPollState(pipeline, cohort, stage, heaviest, { inputs: Object.fromEntries(Object.entries(inputs).map(([alias, item]) => [alias, item.value])), respondents: respondentsState() });
    const extra = Object.entries(inputs).filter(([alias]) => alias !== batched?.alias).reduce((sum, [, item]) => sum + item.extraTokens, 0);
    const size = requestSize(state, stage.questions);
    if (size.stateAndLongest + extra <= BATCH_HEADROOM * JEV_STATE_AND_QUESTION_LIMIT && size.total + extra <= BATCH_HEADROOM * JEV_REQUEST_LIMIT) break;
    profiled.delete(unbatched.sort((a, b) => (inputs[b]!.extraTokens + tokensOf(inputs[b]!.value)) - (inputs[a]!.extraTokens + tokensOf(inputs[a]!.value)))[0]!);
    inputs = resolveInputs();
  }
  const respondents = respondentsState();
  const upstreamPlaceholder = stage.inputs === undefined ? placeholderUpstream(pipeline, cohorts, stage) : null;
  const respondentDetail: Record<string, 'profiles' | 'summary'> = stage.inputs === undefined
    ? Object.fromEntries((upstreamPlaceholder as Array<{ stage: string; respondents?: Json }>).filter((item) => item.respondents !== undefined).map((item) => [item.stage, 'summary' as const]))
    : Object.fromEntries(Object.keys(summaries).map((alias) => [alias, profiled.has(alias) ? 'profiles' as const : 'summary' as const]));
  let batching: BatchPlan | undefined;
  if (batched) {
    const total = sourceStats(pipeline, cohorts, batched.binding.stage).votes;
    const others = Object.fromEntries(Object.entries(inputs).filter(([alias]) => alias !== batched.alias).map(([alias, item]) => [alias, item.value]));
    const profile = profiled.has(batched.alias) ? profiles[batched.alias] : undefined;
    batching = planBatching(pipeline, cohort, stage, batched.alias, personas, total, others, { respondents, profileBytes: profile === undefined ? 0 : bytesOf(profile) });
    const original = inputs[batched.alias];
    if (batching && original) {
      // One representative entry stands in the batch; the rest of the batch is added as bytes.
      const entry = (original.value as Json[])[0];
      const extraBytes = Math.max(0, Math.min(batching.batchSize, total) - 1) * (entry === undefined ? 0 : bytesOf(entry) + 1);
      inputs[batched.alias] = { value: mapInput(1, batching.batches, total, entry === undefined ? [] : [entry]), extraTokens: Math.ceil(extraBytes / 3), kind: 'responses' };
    }
  }
  let requestTokensSum = 0;
  for (const persona of personas) {
    const state = buildPollState(pipeline, cohort, stage, persona, stage.inputs === undefined ? { upstream: upstreamPlaceholder! } : { inputs: Object.fromEntries(Object.entries(inputs).map(([alias, item]) => [alias, item.value])), ...(batching ? { guide: MAP_GUIDE } : {}), respondents });
    const extra = Object.values(inputs).reduce((sum, item) => sum + item.extraTokens, 0);
    const size = requestSize(state, stage.questions);
    requestTokensSum += size.total + extra;
    if (worst && size.stateTokens + extra <= worst.size.stateTokens + worst.extra) continue;
    const parts: Array<{ name: string; tokens: number; responses?: string }> = [
      { name: `the profile of ${personaLabel(persona)} (background and details)`, tokens: tokensOf({ ...persona, attributes: undefined }) + tokensOf(persona.attributes) * 2 },
      { name: 'the shared and step context', tokens: tokensOf(pipeline.context) + tokensOf(stage.context ?? null) + tokensOf({ id: cohort.id, name: cohort.name, population: cohort.population, description: cohort.description }) },
    ];
    if (stage.inputs === undefined) parts.push({ name: 'the results from earlier steps and who answered them', tokens: tokensOf(upstreamPlaceholder) });
    else if (respondents !== undefined) parts.push({ name: 'the summary of who answered the earlier steps', tokens: tokensOf(respondents) });
    for (const [alias, item] of Object.entries(inputs)) {
      const binding = stage.inputs![alias]!;
      const source = pipeline.stages.find((candidate) => candidate.id === binding.stage);
      parts.push({ name: `the input "${alias}" (${item.kind === 'responses' ? (batching && alias === batching.alias ? `a batch of ${fmt(batching.batchSize)} individual responses` : 'every individual response') + (profiled.has(alias) ? ' with who gave it' : '') : `the ${binding.select ?? 'summary'}`} from ${source?.label ?? binding.stage})`, tokens: tokensOf(item.value) + item.extraTokens, ...(item.kind === 'responses' ? { responses: alias } : {}) });
    }
    parts.push({ name: 'the longest question and its options', tokens: size.longestQuestionTokens });
    worst = { persona, size, extra, parts };
  }
  const size = worst!.size, extra = worst!.extra;
  const mapLargest = size.stateAndLongest + extra, mapTotal = size.total + extra;
  const combineBigger = Boolean(batching && batching.reduceLargest > mapLargest);
  const largest = combineBigger ? batching!.reduceLargest : mapLargest;
  const total = Math.max(mapTotal, batching?.reduceTotal ?? 0);
  const top = combineBigger
    ? { name: `the earlier verdicts a combining request reads (${fmt(batching!.groupSize)} at a time)`, tokens: batching!.reduceLargest - size.longestQuestionTokens, responses: undefined }
    : worst!.parts.reduce((best, part) => part.tokens > best.tokens ? part : best);
  const blocked = largest > JEV_STATE_AND_QUESTION_LIMIT || total > JEV_REQUEST_LIMIT;
  const warned = largest > JEV_STATE_AND_QUESTION_LIMIT * BUDGET_WARNING_RATIO || total > JEV_REQUEST_LIMIT * BUDGET_WARNING_RATIO;
  const over = largest > JEV_STATE_AND_QUESTION_LIMIT
    ? `its largest request is about ${fmt(largest)} tokens (persona details plus the longest question), but Jev allows ${fmt(JEV_STATE_AND_QUESTION_LIMIT)}`
    : `its largest request is about ${fmt(total)} tokens in total (persona details plus all questions), but Jev allows ${fmt(JEV_REQUEST_LIMIT)}`;
  let message: string | undefined;
  if (blocked) {
    message = `Step "${stage.label}" is too large for Jev: ${over}. The biggest part is ${top.name}, about ${fmt(top.tokens)} tokens.`;
    if (batching && top.responses) message += ` The input "${top.responses}" is already read in batches of ${fmt(batching.batchSize)}; lower the batch size or set it to Auto.`;
    else if (batching) message += ' Shorten that part or the questions, since the combining requests cannot be split further.';
    else if (top.responses) message += ` Switch the input "${top.responses}" to its summary (the overall distribution) or split it into batches, instead of sending every individual response.`;
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
    meanRequestTokens: Math.ceil(requestTokensSum / personas.length),
    replyTokens: Object.values(stage.questions).reduce((sum, question) => sum + tokensOf(representativeAnswer(question)), 0),
    ...(batching ? { batching } : {}),
    ...(Object.keys(respondentDetail).length ? { respondents: respondentDetail } : {}),
  };
}

/**
 * Observed TypeSafe billing for jev-1.13.0 in October 2026: $1.30 for 33.55M tokens (input and output together).
 * TypeSafe does not publish per-token prices, so input and output share this blended rate; update it when they do.
 */
export const JEV_USD_PER_MILLION_TOKENS = 0.039;
/** Real runs bill about 1.2 to 1.6 times the bytes/3 request estimate (Jev's own prompt and tokenizer) and about 0.8 to 1.7 times the reply estimate. */
const BILLED_INPUT_RATIO = 1.4;
const BILLED_OUTPUT_RATIO = 1.1;

export interface UsageEstimate { inputTokens: number; outputTokens: number }
export interface CostEstimate extends UsageEstimate { usd: number; usdPerMillionTokens: number }

/** Billed tokens for one step: `runs` is respondents times repeats; batched steps add their combining requests. */
export function estimateStageUsage(budget: StageBudget, runs: number): UsageEstimate {
  const layers = budget.batching?.layerRequests ?? budget.choose?.layerRequests ?? [1];
  const combining = layers.slice(1).reduce((sum, count) => sum + count, 0);
  const input = runs * (layers[0]! * budget.meanRequestTokens + combining * (budget.batching?.reduceTotal ?? budget.choose?.reduceTotal ?? 0));
  const output = runs * (layers[0]! + combining) * budget.replyTokens;
  return { inputTokens: Math.ceil(input * BILLED_INPUT_RATIO), outputTokens: Math.ceil(output * BILLED_OUTPUT_RATIO) };
}

export function costOf(usage: UsageEstimate[]): CostEstimate {
  const inputTokens = usage.reduce((sum, item) => sum + item.inputTokens, 0);
  const outputTokens = usage.reduce((sum, item) => sum + item.outputTokens, 0);
  return { inputTokens, outputTokens, usd: ((inputTokens + outputTokens) / 1_000_000) * JEV_USD_PER_MILLION_TOKENS, usdPerMillionTokens: JEV_USD_PER_MILLION_TOKENS };
}

export function estimateBudgets(pipeline: Pipeline, cohorts: Record<string, Cohort>, stages: Stage[]): Record<string, StageBudget> {
  const result: Record<string, StageBudget> = {};
  for (const stage of stages) {
    if (stage.kind === 'choose') { result[stage.id] = estimateChooseBudget(pipeline, cohorts, stage); continue; }
    if (stage.kind !== 'poll') continue;
    const budget = estimateStageBudget(pipeline, cohorts, stage);
    if (budget) result[stage.id] = budget;
  }
  return result;
}

/** The state a final choice sends: no persona, just the study, the step, what each input is, and the inputs. */
export function buildChooseState(pipeline: Pipeline, stage: ChooseStage, parts: { inputs: Json; guide?: string; respondents?: Json }): Json {
  const sources = Object.fromEntries(Object.entries(stage.inputs).map(([alias, binding]) => {
    const source = pipeline.stages.find((item) => item.id === binding.stage);
    const question = resolveQuestion(pipeline.stages, binding.stage, binding.question);
    return [alias, { step: source?.label ?? binding.stage, question: question?.label ?? binding.question, reads: CHOOSE_READS[binding.select ?? 'summary'] }];
  }));
  const state: Record<string, Json> = { pipelineContext: pipeline.context, stageContext: stage.context ?? null, role: FINAL_CHOICE_ROLE, sources, inputs: parts.inputs };
  if (parts.respondents !== undefined) state.respondents = parts.respondents;
  if (parts.guide !== undefined) state.inputGuide = parts.guide;
  return state;
}
const CHOOSE_READS: Record<string, string> = { summary: 'the weighted summary of answers', responses: 'every individual answer', winner: 'the leading option', mean: 'the weighted mean', probabilities: 'the weighted distribution' };

/** One input of a final choice as the planner sees it: a whole value, or individual responses that can be split. */
export interface ChooseInput { alias: string; sourceLabel: string; value: Json; responses?: { count: number; entryBytes: number } }
export interface ChoosePart { alias: string; sourceLabel: string; totalResponses: number; batchSize: number; batches: number }
export interface ChoosePlan {
  /** Inputs read in slices; empty when everything fits one request. */
  parts: ChoosePart[];
  totalResponses: number; mapRequests: number; groupSize: number; reduceRounds: number;
  /** Requests in each layer: one request, or the slices first, then each combining round. */
  layerRequests: number[]; requestsPerRun: number;
  largest: number; total: number; fits: boolean;
  /** Average first-layer request and one combining request, in tokens, for the cost estimate. */
  meanRequestTokens: number; reduceTotal: number;
  /** Present when it cannot fit: why, in plain words. */
  problem?: string;
  line: string;
}

/** The key the combining requests use for earlier verdicts, clear of the step's own input names. */
export function verdictKey(stage: ChooseStage): string {
  let key = 'combine', n = 2;
  while (Object.hasOwn(stage.inputs, key)) key = `combine_${n++}`;
  return key;
}

/**
 * How a final choice reads its inputs: in one request when everything fits, otherwise map-reduce. Each input that
 * carries individual responses is read in slices next to the step's other (whole) inputs, then the verdicts are
 * combined in rounds until one answer remains. Engine and review share it, so the reviewed count is the run's count.
 */
export function planChoose(pipeline: Pipeline, stage: ChooseStage, inputs: ChooseInput[], respondents?: Json): ChoosePlan {
  const whole = Object.fromEntries(inputs.filter((item) => !item.responses?.count).map((item) => [item.alias, item.value]));
  const split = inputs.filter((item) => item.responses?.count);
  const stateOf = (value: Record<string, Json>, guide?: string): Json => buildChooseState(pipeline, stage, { inputs: value, ...(guide ? { guide } : {}), ...(respondents !== undefined ? { respondents } : {}) });
  const room = (size: RequestSize): number => Math.min(BATCH_HEADROOM * JEV_STATE_AND_QUESTION_LIMIT - size.stateTokens - size.longestQuestionTokens, BATCH_HEADROOM * JEV_REQUEST_LIMIT - size.stateTokens - size.allQuestionsTokens);
  const missingTokens = (item: ChooseInput): number => Math.ceil(Math.max(0, item.responses!.count - (Array.isArray(item.value) ? item.value.length : 0)) * (item.responses!.entryBytes + 1) / 3);
  const full = requestSize(stateOf({ ...whole, ...Object.fromEntries(split.map((item) => [item.alias, item.value])) }), stage.questions);
  const fullExtra = split.reduce((sum, item) => sum + missingTokens(item), 0);
  const totalResponses = split.reduce((sum, item) => sum + item.responses!.count, 0);
  const fullLargest = full.stateAndLongest + fullExtra, fullTotal = full.total + fullExtra;
  const one = (fits: boolean, problem?: string): ChoosePlan => ({
    parts: [], totalResponses, mapRequests: 1, groupSize: 0, reduceRounds: 0, layerRequests: [1], requestsPerRun: 1,
    largest: fullLargest, total: fullTotal, fits, meanRequestTokens: fullTotal, reduceTotal: 0, ...(problem ? { problem } : {}),
    line: `${stage.label} reads ${inputs.length === 1 ? 'its input' : `all ${inputs.length} inputs`} in one request`,
  });
  if (fullLargest <= BATCH_HEADROOM * JEV_STATE_AND_QUESTION_LIMIT && fullTotal <= BATCH_HEADROOM * JEV_REQUEST_LIMIT) return one(true);
  if (!split.length) return one(fullLargest <= JEV_STATE_AND_QUESTION_LIMIT && fullTotal <= JEV_REQUEST_LIMIT, 'its inputs are summaries, which cannot be read in slices; read fewer outputs or shorten the questions');

  const parts: ChoosePart[] = [];
  let mapLargest = 0, mapTotal = 0, mapSum = 0, blocked: string | undefined;
  for (const item of split) {
    const count = item.responses!.count, entry = item.responses!.entryBytes + 1;
    const empty = requestSize(stateOf({ ...whole, [item.alias]: mapInput(count, count, count, []) }, FINAL_MAP_GUIDE), stage.questions);
    const batchSize = Math.min(count, Math.floor(room(empty) * 3 / entry));
    if (batchSize < 1) { blocked ??= `the other inputs leave no room to read "${item.alias}" from ${item.sourceLabel}`; parts.push({ alias: item.alias, sourceLabel: item.sourceLabel, totalResponses: count, batchSize: 1, batches: count }); continue; }
    const batches = Math.ceil(count / batchSize);
    const state = empty.stateTokens + Math.ceil(batchSize * entry / 3);
    mapLargest = Math.max(mapLargest, state + empty.longestQuestionTokens);
    mapTotal = Math.max(mapTotal, state + empty.allQuestionsTokens);
    mapSum += batches * (empty.stateTokens + empty.allQuestionsTokens) + Math.ceil(count * entry / 3);
    parts.push({ alias: item.alias, sourceLabel: item.sourceLabel, totalResponses: count, batchSize, batches });
  }
  const mapRequests = parts.reduce((sum, part) => sum + part.batches, 0);
  const sample = Object.fromEntries(Object.entries(stage.questions).map(([id, question]) => [id, representativeAnswer(question) as unknown as Answer]));
  const longestAlias = split.map((item) => item.alias).reduce((best, alias) => alias.length > best.length ? alias : best, '');
  const verdictBytes = bytesOf(verdictEntry({ input: longestAlias, batch: totalResponses, responses: totalResponses, answers: sample })) + 1;
  const emptyReduce = requestSize(stateOf({ ...whole, [verdictKey(stage)]: reduceInput(99, totalResponses, []) }, FINAL_COMBINE_GUIDE), stage.questions);
  const groupSize = Math.max(2, Math.floor(room(emptyReduce) * 3 / verdictBytes));
  const layerRequests = [mapRequests];
  let reduceRounds = 0;
  if (mapRequests > 1) {
    let count = mapRequests;
    while (count > groupSize) { count = Math.ceil(count / groupSize); layerRequests.push(count); reduceRounds += 1; }
    layerRequests.push(1);
    reduceRounds += 1;
  }
  const reduceState = mapRequests > 1 ? emptyReduce.stateTokens + Math.ceil(Math.min(groupSize, mapRequests) * verdictBytes / 3) : 0;
  const largest = Math.max(mapLargest, mapRequests > 1 ? reduceState + emptyReduce.longestQuestionTokens : 0);
  const total = Math.max(mapTotal, mapRequests > 1 ? reduceState + emptyReduce.allQuestionsTokens : 0);
  const fits = !blocked && largest <= JEV_STATE_AND_QUESTION_LIMIT && total <= JEV_REQUEST_LIMIT;
  const reads = parts.map((part) => `${plural(part.totalResponses, 'response')} from ${part.sourceLabel}`).join(' and ');
  return {
    parts, totalResponses, mapRequests, groupSize, reduceRounds, layerRequests, requestsPerRun: layerRequests.reduce((sum, count) => sum + count, 0),
    largest, total, fits, meanRequestTokens: Math.ceil(mapSum / Math.max(1, mapRequests)), reduceTotal: mapRequests > 1 ? reduceState + emptyReduce.allQuestionsTokens : 0, ...(blocked ? { problem: blocked } : !fits ? { problem: 'even one slice or one combining request is over the limit; read summaries instead of every answer, or shorten the questions' } : {}),
    line: `${stage.label} reads ${reads} in ${plural(mapRequests, 'batch', 'batches')}${mapRequests > 1 ? `, then combines them in ${plural(reduceRounds, 'round')}` : ''}`,
  };
}

/** Bytes of one individual response to this question as the review sizes it, with the longest ids and numbers. */
export function responseEntryBytes(question: Question): number { return bytesOf(voteRecord(question, LONG_ID, LONG_ID, 1)); }

/** Review-time estimate for a final choice: upper-bound placeholders for outputs that do not exist yet. */
export function estimateChooseBudget(pipeline: Pipeline, cohorts: Record<string, Cohort>, stage: ChooseStage): StageBudget {
  const items: ChooseInput[] = Object.entries(stage.inputs).map(([alias, binding]) => {
    const source = pipeline.stages.find((item) => item.id === binding.stage);
    const placeholder = placeholderInput(pipeline, cohorts, binding, LONG_ID, LONG_ID);
    const sourceLabel = source?.label ?? binding.stage;
    if (placeholder.kind !== 'responses') return { alias, sourceLabel, value: placeholder.value };
    const entry = (placeholder.value as Json[])[0];
    return { alias, sourceLabel, value: placeholder.value, responses: { count: sourceStats(pipeline, cohorts, binding.stage).votes, entryBytes: entry === undefined ? 0 : bytesOf(entry) } };
  });
  const summaries = Object.fromEntries(Object.entries(stage.inputs).map(([alias, binding]) => [alias, placeholderRespondents(pipeline, cohorts, binding.stage, [binding.question])]).filter(([, summary]) => summary !== null)) as Record<string, Json>;
  const respondents = Object.keys(summaries).length ? summaries as Json : undefined;
  const plan = planChoose(pipeline, stage, items, respondents);
  const blocked = !plan.fits;
  // Slices are sized to fill each request on purpose, so only an unsplit request near the limit is worth a warning.
  const warned = !plan.parts.length && (plan.largest > JEV_STATE_AND_QUESTION_LIMIT * BUDGET_WARNING_RATIO || plan.total > JEV_REQUEST_LIMIT * BUDGET_WARNING_RATIO);
  const top = items.map((item) => ({ name: `the input "${item.alias}" from ${item.sourceLabel}`, tokens: tokensOf(item.value) + (item.responses ? Math.ceil(Math.max(0, item.responses.count - 1) * (item.responses.entryBytes + 1) / 3) : 0) })).reduce((best, part) => part.tokens > best.tokens ? part : best, { name: 'the step context', tokens: tokensOf(stage.context ?? null) });
  const message = blocked
    ? `Step "${stage.label}" is too large for Jev: ${plan.problem ?? 'its largest request is over the limit'}. The biggest part is ${top.name}, about ${fmt(top.tokens)} tokens.`
    : warned ? `Step "${stage.label}" is close to Jev's limit: its largest request is about ${fmt(plan.largest)} of ${fmt(JEV_STATE_AND_QUESTION_LIMIT)} tokens.` : undefined;
  return {
    stageId: stage.id, label: stage.label,
    largestRequestTokens: plan.largest, limit: JEV_STATE_AND_QUESTION_LIMIT,
    totalRequestTokens: plan.total, totalLimit: JEV_REQUEST_LIMIT,
    status: blocked ? 'blocked' : warned ? 'warning' : 'ok',
    ...(message ? { message } : {}),
    largestPart: top,
    meanRequestTokens: plan.meanRequestTokens,
    replyTokens: Object.values(stage.questions).reduce((sum, question) => sum + tokensOf(representativeAnswer(question)), 0),
    choose: plan,
  };
}

/** Throws one clear message naming every over-limit step; returns warnings for steps near the limit. */
export function enforceBudgets(budgets: Record<string, StageBudget>): string[] {
  const blocked = Object.values(budgets).filter((budget) => budget.status === 'blocked');
  if (blocked.length) throw new Error(blocked.map((budget) => budget.message!).join('\n'));
  return Object.values(budgets).filter((budget) => budget.status === 'warning').map((budget) => budget.message!);
}
