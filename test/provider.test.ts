import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createProvider, ProviderError } from '../src/provider.js';
import type { EvaluationRequest } from '../src/types.js';

const request: EvaluationRequest = {
  model: 'jev-latest',
  seed: 'demo-seed',
  state: { persona: { id: 'p1', budget: 80, priorities: ['comfort', 'price'] }, product: 'A quiet compact car' },
  questions: {
    choice: { type: 'choice', label: 'Which option would you choose?', instructions: 'Consider this persona carefully.', criteria: { alpha: 'Low cost', beta: 'More comfort', gamma: 'Balanced' } },
    likely: { type: 'noul', label: 'Would they buy?', instructions: 'Estimate likelihood.' },
    fit: { type: 'score', label: 'How well does it fit?', instructions: 'Use the rubric.', criteria: ['Poor fit', 'Mixed fit', 'Strong fit'] },
  },
};

test('mock provider is deterministic and varies with persona and seed', async () => {
  const provider = createProvider('mock');
  const first = await provider.evaluate(request);
  assert.deepEqual(await provider.evaluate(request), first);
  assert.match(first.model, /^mock\//);
  assert.equal(first.usage.inputTokens, 0);
  assert.equal(first.answers.choice?.type, 'choice');
  assert.equal(first.answers.likely?.type, 'noul');
  assert.equal(first.answers.fit?.type, 'score');
  const choiceAnswer = first.answers.choice;
  if (choiceAnswer?.type === 'choice') {
    const values = Object.values(choiceAnswer.probabilities);
    const max = Math.max(...values);
    assert.ok(choiceAnswer.probabilities[choiceAnswer.choice] >= max - 1e-8);
    assert.ok(Math.abs(choiceAnswer.confidence - (max - 1 / values.length) / (1 - 1 / values.length)) < 1e-12);
    assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-5);
  }
  const scoreAnswer = first.answers.fit;
  if (scoreAnswer?.type === 'score') {
    const values = Object.keys(scoreAnswer.probabilities).sort((a, b) => Number(a) - Number(b)).map(key => scoreAnswer.probabilities[key]!);
    const mode = values.indexOf(Math.max(...values));
    const spread = values.reduce((sum, probability, index) => sum + probability * Math.abs(index - mode), 0);
    const uniformSpread = values.reduce((sum, _, index) => sum + Math.abs(index - (values.length - 1) / 2), 0) / values.length;
    const expectedScore = values.reduce((sum, value, index) => sum + index * value, 0);
    assert.ok(Math.abs(scoreAnswer.confidence - Math.max(0, 1 - spread / uniformSpread)) < 1e-12);
    assert.ok(Math.abs(scoreAnswer.score - expectedScore) < 1e-6);
  }

  const otherPersona = { ...request, state: { persona: { id: 'p2', budget: 25, priorities: ['price'] }, product: 'A quiet compact car' } };
  const changedSeed = { ...request, seed: 'another-seed' };
  assert.notDeepEqual(await provider.evaluate(otherPersona), first);
  assert.notDeepEqual(await provider.evaluate(changedSeed), first);
});

test('TypeSafe maps labels into instructions and validates a complete response', async () => {
  let body: Record<string, unknown> | undefined;
  const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      model: 'jev-test',
      answers: {
        choice: { type: 'choice', choice: 'beta', confidence: 0.7, probabilities: { alpha: 0.1, beta: 0.7, gamma: 0.2 } },
        likely: { type: 'noul', noul: 0.64 },
        fit: { type: 'score', score: 1.4, confidence: 0.6, legend: { '0': 'Poor fit', '1': 'Mixed fit', '2': 'Strong fit' }, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 } },
      },
      usage: { input_tokens: 23, output_tokens: 8 },
    });
  };
  const result = await createProvider('typesafe', { apiKey: 'fake-key-for-provider-test', fetch }).evaluate(request);
  assert.equal(result.model, 'jev-test');
  assert.equal(result.usage.inputTokens, 23);
  assert.equal(result.answers.choice?.type, 'choice');
  const questions = body?.questions as Record<string, Record<string, unknown>>;
  assert.equal(questions.choice?.type, 'choice');
  assert.deepEqual(questions.choice?.instructions, {
    question: 'Which option would you choose?', instructions: 'Consider this persona carefully.',
  });
  assert.equal('label' in (questions.choice?.instructions as object), false);
});

