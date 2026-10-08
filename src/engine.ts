import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Answer, ChoiceQuestion, Cohort, Condition, Evaluation, EvaluationRequest, Json, Pipeline, PollInputBinding,
  Question, QuestionSummary, RunOptions, RunRecord, Stage, StageResult, Vote,
} from './types.js';
import { summarizeVotes } from './analysis.js';
import { ProviderError, type ProviderResponseIssue } from './provider.js';
import { validateClassifierAnswer } from './gliner-provider.js';
import { inputSelectCompatible } from './schema.js';
import { errorMessage, hashValue, isFiniteProbability, seededRandom, stableStringify } from './engine-utils.js';

interface CacheEntry { version: 1; key: string; request: EvaluationRequest; evaluation: Evaluation }

class RequestLimiter {
  private active = 0;
  private queue: Array<() => void> = [];
  private used = 0;
  constructor(private readonly concurrency: number, private readonly maximum: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      if (this.used >= this.maximum) throw new RequestLimitError();
      this.used += 1;
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active -= 1;
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.concurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
}

class RequestLimitError extends Error {}
class InvalidEvaluationError extends Error {}

export function validateEvaluation(evaluation: Evaluation, questions: Record<string, Question>): void {
  if (!evaluation || typeof evaluation !== 'object' || !evaluation.answers || typeof evaluation.answers !== 'object') {
    throw new Error('provider response has no answer map');
  }
  const expectedIds = Object.keys(questions).sort();
  const actualIds = Object.keys(evaluation.answers).sort();
  if (expectedIds.length !== actualIds.length || expectedIds.some((key, index) => key !== actualIds[index])) {
    throw new Error('provider response answer ids do not match requested questions');
  }
  for (const [id, question] of Object.entries(questions)) {
    const answer = evaluation.answers[id] as Answer | undefined;
    if (!answer || typeof answer !== 'object' || answer.type !== question.type) {
      throw new Error(`provider answer '${id}' has the wrong type`);
    }
    if (answer.classifier || evaluation.usage?.tokenUsage === 'unreported') validateClassifierAnswer(answer, question);
    if (question.type === 'noul' && answer.type === 'noul') {
      if (!isFiniteProbability(answer.noul)) throw new Error(`provider answer '${id}' has an invalid noul probability`);
    } else if (question.type === 'choice' && answer.type === 'choice') {
      const keys = Object.keys((question as ChoiceQuestion).criteria).sort();
      const probabilityKeys = Object.keys(answer.probabilities ?? {}).sort();
      if (keys.length < 2 || keys.length !== probabilityKeys.length || keys.some((key, i) => key !== probabilityKeys[i])) {
        throw new Error(`provider answer '${id}' has an invalid choice distribution`);
      }
      validateDistribution(id, answer.probabilities);
      if (!keys.includes(answer.choice)) throw new Error(`provider answer '${id}' selected an unknown choice`);
      const max = Math.max(...Object.values(answer.probabilities));
      if (answer.probabilities[answer.choice]! < max - 1e-8) throw new Error(`provider answer '${id}' choice is not a most likely option`);
      if (!answer.classifier && (typeof answer.confidence !== 'number' || !isFiniteProbability(answer.confidence))) throw new Error(`provider answer '${id}' has invalid confidence`);
    } else if (question.type === 'score' && answer.type === 'score') {
      const size = question.criteria.length;
      const expected = Array.from({ length: size }, (_, i) => String(i));
      const probabilityKeys = Object.keys(answer.probabilities ?? {}).sort((a, b) => Number(a) - Number(b));
      if (size < 2 || probabilityKeys.length !== size || expected.some((key, i) => probabilityKeys[i] !== key)) {
        throw new Error(`provider answer '${id}' has an invalid score distribution`);
      }
      validateDistribution(id, answer.probabilities);
      if (!Number.isFinite(answer.score) || answer.score < 0 || answer.score > size - 1) {
        throw new Error(`provider answer '${id}' has an invalid score`);
      }
      if (!answer.classifier && (typeof answer.confidence !== 'number' || !isFiniteProbability(answer.confidence))) throw new Error(`provider answer '${id}' has invalid confidence`);
      const expectedLegend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
      if (!answer.legend || typeof answer.legend !== 'object' || Array.isArray(answer.legend) ||
          Object.keys(answer.legend).length !== size || expected.some((key) => answer.legend[key] !== expectedLegend[key])) {
        throw new Error(`provider answer '${id}' has an invalid score legend`);
      }
      const expectedScore = expected.reduce((sum, key, index) => sum + answer.probabilities[key]! * index, 0);
      if (Math.abs(answer.score - expectedScore) > 0.0101) throw new Error(`provider answer '${id}' score does not match its distribution`);
    }
  }
  if (typeof evaluation.model !== 'string' || !evaluation.model.trim()) throw new Error('provider response has no model name');
  if (!evaluation.usage || !Number.isFinite(evaluation.usage.inputTokens) || evaluation.usage.inputTokens < 0 ||
      !Number.isFinite(evaluation.usage.outputTokens) || evaluation.usage.outputTokens < 0) {
    throw new Error('provider response has invalid usage');
  }
  if (evaluation.usage.measuredInputTokens !== undefined && (!Number.isSafeInteger(evaluation.usage.measuredInputTokens) || evaluation.usage.measuredInputTokens < 0)) throw new Error('provider response has invalid measured tokenizer usage');
}

function validateDistribution(id: string, probabilities: Record<string, number>): void {
  if (!probabilities || Object.values(probabilities).some((value) => !isFiniteProbability(value))) {
    throw new Error(`provider answer '${id}' contains an invalid probability`);
  }
  const sum = Object.values(probabilities).reduce((total, value) => total + value, 0);
  if (Math.abs(sum - 1) > 1e-5) throw new Error(`provider answer '${id}' probabilities do not sum to one`);
}

function pickCohort(cohortId: string, cohorts: Record<string, Cohort>): Cohort | undefined {
  return cohorts[cohortId] ?? Object.values(cohorts).find((cohort) => cohort.id === cohortId);
}

function eligiblePersonaCount(cohort: Cohort): number {
  const eligible = new Set(cohort.segments.filter((segment) => segment.weight > 0).map((segment) => segment.id));
  return cohort.personas.filter((persona) => eligible.has(persona.segment)).length;
}

function stageOrder(stages: Stage[]): Stage[] {
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  if (byId.size !== stages.length) throw new Error('pipeline contains duplicate stage ids');
  for (const stage of stages) {
    for (const dependency of stage.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`stage '${stage.id}' depends on unknown stage '${dependency}'`);
      if (dependency === stage.id) throw new Error(`stage '${stage.id}' cannot depend on itself`);
    }
  }
  const remaining = new Map(stages.map((stage) => [stage.id, new Set(stage.dependsOn)]));
  const ordered: Stage[] = [];
  while (remaining.size) {
    const ready = stages.filter((stage) => remaining.get(stage.id)?.size === 0 && !ordered.includes(stage));
    if (!ready.length) throw new Error('pipeline stage dependencies contain a cycle');
    for (const stage of ready) {
      ordered.push(stage);
      remaining.delete(stage.id);
      for (const deps of remaining.values()) deps.delete(stage.id);
    }
  }
  return ordered;
}

