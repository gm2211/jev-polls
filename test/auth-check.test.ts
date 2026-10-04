import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProvider } from '../src/provider.js';
import { createTypeSafeConnectionChecker } from '../src/auth-check.js';

test('connection check batches Choice, Score, and Noul over a low-token pinned-model request', async () => {
  let sentBody: Record<string, unknown> | undefined;
  const secret = 'fake-connection-secret';
  const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
    sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      model: 'jev-1.13.0',
      answers: {
        preference: { type: 'choice', choice: 'connected', probabilities: { connected: 0.8, unavailable: 0.2 }, confidence: 0.6 },
        rating: { type: 'score', score: 0.7, probabilities: { '0': 0.3, '1': 0.7 }, confidence: 0.4, legend: { '0': 'Unclear', '1': 'Clear' } },
        confirmation: { type: 'noul', noul: 0.9 },
      },
      usage: { input_tokens: 41, output_tokens: 12 },
    });
  };
  const check = createTypeSafeConnectionChecker((name, config) => {
    assert.equal(name, 'typesafe');
    assert.equal(config.apiKey, secret);
    assert.equal(config.retries, 0);
    assert.equal(config.timeoutMs, 15_000);
    return createProvider('typesafe', { ...config, fetch });
  });

  const result = await check(secret);
  assert.deepEqual(result, {
    verified: true,
    model: 'jev-1.13.0',
    usage: { inputTokens: 41, outputTokens: 12 },
    sampleAnswers: { choice: 'connected', score: 0.7, noul: 0.9 },
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(sentBody?.model, 'jev-1.13.0');
  assert.deepEqual(Object.keys(sentBody?.questions as object), ['preference', 'rating', 'confirmation']);
});

test('connection check validates all three typed responses', async () => {
  const check = createTypeSafeConnectionChecker(() => ({
    name: 'typesafe',
    async evaluate() {
      return {
        model: 'jev-1.13.0', usage: { inputTokens: 1, outputTokens: 1 },
        answers: {
          preference: { type: 'choice', choice: 'connected', probabilities: { connected: 1, unavailable: 0 }, confidence: 1 },
          rating: { type: 'noul', noul: 0.5 },
          confirmation: { type: 'noul', noul: 0.5 },
        },
      };
    },
  }));
  await assert.rejects(check(), error => {
    assert.equal((error as { code?: string }).code, 'TYPESAFE_RESPONSE_INVALID');
    assert.doesNotMatch((error as Error).message, /secret|key/i);
    return true;
  });
});

test('connection check sanitizes unexpected provider failures', async () => {
  const secret = 'fake-provider-failure-secret';
  const check = createTypeSafeConnectionChecker(() => ({
    name: 'typesafe',
    async evaluate() { throw new Error(secret); },
  }));
  await assert.rejects(check(secret), error => {
    assert.equal((error as { code?: string }).code, 'TYPESAFE_EVALUATION_FAILED');
    assert.equal((error as Error).message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});