test('TypeSafe sends structured option names and descriptions and retains probability keys', async () => {
  const criteria = { option_a: { label: 'Daily ritual', description: 'A compact kit for everyday use.' }, option_b: { label: 'Weekend escape', description: '' }, neither: null };
  let submitted: any;
  const fetch = async (_input: string, init?: RequestInit): Promise<Response> => {
    submitted = JSON.parse(String(init?.body));
    return Response.json({ model: 'jev-test', answers: { pick: { type: 'choice', choice: 'option_a', probabilities: { option_a: 0.6, option_b: 0.3, neither: 0.1 }, confidence: 0.4 } }, usage: { input_tokens: 25, output_tokens: 3 } });
  };
  const result = await createProvider('typesafe', { apiKey: 'fake-provider-test-key', fetch }).evaluate({ ...request, questions: { pick: { type: 'choice', label: 'Which concept fits?', instructions: 'Compare the described concepts.', criteria } } });
  assert.deepEqual(submitted.questions.pick.criteria, criteria);
  const answer = result.answers.pick;
  assert.ok(answer?.type === 'choice');
  assert.equal(answer.choice, 'option_a');
  assert.deepEqual(answer.probabilities, { option_a: 0.6, option_b: 0.3, neither: 0.1 });
  assert.ok(Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-8);
});

test('TypeSafe hides response bodies and secrets on errors', async () => {
  const secret = 'fake-secret-that-must-not-leak';
  const failingFetch = async (): Promise<Response> => Response.json({ error: secret, detail: secret }, { status: 401 });
  const logOutput: string[] = [];
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const original = Object.fromEntries(consoleMethods.map((method) => [method, console[method]])) as Record<typeof consoleMethods[number], typeof console.log>;
  try {
    for (const method of consoleMethods) console[method] = (...values: unknown[]) => { logOutput.push(values.join(' ')); };
    await assert.rejects(
      createProvider('typesafe', { apiKey: secret, fetch: failingFetch }).evaluate(request),
      (error: unknown) => {
        assert(error instanceof ProviderError);
        assert.equal(error.code, 'TYPESAFE_AUTHENTICATION_FAILED');
        assert.equal(error.message.includes(secret), false);
        assert.equal(JSON.stringify(error).includes(secret), false);
        assert.equal(process.argv.some((arg) => arg.includes(secret)), false);
        return true;
      },
    );
  } finally {
    for (const method of consoleMethods) console[method] = original[method];
  }
  assert.equal(logOutput.join('\n').includes(secret), false);
});