function allocateBySegment(cohort: Cohort, requestedSize: number, seed: string): Map<string, Cohort['personas']> {
  const peopleBySegment = new Map<string, Cohort['personas']>();
  for (const segment of cohort.segments) peopleBySegment.set(segment.id, []);
  for (const persona of cohort.personas) {
    const list = peopleBySegment.get(persona.segment);
    if (list) list.push(persona);
  }
  const positive = cohort.segments.filter((segment) => segment.weight > 0);
  const unsupported = positive.find((segment) => (peopleBySegment.get(segment.id)?.length ?? 0) === 0);
  if (unsupported) throw new Error(`positive-weight segment '${unsupported.id}' has no personas`);
  const active = positive;
  if (!active.length) throw new Error(`cohort '${cohort.id}' has no personas in positive-weight segments`);
  const activeCount = active.reduce((sum, segment) => sum + (peopleBySegment.get(segment.id)?.length ?? 0), 0);
  if (requestedSize > activeCount) throw new Error(`requested sample size ${requestedSize} exceeds positive-weight cohort size ${activeCount}`);
  if (requestedSize < active.length) {
    throw new Error(`sample size ${requestedSize} cannot represent all ${active.length} positive-weight segments`);
  }

  const size = requestedSize;
  const random = seededRandom(seed);
  const shuffled = new Map<string, Cohort['personas']>();
  for (const segment of active) {
    const list = [...(peopleBySegment.get(segment.id) ?? [])];
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    shuffled.set(segment.id, list);
  }
  const segmentWeightSum = active.reduce((sum, segment) => sum + segment.weight, 0);
  const counts = new Map(active.map((segment) => [segment.id, 1]));
  let assigned = active.length;
  while (assigned < size) {
    const candidates = active.filter((segment) => counts.get(segment.id)! < shuffled.get(segment.id)!.length);
    if (!candidates.length) break;
    const candidate = candidates.reduce((best, segment) => {
      const ideal = (size * segment.weight) / segmentWeightSum;
      const deficit = ideal - counts.get(segment.id)!;
      const bestDeficit = idealFor(best) - counts.get(best.id)!;
      return deficit > bestDeficit ? segment : best;
    }, candidates[0]!);
    counts.set(candidate.id, counts.get(candidate.id)! + 1);
    assigned += 1;
    function idealFor(segment: Cohort['segments'][number]): number { return (size * segment.weight) / segmentWeightSum; }
  }
  return new Map(active.map((segment) => [segment.id, shuffled.get(segment.id)!.slice(0, counts.get(segment.id)!)]));
}

