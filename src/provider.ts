import { createHash } from 'node:crypto';
import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  choice,
  noul,
  score,
  TypeSafeClient,
  type Fetch,
  type Question as ApiQuestion,
} from '@typesafe-ai/sdk';
import { readApiKey } from './auth.js';
import { CHOICE_WINNER_TOLERANCE } from './engine-utils.js';
import { createGlinerProvider, type GlinerConfig } from './gliner-provider.js';
export { GLINER_MODEL, glinerStatus } from './gliner-provider.js';
import type { Answer, Evaluation, EvaluationRequest, Provider, Question } from './types.js';

export interface ProviderConfig {
  gliner?: GlinerConfig;
  apiKey?: string;
  baseURL?: string;
  timeoutMs?: number;
  retries?: number;
  /** Transport seam for local tests and controlled proxies. */
  fetch?: Fetch;
}

export type ProviderErrorCode =
  | 'GLINER_NOT_READY'
  | 'GLINER_UNSUPPORTED_MODEL'
  | 'GLINER_TIMEOUT'
  | 'GLINER_RUNTIME_FAILED'
  | 'GLINER_RESPONSE_INVALID'
  | 'GLINER_INPUT_TOO_LARGE'
  | 'MISSING_TYPESAFE_API_KEY'
  | 'TYPESAFE_AUTHENTICATION_FAILED'
  | 'TYPESAFE_PERMISSION_DENIED'
  | 'TYPESAFE_RATE_LIMITED'
  | 'TYPESAFE_TIMEOUT'
  | 'TYPESAFE_CONNECTION_FAILED'
  | 'TYPESAFE_SERVICE_UNAVAILABLE'
  | 'TYPESAFE_REQUEST_REJECTED'
  | 'TYPESAFE_RESPONSE_INVALID'
  | 'TYPESAFE_EVALUATION_FAILED';
/** Safe classification for provider-owned response validation failures. */
export type ProviderResponseIssue =
  | 'answers_shape'
  | 'answer_shape'
  | 'answer_type'
  | 'noul_probability'
  | 'probability_shape'
  | 'probability_range'
  | 'probability_total'
  | 'choice_value'
  | 'choice_winner'
  | 'score_value'
  | 'score_legend'
  | 'score_mean'
  | 'usage_shape'
  | 'model_shape';

export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly httpStatus?: number,
    readonly responseIssue?: ProviderResponseIssue,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Hosted Jev reports each probability rounded to two decimals, so each option can be off by up to half a hundredth. */
export const PROBABILITY_ROUNDING_STEP = 0.005;
/** Allowed drift from 1 for a distribution of `options` rounded probabilities before it is treated as invalid. */
export function probabilitySumTolerance(options: number): number {
  return Math.max(1e-3, options * PROBABILITY_ROUNDING_STEP + 1e-9);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function hashNumber(seed: string): number {
  const digest = createHash('sha256').update(seed).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

function normalized(weights: number[]): number[] {
  const total = weights.reduce((sum, value) => sum + value, 0);
  return weights.map((value) => value / total);
}

function choiceConfidence(values: number[]): number {
  const baseline = 1 / values.length;
  return Math.max(0, (Math.max(...values) - baseline) / (1 - baseline));
}

function scoreConfidence(values: number[]): number {
  const mode = values.indexOf(Math.max(...values));
  const spread = values.reduce((sum, probability, index) => sum + probability * Math.abs(index - mode), 0);
  const uniformSpread = values.reduce((sum, _probability, index) => sum + Math.abs(index - (values.length - 1) / 2), 0) / values.length;
  return Math.max(0, 1 - spread / uniformSpread);
}

function assertProbability(value: unknown, path: string, issue: ProviderResponseIssue = 'probability_range'): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw invalidResponse(issue, `TypeSafe returned an invalid probability for ${path}.`);
  }
}

function invalidResponse(issue: ProviderResponseIssue, message: string): ProviderError {
  return new ProviderError('TYPESAFE_RESPONSE_INVALID', message, undefined, issue);
}

