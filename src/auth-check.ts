import { createProvider, ProviderError, type ProviderConfig } from './provider.js';
import type { EvaluationRequest, Provider } from './types.js';

const MODEL = 'jev-1.13.0';

const smokeRequest: EvaluationRequest = {
  model: MODEL,
  seed: 'typesafe-account-connection-check',
  state: { task: 'Small TypeSafe connection check', responseStyle: 'Answer each typed question directly.' },
  questions: {
    preference: {
      type: 'choice',
      label: 'Choice response check',
      instructions: 'Which option indicates this connection check is running?',
      criteria: { connected: 'The API returned a typed answer', unavailable: 'The API did not return an answer' },
    },
    rating: {
      type: 'score',
      label: 'Score response check',
      instructions: 'How clear is the connection status in this test state?',
      criteria: ['Unclear', 'Clear'],
    },
    confirmation: {
      type: 'noul',
      label: 'Noul response check',
      instructions: 'Did the state identify this as a TypeSafe connection check?',
    },
  },
};

export interface TypeSafeConnectionResult {
  verified: true;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  sampleAnswers: { choice: string; score: number; noul: number };
}

type TypeSafeFactory = (name: 'typesafe', config: ProviderConfig) => Provider;

/** Create a connection check with an injectable provider factory for offline tests. */
export function createTypeSafeConnectionChecker(factory: TypeSafeFactory = createProvider) {
  return async function verifyTypeSafeConnection(apiKey?: string): Promise<TypeSafeConnectionResult> {
    const config: ProviderConfig = { retries: 0, timeoutMs: 15_000 };
    if (apiKey !== undefined) config.apiKey = apiKey;
    try {
      const evaluation = await factory('typesafe', config).evaluate(smokeRequest);
      const choice = evaluation.answers.preference;
      const score = evaluation.answers.rating;
      const noul = evaluation.answers.confirmation;
      if (choice?.type !== 'choice' || score?.type !== 'score' || noul?.type !== 'noul' ||
          typeof evaluation.model !== 'string' || !evaluation.model ||
          !Number.isSafeInteger(evaluation.usage.inputTokens) || evaluation.usage.inputTokens < 0 ||
          !Number.isSafeInteger(evaluation.usage.outputTokens) || evaluation.usage.outputTokens < 0) {
        throw new ProviderError('TYPESAFE_RESPONSE_INVALID', 'TypeSafe connection check returned an invalid typed response.');
      }
      return {
        verified: true,
        model: evaluation.model,
        usage: evaluation.usage,
        sampleAnswers: { choice: choice.choice, score: score.score, noul: noul.noul },
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError('TYPESAFE_EVALUATION_FAILED', 'TypeSafe connection check failed. Check credentials and retry.');
    }
  };
}

export const verifyTypeSafeConnection = createTypeSafeConnectionChecker();