export function selectPersonas(cohort: Cohort, size: number, seed: string): Cohort['personas'] {
  return [...allocateBySegment(cohort, size, seed).values()].flat();
}

function conditionResult(condition: Condition | undefined, summaries: Record<string, Record<string, QuestionSummary>>): boolean | undefined {
  if (!condition) return true;
  if ('all' in condition) {
    const values = condition.all.map((child) => conditionResult(child, summaries));
    if (values.includes(false)) return false;
    return values.includes(undefined) ? undefined : true;
  }
  if ('any' in condition) {
    const values = condition.any.map((child) => conditionResult(child, summaries));
    if (values.includes(true)) return true;
    return values.includes(undefined) ? undefined : false;
  }
  if ('not' in condition) {
    const value = conditionResult(condition.not, summaries);
    return value === undefined ? undefined : !value;
  }
  const metric = summaries[condition.stage]?.[condition.question];
  if (!metric) return undefined;
  const actual = condition.metric === 'winner' ? metric.winner : metric[condition.metric];
  if (actual === undefined) return undefined;
  if (condition.op === 'eq') return actual === condition.value;
  if (condition.op === 'ne') return actual !== condition.value;
  if (typeof actual !== 'number' || typeof condition.value !== 'number') return false;
  if (condition.op === 'gt') return actual > condition.value;
  if (condition.op === 'gte') return actual >= condition.value;
  if (condition.op === 'lt') return actual < condition.value;
  return actual <= condition.value;
}

async function loadCached(cacheDir: string, key: string, request: EvaluationRequest, questions: Record<string, Question>): Promise<Evaluation | undefined> {
  const path = join(cacheDir, `${key}.json`);
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as CacheEntry;
    if (parsed.version !== 1 || parsed.key !== key || JSON.stringify(parsed.request) !== JSON.stringify(request)) return undefined;
    validateEvaluation(parsed.evaluation, questions);
    return parsed.evaluation;
  } catch { return undefined; }
}