function validateAnswer(question: Question, value: unknown, id: string): Answer {
  if (!value || typeof value !== 'object') throw invalidResponse('answer_shape', `TypeSafe omitted a valid answer for ${id}.`);
  const answer = value as Record<string, unknown>;
  if (answer.type !== question.type) throw invalidResponse('answer_type', `TypeSafe returned the wrong answer type for ${id}.`);

  if (question.type === 'noul') {
    assertProbability(answer.noul, id, 'noul_probability');
    return { type: 'noul', noul: answer.noul };
  }

  const expected = question.type === 'choice'
    ? Object.keys(question.criteria)
    : question.criteria.map((_, index) => String(index));
  const rawProbabilities = answer.probabilities;
  if (!rawProbabilities || typeof rawProbabilities !== 'object' || Array.isArray(rawProbabilities)) {
    throw invalidResponse('probability_shape', `TypeSafe returned invalid probabilities for ${id}.`);
  }
  const probabilities = rawProbabilities as Record<string, unknown>;
  if (Object.keys(probabilities).length !== expected.length || expected.some((key) => !(key in probabilities))) {
    throw invalidResponse('probability_shape', `TypeSafe returned an incomplete probability distribution for ${id}.`);
  }
  let sum = 0;
  for (const key of expected) {
    assertProbability(probabilities[key], `${id}.${key}`);
    sum += probabilities[key];
  }
  // Hosted Jev rounds each probability to two decimals, so long option lists drift from 1; renormalize rounding drift, reject real errors.
  if (Math.abs(sum - 1) > probabilitySumTolerance(expected.length)) throw invalidResponse('probability_total', `TypeSafe returned an unnormalized probability distribution for ${id}.`);
  if (Math.abs(sum - 1) > 1e-9) for (const key of expected) probabilities[key] = (probabilities[key] as number) / sum;
  assertProbability(answer.confidence, `${id}.confidence`);

  if (question.type === 'choice') {
    if (typeof answer.choice !== 'string' || !expected.includes(answer.choice)) {
      throw invalidResponse('choice_value', `TypeSafe selected an unknown option for ${id}.`);
    }
    const values = expected.map((key) => probabilities[key] as number);
    if ((probabilities[answer.choice] as number) < Math.max(...values) - CHOICE_WINNER_TOLERANCE) {
      throw invalidResponse('choice_winner', `TypeSafe selected a non-leading option for ${id}.`);
    }
    return { type: 'choice', choice: answer.choice, probabilities: probabilities as Record<string, number>, confidence: answer.confidence };
  }

  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > question.criteria.length - 1) {
    throw invalidResponse('score_value', `TypeSafe returned an invalid score for ${id}.`);
  }
  const expectedLegend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
  if (!answer.legend || typeof answer.legend !== 'object' || stableJson(answer.legend) !== stableJson(expectedLegend)) {
    throw invalidResponse('score_legend', `TypeSafe returned an invalid score legend for ${id}.`);
  }
  const values = expected.map((key) => probabilities[key] as number);
  const expectedScore = values.reduce((sum, probability, index) => sum + probability * index, 0);
  // The API may round its expected score; tolerate small display precision differences.
  if (Math.abs(answer.score - expectedScore) > 0.01) throw invalidResponse('score_mean', `TypeSafe returned a score inconsistent with its distribution for ${id}.`);
  return { type: 'score', score: answer.score, probabilities: probabilities as Record<string, number>, confidence: answer.confidence, legend: expectedLegend };
}

function mockAnswer(question: Question, seed: string): Answer {
  const rand = (salt: string): number => hashNumber(`${seed}\0${salt}`);
  if (question.type === 'noul') {
    // Synthetic persona variation stays useful for demos, while remaining visibly mock data.
    return { type: 'noul', noul: Number((0.18 + rand('yes') * 0.68).toFixed(4)) };
  }
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria);
    const selected = Math.floor(rand('selected') * keys.length);
    const probabilities = normalized(keys.map((_, index) => index === selected ? 4.5 + rand(`major-${index}`) * 4 : 0.15 + rand(`minor-${index}`) * 1.15));
    const distribution = Object.fromEntries(keys.map((key, index) => [key, probabilities[index]!]));
    return { type: 'choice', choice: keys[selected]!, probabilities: distribution, confidence: choiceConfidence(probabilities) };
  }
  const levels = question.criteria.length;
  const peak = Math.floor(rand('score') * levels);
  const weights = Array.from({ length: levels }, (_, index) => Math.max(0.08, 2.7 - Math.abs(index - peak) * 1.1) * (0.8 + rand(`score-${index}`) * 0.4));
  const values = normalized(weights);
  const probabilities = Object.fromEntries(values.map((value, index) => [String(index), value]));
  const scoreValue = values.reduce((sum, value, index) => sum + value * index, 0);
  const legend = Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
  return { type: 'score', score: Number(scoreValue.toFixed(6)), probabilities, confidence: scoreConfidence(values), legend };
}