test('TypeSafe rejects a malformed probability distribution', async () => {
  const fetch = async (): Promise<Response> => Response.json({
    model: 'jev-test',
    answers: { choice: { type: 'choice', choice: 'alpha', confidence: 0.9, probabilities: { alpha: 0.9, beta: 0.1, gamma: 0.01 } }, likely: { type: 'noul', noul: 0.5 }, fit: { type: 'score', score: 1, confidence: 0.5, legend: { '0': 'Poor fit', '1': 'Mixed fit', '2': 'Strong fit' }, probabilities: { '0': 0, '1': 1, '2': 0 } } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  await assert.rejects(createProvider('typesafe', { apiKey: 'fake-test-key', fetch }).evaluate(request), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.code, 'TYPESAFE_RESPONSE_INVALID');
    assert.equal(error.responseIssue, 'probability_total');
    return true;
  });
});

test('TypeSafe accepts and renormalizes small rounding drift in a distribution', async () => {
  const fetch = async (): Promise<Response> => Response.json({
    model: 'jev-test',
    answers: { choice: { type: 'choice', choice: 'alpha', confidence: 0.9, probabilities: { alpha: 0.6004, beta: 0.3, gamma: 0.1 } }, likely: { type: 'noul', noul: 0.5 }, fit: { type: 'score', score: 1, confidence: 0.5, legend: { '0': 'Poor fit', '1': 'Mixed fit', '2': 'Strong fit' }, probabilities: { '0': 0, '1': 1, '2': 0 } } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await createProvider('typesafe', { apiKey: 'fake-test-key', fetch }).evaluate(request);
  const choice = result.answers.choice as { probabilities: Record<string, number> };
  const total = Object.values(choice.probabilities).reduce((sum, value) => sum + value, 0);
  assert(Math.abs(total - 1) < 1e-12);
  assert(choice.probabilities.alpha! > choice.probabilities.beta!);
});

test('mock choice distributions remain normalized at the 255-option schema limit', async () => {
  const criteria = Object.fromEntries(Array.from({ length: 255 }, (_, index) => [`option-${index}`, `Option ${index}`]));
  const broadRequest: EvaluationRequest = {
    model: 'jev-latest', seed: 'large-choice', state: { persona: 'synthetic reviewer' },
    questions: { broad: { type: 'choice', label: 'Pick one', instructions: 'Choose the preferred option.', criteria } },
  };
  const answer = (await createProvider('mock').evaluate(broadRequest)).answers.broad;
  assert.equal(answer?.type, 'choice');
  if (answer?.type !== 'choice') return;
  const values = Object.values(answer.probabilities);
  assert.equal(values.length, 255);
  assert.ok(Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 1e-5);
  assert.equal(answer.probabilities[answer.choice], Math.max(...values));
});

test('TypeSafe rejects choices and scores inconsistent with their probabilities', async () => {
  const choiceRequest: EvaluationRequest = {
    model: request.model, seed: request.seed, state: request.state,
    questions: { choice: request.questions.choice! },
  };
  const nonLeadingChoiceFetch = async (): Promise<Response> => Response.json({
    model: 'jev-test', answers: { choice: { type: 'choice', choice: 'alpha', confidence: 0.55, probabilities: { alpha: 0.1, beta: 0.7, gamma: 0.2 } } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  await assert.rejects(createProvider('typesafe', { apiKey: 'fake-test-key', fetch: nonLeadingChoiceFetch }).evaluate(choiceRequest), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.code, 'TYPESAFE_RESPONSE_INVALID');
    assert.equal(error.responseIssue, 'choice_winner');
    assert.match(error.message, /non-leading option/);
    return true;
  });

  const scoreRequest: EvaluationRequest = {
    model: request.model, seed: request.seed, state: request.state,
    questions: { fit: request.questions.fit! },
  };
  const inconsistentScoreFetch = async (): Promise<Response> => Response.json({
    model: 'jev-test', answers: { fit: { type: 'score', score: 0.8, confidence: 0.1, legend: { '0': 'Poor fit', '1': 'Mixed fit', '2': 'Strong fit' }, probabilities: { '0': 0.1, '1': 0.4, '2': 0.5 } } },
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  await assert.rejects(createProvider('typesafe', { apiKey: 'fake-test-key', fetch: inconsistentScoreFetch }).evaluate(scoreRequest), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.code, 'TYPESAFE_RESPONSE_INVALID');
    assert.equal(error.responseIssue, 'score_mean');
    assert.match(error.message, /score inconsistent/);
    return true;
  });
});

test('TypeSafe maps HTTP failures to safe, actionable error codes', async () => {
  const cases = [
    [401, 'TYPESAFE_AUTHENTICATION_FAILED'],
    [403, 'TYPESAFE_PERMISSION_DENIED'],
    [408, 'TYPESAFE_TIMEOUT'],
    [429, 'TYPESAFE_RATE_LIMITED'],
    [529, 'TYPESAFE_RATE_LIMITED'],
    [503, 'TYPESAFE_SERVICE_UNAVAILABLE'],
    [422, 'TYPESAFE_REQUEST_REJECTED'],
  ] as const;
  for (const [status, expectedCode] of cases) {
    const secret = `fake-body-secret-${status}`;
    const fetch = async (): Promise<Response> => Response.json({ detail: secret }, { status });
    await assert.rejects(createProvider('typesafe', { apiKey: 'fake-test-key', fetch, retries: 0 }).evaluate(request), (error: unknown) => {
      assert(error instanceof ProviderError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.httpStatus, status);
      assert.equal(error.message.includes(secret), false);
      return true;
    });
  }
});

test('TypeSafe classifies connection failures without exposing transport errors', async () => {
  const secret = 'fake-transport-secret';
  const fetch = async (): Promise<Response> => { throw new Error(secret); };
  await assert.rejects(createProvider('typesafe', { apiKey: 'fake-test-key', fetch, retries: 0 }).evaluate(request), (error: unknown) => {
    assert(error instanceof ProviderError);
    assert.equal(error.code, 'TYPESAFE_CONNECTION_FAILED');
    assert.equal(error.message.includes(secret), false);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});