async function saveCached(cacheDir: string, key: string, request: EvaluationRequest, evaluation: Evaluation): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const destination = join(cacheDir, `${key}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, key, request, evaluation } satisfies CacheEntry), { mode: 0o600, flag: 'wx' });
  await rename(temporary, destination);
}

export async function runPipeline(pipeline: Pipeline, cohorts: Record<string, Cohort>, options: RunOptions): Promise<RunRecord> {
  const order = stageOrder(pipeline.stages);
  validateExecutionGraph(pipeline, order);
  for (const [key, value] of Object.entries(cohorts)) {
    if (!value || !Array.isArray(value.personas)) throw new Error(`invalid cohort '${key}'`);
  }
  const concurrency = Number.isInteger(options.concurrency) && options.concurrency > 0 ? options.concurrency : 0;
  if (!concurrency) throw new Error('concurrency must be a positive integer');
  const maximum = options.maxRequests ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(maximum) || maximum < 0) throw new Error('maxRequests must be a non-negative integer');
  const limiter = new RequestLimiter(concurrency, maximum);
  const createdAt = new Date().toISOString();
  const pipelineHash = hashValue(pipeline);
  const stages: Record<string, StageResult> = {};
  const usage: RunRecord['usage'] = { inputTokens: 0, outputTokens: 0, requests: 0, cacheHits: 0, ...(options.provider.name === 'gliner' ? { tokenUsage: 'unreported' as const } : {}) };
  const warnings: string[] = [];
  if (options.provider.name === 'gliner') warnings.push('GLiNER local classifier: distributions are relative normalized independent sigmoid label scores, not calibrated probabilities or human observations. Native scores and logits are retained in each answer; confidence and token billing are unreported. Repeats are deterministic with this model.');
  let pending = new Set(order.map((stage) => stage.id));

  const runStage = async (stage: Stage): Promise<StageResult> => {
    const startedAt = new Date().toISOString();
    const dependencies = stage.dependsOn.map((id) => stages[id]!);
    const join = (stage as Stage & { join?: 'all' | 'any' }).join ?? 'all';
    const upstream = dependencies.filter((item) => item.status === 'completed');
    if ((join === 'all' && upstream.length !== dependencies.length) || (join === 'any' && dependencies.length > 0 && upstream.length === 0)) {
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'skipped', reason: 'required upstream stages did not complete', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    }
    if (conditionResult(stage.when, stagesToSummaries(Object.values(stages))) !== true) {
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'skipped', reason: 'stage condition was false', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    }

    if (stage.kind === 'poll') {
      const cohort = pickCohort(stage.cohort, cohorts);
      if (!cohort) return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: `cohort '${stage.cohort}' was not provided`, dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
      const requestedSize = options.size ?? stage.size ?? eligiblePersonaCount(cohort);
      const repeats = options.repeats ?? stage.repeats ?? 1;
      if (!Number.isInteger(requestedSize) || requestedSize < 1 || !Number.isInteger(repeats) || repeats < 1) {
        return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: 'sample size and repeats must be positive integers', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
      }
      let selected: Map<string, Cohort['personas']>;
      try { selected = allocateBySegment(cohort, requestedSize, `${options.seed}:${stage.id}:sample`); }
      catch (error) {
        return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: errorMessage(error), dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
      }
      const segmentWeights = new Map(cohort.segments.map((segment) => [segment.id, segment.weight]));
      const totalSegmentWeight = [...selected.keys()].reduce((sum, id) => sum + (segmentWeights.get(id) ?? 0), 0);
      const jobs = [...selected.entries()].flatMap(([segmentId, personas]) => {
        const populationWeight = (segmentWeights.get(segmentId) ?? 0) / totalSegmentWeight;
        const selectedWeight = personas.reduce((sum, persona) => sum + persona.weight, 0);
        return personas.flatMap((persona) => Array.from({ length: repeats }, (_, index) => ({
          persona, segmentId, repeat: index + 1,
          weight: populationWeight * (persona.weight / selectedWeight) / repeats,
        })));
      });
      for (const job of jobs) options.onMemberProgress?.({ stage: stage.id, personaId: job.persona.id, label: job.persona.label, segment: job.segmentId, age: job.persona.age, repeat: job.repeat, status: 'queued' });
      const votes: Vote[] = [];
      let done = 0;
      const failures: string[] = [];
      const perStageConcurrency = Math.max(1, Math.min(concurrency, jobs.length));
      let cursor = 0;
      const workers = Array.from({ length: perStageConcurrency }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++]!;
          const member = { stage: stage.id, personaId: job.persona.id, label: job.persona.label, segment: job.segmentId, age: job.persona.age, repeat: job.repeat };
          options.onMemberProgress?.({ ...member, status: 'running' });
          const requestSeed = `${options.seed}:${stage.id}:${job.persona.id}:${job.repeat}`;
          const state: Record<string, Json> = {
            pipelineContext: pipeline.context,
            cohort: { id: cohort.id, name: cohort.name, population: cohort.population, description: cohort.description },
            persona: job.persona as unknown as Json,
            sharedContext: job.persona.attributes,
            stageContext: stage.context ?? null,
          };
          if (stage.inputs !== undefined) state.inputs = resolvePollInputs(stage.inputs, stages);
          else state.upstream = upstream.map((item) => ({ stage: item.id, label: item.label, summaries: item.summaries })) as unknown as Json;
          const request: EvaluationRequest = {
            model: options.model,
            seed: requestSeed,
            state: state as Json,
            questions: questionsForSeed(stage.questions, requestSeed),
          };
          const requestKey = hashValue({ version: 1, provider: options.provider.name, ...(options.provider.cacheIdentity ? { providerIdentity: options.provider.cacheIdentity } : {}), request });
          try {
            let evaluation = options.cacheDir && !options.refresh ? await loadCached(options.cacheDir, requestKey, request, request.questions) : undefined;
            let cacheHit = Boolean(evaluation);
            if (evaluation) usage.cacheHits += 1;
            else {
              evaluation = await limiter.run(async () => {
                if (usage.requests >= maximum) throw new RequestLimitError();
                usage.requests += 1;
                const result = await options.provider.evaluate(request);
                try { validateEvaluation(result, request.questions); }
                catch { throw new InvalidEvaluationError(); }
                usage.inputTokens += result.usage.inputTokens;
                usage.outputTokens += result.usage.outputTokens;
                if (result.usage.measuredInputTokens !== undefined) usage.measuredInputTokens = (usage.measuredInputTokens ?? 0) + result.usage.measuredInputTokens;
                if (options.cacheDir) await saveCached(options.cacheDir, requestKey, request, result);
                return result;
              });
            }
            votes.push({ personaId: job.persona.id, cohortId: cohort.id, segment: job.segmentId, repeat: job.repeat, weight: job.weight, answers: evaluation.answers, cacheHit, model: evaluation.model });
            options.onMemberProgress?.({ ...member, status: 'completed', answers: evaluation.answers, model: evaluation.model, cacheHit });
          } catch (error) {
            const reason = safeRequestFailure(error);
            failures.push(`${job.persona.id} (repeat ${job.repeat}): ${reason}`);
            options.onMemberProgress?.({ ...member, status: 'failed', reason });
          } finally {
            done += 1;
            options.onProgress?.({ stage: stage.id, completed: done, total: jobs.length });
          }
        }
      });
      await Promise.all(workers);
      votes.sort(compareVotes);
      const summaries = failures.length ? {} : summarizeVotes(stage.questions, votes);
      const status = failures.length ? 'failed' : 'completed';
      const reason = failures.length ? `${failures.length} of ${jobs.length} persona requests failed: ${failures.join(', ')}` : undefined;
      return { id: stage.id, kind: stage.kind, label: stage.label, status, ...(reason ? { reason } : {}), dependsOn: stage.dependsOn, votes, summaries, startedAt, finishedAt: new Date().toISOString() };
    }

    if (stage.kind === 'decision') {
      const source = stages[stage.from.stage];
      const sourceSummary = source?.summaries[stage.from.question];
      if (!source || !sourceSummary || source.status !== 'completed') {
        return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: 'decision source summary is unavailable', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
      }
      const votes = source.votes.filter((vote) => vote.answers[stage.from.question]).map((vote) => ({ ...vote, answers: { [stage.outputQuestion]: vote.answers[stage.from.question]! } }));
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'completed', dependsOn: stage.dependsOn, votes, summaries: { [stage.outputQuestion]: { ...sourceSummary, label: stage.label } }, startedAt, finishedAt: new Date().toISOString() };
    }

    const inputs = stage.inputs.map((input) => ({ input, result: stages[input.stage] })).filter((entry) => entry.result?.status === 'completed');
    if (!inputs.length || ((stage as Stage & { join?: 'all' | 'any' }).join !== 'any' && inputs.length !== stage.inputs.length)) {
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'skipped', reason: 'one or more aggregate inputs are unavailable', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    }
    const sourceSummaries = inputs.map(({ input, result }) => ({ input, summary: result!.summaries[input.question] })).filter((item): item is { input: typeof stage.inputs[number]; summary: QuestionSummary } => Boolean(item.summary));
    if (sourceSummaries.length !== inputs.length || !sourceSummaries.length) {
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: 'aggregate source summary is unavailable', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    }
    const sourceType = sourceSummaries[0]!.summary.type;
    if (sourceSummaries.some(({ summary }) => summary.type !== sourceType)) {
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: 'aggregate input question types are incompatible', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    }
    const distributionKeys = Object.keys(sourceSummaries[0]!.summary.probabilities ?? {}).sort();
    if (sourceSummaries.some(({ summary }) => {
      const keys = Object.keys(summary.probabilities ?? {}).sort();
      return keys.length !== distributionKeys.length || keys.some((key, index) => key !== distributionKeys[index]);
    })) {
      return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: 'aggregate inputs have incompatible options or score levels', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    }
    const totalInputWeight = sourceSummaries.reduce((sum, item) => sum + item.input.weight, 0);
    const votes: Vote[] = sourceSummaries.flatMap(({ input }) => {
      const sourceVotes = stages[input.stage]!.votes.filter((vote) => vote.answers[input.question] !== undefined);
      const sourceWeight = sourceVotes.reduce((sum, vote) => sum + vote.weight, 0);
      if (!(sourceWeight > 0)) return [];
      return sourceVotes.map((vote) => ({
        ...vote,
        weight: (input.weight / totalInputWeight) * (vote.weight / sourceWeight),
        answers: { [stage.outputQuestion]: vote.answers[input.question]! },
      }));
    });
    votes.sort(compareVotes);
    const baseQuestion = resolveQuestion(pipeline.stages, sourceSummaries[0]!.input.stage, sourceSummaries[0]!.input.question);
    if (!baseQuestion) return { id: stage.id, kind: stage.kind, label: stage.label, status: 'failed', reason: 'aggregate source question definition is unavailable', dependsOn: stage.dependsOn, votes: [], summaries: {}, startedAt, finishedAt: new Date().toISOString() };
    const outputQuestion = { ...baseQuestion, label: stage.label } as Question;
    const summary = summarizeVotes({ [stage.outputQuestion]: outputQuestion }, votes)[stage.outputQuestion]!;
    return { id: stage.id, kind: stage.kind, label: stage.label, status: 'completed', dependsOn: stage.dependsOn, votes, summaries: { [stage.outputQuestion]: summary }, startedAt, finishedAt: new Date().toISOString() };
  };

  while (pending.size) {
    const ready = order.filter((stage) => pending.has(stage.id) && stage.dependsOn.every((dependency) => stages[dependency] !== undefined));
    if (!ready.length) throw new Error('pipeline dependencies could not be scheduled');
    await Promise.all(ready.map(async (stage) => { stages[stage.id] = await runStage(stage); pending.delete(stage.id); }));
  }
  const failed = Object.values(stages).some((stage) => stage.status === 'failed');
  const completedAt = new Date().toISOString();
  return {
    version: 1,
    id: randomUUID(),
    createdAt,
    finishedAt: completedAt,
    pipeline,
    pipelineHash,
    provider: options.provider.name,
    model: options.model,
    seed: options.seed,
    status: failed ? 'failed' : 'completed',
    cohorts,
    stages,
    warnings,
    usage,
  };
}

function stagesToSummaries(stages: StageResult[]): Record<string, Record<string, QuestionSummary>> {
  return Object.fromEntries(stages.map((stage) => [stage.id, stage.summaries]));
}

function resolvePollInputs(bindings: Record<string, PollInputBinding>, stages: Record<string, StageResult>): Json {
  const resolved: Record<string, Json> = {};
  for (const [alias, binding] of Object.entries(bindings)) {
    const result = stages[binding.stage];
    const summary = result?.status === 'completed' ? result.summaries[binding.question] : undefined;
    if (!summary) {
      resolved[alias] = null;
      continue;
    }
    const select = binding.select ?? 'summary';
    if (select === 'summary') resolved[alias] = summary as unknown as Json;
    else if (select === 'winner') resolved[alias] = summary.winner ?? null;
    else if (select === 'mean') resolved[alias] = summary.mean ?? null;
    else if (select === 'probabilities') resolved[alias] = summary.probabilities ? { ...summary.probabilities } : null;
    else {
      resolved[alias] = result!.votes.flatMap((vote) => {
        const answer = vote.answers[binding.question];
        if (!answer) return [];
        return [{
          personaId: vote.personaId,
          cohortId: vote.cohortId ?? null,
          segment: vote.segment,
          repeat: vote.repeat,
          weight: vote.weight,
          model: vote.model,
          answer: answer as unknown as Json,
        } as unknown as Json];
      });
    }
  }
  return resolved;
}

function compareVotes(left: Vote, right: Vote): number {
  return (left.cohortId ?? '').localeCompare(right.cohortId ?? '') ||
    left.personaId.localeCompare(right.personaId) ||
    left.repeat - right.repeat ||
    left.segment.localeCompare(right.segment) ||
    stableStringify(left.answers).localeCompare(stableStringify(right.answers));
}

function validateExecutionGraph(pipeline: Pipeline, order: Stage[]): void {
  const byId = new Map(order.map((stage) => [stage.id, stage]));
  const ancestors = (stageId: string): Set<string> => {
    const visited = new Set<string>();
    const visit = (id: string): void => {
      const stage = byId.get(id);
      for (const dependency of stage?.dependsOn ?? []) {
        if (visited.has(dependency)) continue;
        visited.add(dependency);
        visit(dependency);
      }
    };
    visit(stageId);
    return visited;
  };
  for (const stage of order) {
    if (new Set(stage.dependsOn).size !== stage.dependsOn.length) throw new Error(`stage '${stage.id}' has duplicate dependencies`);
    const prior = ancestors(stage.id);
    const requireDependency = (source: string, context: string): void => {
      if (!stage.dependsOn.includes(source)) throw new Error(`${context} '${source}' must be a declared dependency of stage '${stage.id}'`);
    };
    const checkCondition = (condition: Condition | undefined): void => {
      if (!condition) return;
      if ('all' in condition) { condition.all.forEach(checkCondition); return; }
      if ('any' in condition) { condition.any.forEach(checkCondition); return; }
      if ('not' in condition) { checkCondition(condition.not); return; }
      if (!prior.has(condition.stage)) throw new Error(`condition at '${stage.id}' references non-ancestor stage '${condition.stage}'`);
      const question = resolveQuestion(pipeline.stages, condition.stage, condition.question);
      if (!question) throw new Error(`condition at '${stage.id}' references unknown question '${condition.stage}.${condition.question}'`);
      if (condition.metric === 'winner' && question.type === 'noul') throw new Error(`condition winner metric requires a Choice or Score question at '${condition.stage}.${condition.question}'`);
      if (condition.metric === 'margin' && question.type !== 'choice') throw new Error(`condition margin metric requires a Choice question at '${condition.stage}.${condition.question}'`);
      if (condition.metric === 'mean' && question.type === 'choice') throw new Error(`condition mean metric requires a Noul or Score question at '${condition.stage}.${condition.question}'`);
      if ((condition.metric === 'margin' || condition.metric === 'mean' || condition.metric === 'topProbability') && typeof condition.value !== 'number') {
        throw new Error(`condition metric '${condition.metric}' requires a numeric threshold`);
      }
      if (condition.metric === 'winner') {
        if (typeof condition.value !== 'string' || !['eq', 'ne'].includes(condition.op)) throw new Error('condition winner requires a string value and eq or ne operator');
        const winners = question.type === 'choice' ? Object.keys(question.criteria) : question.type === 'score' ? question.criteria.map((_, index) => String(index)) : [];
        if (!winners.includes(condition.value)) throw new Error(`condition winner '${condition.value}' is not an available option`);
      }
    };
    checkCondition(stage.when);
    if (stage.kind === 'decision') {
      requireDependency(stage.from.stage, 'decision source');
      if (!resolveQuestion(pipeline.stages, stage.from.stage, stage.from.question)) throw new Error(`decision references unknown question '${stage.from.stage}.${stage.from.question}'`);
    }
    if (stage.kind === 'aggregate') {
      const references = new Set<string>();
      const signatures: string[] = [];
      for (const input of stage.inputs) {
        requireDependency(input.stage, 'aggregate input');
        const reference = `${input.stage}.${input.question}`;
        if (references.has(reference)) throw new Error(`aggregate stage '${stage.id}' repeats input '${reference}'`);
        references.add(reference);
        const question = resolveQuestion(pipeline.stages, input.stage, input.question);
        if (!question) throw new Error(`aggregate references unknown question '${reference}'`);
        signatures.push(questionSignature(question));
        if (!Number.isFinite(input.weight) || input.weight <= 0) throw new Error(`aggregate input '${reference}' must have positive weight`);
      }
      if (new Set(signatures).size > 1) throw new Error(`aggregate stage '${stage.id}' combines incompatible question types or options`);
    }
    if (stage.kind === 'poll' && stage.inputs !== undefined) {
      if (Object.keys(stage.inputs).length > 1000) throw new Error(`poll stage '${stage.id}' has too many input bindings`);
      for (const [alias, binding] of Object.entries(stage.inputs)) {
        if (!/^[a-z][a-z0-9_-]{0,159}$/.test(alias) || ['__proto__', 'prototype', 'constructor'].includes(alias)) throw new Error(`poll stage '${stage.id}' has an invalid input alias`);
        requireDependency(binding.stage, 'poll input');
        const question = resolveQuestion(pipeline.stages, binding.stage, binding.question);
        if (!question) throw new Error(`poll stage '${stage.id}' input references unknown question '${binding.stage}.${binding.question}'`);
        const select = binding.select ?? 'summary';
        if (!['summary', 'winner', 'mean', 'probabilities', 'responses'].includes(select)) throw new Error(`poll stage '${stage.id}' has an invalid input selector`);
        if (!inputSelectCompatible(select, question)) throw new Error(`poll stage '${stage.id}' selector '${select}' is incompatible with ${question.type} question '${binding.stage}.${binding.question}'`);
      }
    }
  }
}

function questionSignature(question: Question): string {
  if (question.type === 'noul') return 'noul';
  if (question.type === 'choice') return `choice:${JSON.stringify(Object.entries(question.criteria).sort(([a], [b]) => a.localeCompare(b)))}`;
  return `score:${JSON.stringify(question.criteria)}`;
}

function resolveQuestion(stages: Stage[], stageId: string, questionId: string, seen = new Set<string>()): Question | undefined {
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

function questionsForSeed(questions: Record<string, Question>, seed: string): Record<string, Question> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type !== 'choice') return [id, question];
    const random = seededRandom(`${seed}:choice-order:${id}`);
    const options = Object.entries(question.criteria);
    for (let index = options.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [options[index], options[target]] = [options[target]!, options[index]!];
    }
    return [id, { ...question, criteria: Object.fromEntries(options) }];
  }));
}

function safeRequestFailure(error: unknown): string {
  if (error instanceof RequestLimitError) return 'request limit reached';
  if (error instanceof InvalidEvaluationError) return 'invalid provider response';
  if (!(error instanceof ProviderError)) return 'provider request failed';
  if (error.code === 'TYPESAFE_RESPONSE_INVALID') {
    const issue = error.responseIssue ? responseIssueMessages.get(error.responseIssue) : undefined;
    return `${error.code}: ${issue ?? 'TypeSafe returned an invalid response'}`;
  }
  const messages: Record<string, string> = {
    MISSING_TYPESAFE_API_KEY: 'TypeSafe API key is not configured',
    TYPESAFE_AUTHENTICATION_FAILED: 'TypeSafe authentication failed',
    TYPESAFE_PERMISSION_DENIED: 'TypeSafe denied access',
    TYPESAFE_RATE_LIMITED: 'TypeSafe rate limited the request',
    TYPESAFE_TIMEOUT: 'TypeSafe request timed out',
    TYPESAFE_CONNECTION_FAILED: 'could not connect to TypeSafe',
    TYPESAFE_SERVICE_UNAVAILABLE: 'TypeSafe service is unavailable',
    TYPESAFE_REQUEST_REJECTED: 'TypeSafe rejected the request',
    TYPESAFE_RESPONSE_INVALID: 'TypeSafe returned an invalid response',
    TYPESAFE_EVALUATION_FAILED: 'TypeSafe evaluation failed',
    GLINER_NOT_READY: 'GLiNER needs local setup; run npm run setup:gliner',
    GLINER_UNSUPPORTED_MODEL: 'GLiNER supports only fastino/GLiNER2.5-Decide',
    GLINER_TIMEOUT: 'GLiNER local model timed out',
    GLINER_RUNTIME_FAILED: 'GLiNER local inference failed; shorten input or repair local setup',
    GLINER_RESPONSE_INVALID: 'GLiNER returned invalid label scores',
    GLINER_INPUT_TOO_LARGE: 'GLiNER input exceeds 512 tokens including question schemas; shorten study context, persona fields, or questions',
  };
  return `${error.code}: ${messages[error.code] ?? 'provider request failed'}`;
}

const responseIssueMessages = new Map<ProviderResponseIssue, string>([
  ['answers_shape', 'the answer map is missing or incomplete'],
  ['answer_shape', 'an answer is missing or malformed'],
  ['answer_type', 'an answer type does not match its question'],
  ['noul_probability', 'a Noul probability is outside 0 to 1'],
  ['probability_shape', 'a Choice or Score distribution is missing or incomplete'],
  ['probability_range', 'a probability or confidence value is outside 0 to 1'],
  ['probability_total', 'a Choice or Score distribution does not sum to 1'],
  ['choice_value', 'the selected Choice is not one of the requested options'],
  ['choice_winner', 'the selected Choice is not the most probable option'],
  ['score_value', 'a Score value is outside its requested range'],
  ['score_legend', 'a Score legend does not match its requested levels'],
  ['score_mean', 'a Score value does not match its probability-weighted mean'],
  ['usage_shape', 'token usage metadata is missing or invalid'],
  ['model_shape', 'the resolved model metadata is missing or invalid'],
]);