function safeFailure(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof APITimeoutError) {
    return new ProviderError('TYPESAFE_TIMEOUT', 'TypeSafe request timed out. Retry the request or increase the timeout.');
  }
  if (error instanceof APIError) {
    if (error.status === 401) return new ProviderError('TYPESAFE_AUTHENTICATION_FAILED', 'TypeSafe rejected the API key. Check the configured credential.', error.status);
    if (error.status === 403) return new ProviderError('TYPESAFE_PERMISSION_DENIED', 'TypeSafe denied access for this API key or model.', error.status);
    if (error.status === 408) return new ProviderError('TYPESAFE_TIMEOUT', 'TypeSafe request timed out. Retry the request or increase the timeout.', error.status);
    if (error.status === 429 || error.status === 529) return new ProviderError('TYPESAFE_RATE_LIMITED', 'TypeSafe is rate limiting or temporarily overloaded. Retry later.', error.status);
    if (error.status >= 500) return new ProviderError('TYPESAFE_SERVICE_UNAVAILABLE', 'TypeSafe is temporarily unavailable. Retry later.', error.status);
    return new ProviderError('TYPESAFE_REQUEST_REJECTED', `TypeSafe rejected the request (HTTP ${error.status}). Check the model and question schemas.`, error.status);
  }
  if (error instanceof APIConnectionError) {
    return new ProviderError('TYPESAFE_CONNECTION_FAILED', 'Could not connect to TypeSafe. Check network access and retry.');
  }
  return new ProviderError('TYPESAFE_EVALUATION_FAILED', 'TypeSafe evaluation failed. Check provider configuration and retry.');
}

function createMockProvider(): Provider {
  return {
    name: 'mock',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      const state = stableJson(request.state);
      const answers: Record<string, Answer> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        answers[id] = mockAnswer(question, `${request.seed}\0${request.model}\0${state}\0${id}\0${stableJson(question)}`);
      }
      return { answers, model: `mock/${request.model}`, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}

function toApiQuestion(question: Question): ApiQuestion {
  const instructions = { question: question.label, instructions: question.instructions };
  if (question.type === 'choice') return choice(instructions, question.criteria);
  if (question.type === 'noul') return noul(instructions);
  return score(instructions, question.criteria as [string, string, ...string[]]);
}

function createTypeSafeProvider(config: ProviderConfig): Provider {
  return {
    name: 'typesafe',
    async evaluate(request: EvaluationRequest): Promise<Evaluation> {
      try {
        const key = config.apiKey?.trim() || await readApiKey();
        if (!key) throw new ProviderError('MISSING_TYPESAFE_API_KEY', 'TypeSafe API key is not configured.');
        const client = new TypeSafeClient({
          apiKey: key,
          ...(config.baseURL ? { baseURL: config.baseURL } : {}),
          timeout: config.timeoutMs ?? 15_000,
          retry: { maxRetries: config.retries ?? 2 },
          logLevel: 'off',
          ...(config.fetch ? { fetch: config.fetch } : {}),
        });
        const questions = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, toApiQuestion(question)]));
        const result = await client.systemOne({ state: request.state as Parameters<TypeSafeClient['systemOne']>[0]['state'], model: request.model, questions });
        if (!result.answers || typeof result.answers !== 'object') throw invalidResponse('answers_shape', 'TypeSafe returned an invalid answers object.');
        const keys = Object.keys(request.questions);
        if (Object.keys(result.answers).length !== keys.length || keys.some((id) => !(id in result.answers))) throw invalidResponse('answers_shape', 'TypeSafe returned an incomplete answers object.');
        const answers: Record<string, Answer> = {};
        for (const [id, question] of Object.entries(request.questions)) answers[id] = validateAnswer(question, result.answers[id], id);
        const usage = result.usage;
        if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) {
          throw invalidResponse('usage_shape', 'TypeSafe returned invalid usage metadata.');
        }
        if (typeof result.model !== 'string' || !result.model) throw invalidResponse('model_shape', 'TypeSafe returned an invalid model name.');
        return { answers, model: result.model, usage: { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } };
      } catch (error) {
        throw safeFailure(error);
      }
    },
  };
}

export function createProvider(name: Provider['name'], config: ProviderConfig = {}): Provider {
  if (name === 'gliner') return createGlinerProvider(config.gliner);
  return name === 'mock' ? createMockProvider() : createTypeSafeProvider(config);
}
