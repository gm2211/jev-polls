import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { ProviderError } from './provider.js';
import type { Answer, Evaluation, EvaluationRequest, LabelScoreEvidence, Provider, Question } from './types.js';

export const GLINER_MODEL = 'fastino/GLiNER2.5-Decide';
export const GLINER_REVISION = '5a7adf72a23b4d311abae6ce050d7f0012bb3416';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export interface GlinerConfig { pythonPath?: string; workerPath?: string; runtimeDir?: string; timeoutMs?: number }
export interface GlinerStatus { ready: boolean; model: string; revision: string; pythonPath: string; workerPath: string; message?: string }
function paths(config: GlinerConfig) {
  const runtimeDir = resolve(config.runtimeDir ?? resolve(repoRoot, '.jev-polls/gliner'));
  return { runtimeDir, pythonPath: resolve(config.pythonPath ?? resolve(runtimeDir, 'bin/python')), workerPath: resolve(config.workerPath ?? resolve(repoRoot, 'scripts/gliner_runtime.py')) };
}
export async function glinerStatus(config: GlinerConfig = {}): Promise<GlinerStatus> {
  const selected = paths(config);
  const base = { model: GLINER_MODEL, revision: GLINER_REVISION, pythonPath: selected.pythonPath, workerPath: selected.workerPath };
  try {
    await Promise.all([access(selected.pythonPath, constants.X_OK), access(selected.workerPath, constants.R_OK)]);
    const stamp = JSON.parse(await readFile(resolve(selected.runtimeDir, 'ready.json'), 'utf8')) as Record<string, unknown>;
    if (stamp.model !== GLINER_MODEL || stamp.revision !== GLINER_REVISION || stamp.protocol !== 1) throw new Error('setup stamp mismatch');
    return { ...base, ready: true };
  } catch {
    return { ...base, ready: false, message: 'GLiNER local runtime needs setup. Run npm run setup:gliner to install the classifier and download its model.' };
  }
}

function labelsFor(question: Question): Record<string, string> {
  if (question.type === 'noul') return { yes: 'Yes: the condition in the question holds.', no: 'No: the condition in the question does not hold.' };
  if (question.type === 'score') return Object.fromEntries(question.criteria.map((criterion, index) => [String(index), criterion]));
  return Object.fromEntries(Object.entries(question.criteria).map(([label, description]) => [label, description ?? label]));
}

export function validateClassifierAnswer(answer: Answer, question: Question): void {
  const evidence = answer.classifier;
  const keys = Object.keys(labelsFor(question));
  if (!evidence || evidence.semantics !== 'independent_sigmoid' || !evidence.rawScores || !evidence.rawLogits || Object.keys(evidence.rawScores).length !== keys.length || Object.keys(evidence.rawLogits).length !== keys.length) throw new Error('Classifier answer is missing native score evidence.');
  if (answer.type !== 'noul' && answer.confidence !== undefined) throw new Error('Classifier answer must not claim calibrated confidence.');
  for (const key of keys) {
    const score = evidence.rawScores[key], logit = evidence.rawLogits[key];
    if (!Number.isFinite(score) || score! < 0 || score! > 1 || !Number.isFinite(logit) || Math.abs(score! - 1 / (1 + Math.exp(-logit!))) > 1e-6) throw new Error('Classifier scores must match their native sigmoid logits.');
  }
  const total = keys.reduce((sum, key) => sum + evidence.rawScores[key]!, 0);
  if (!(total > 0)) throw new Error('Classifier label score total must be positive.');
  const normalized = Object.fromEntries(keys.map(key => [key, evidence.rawScores[key]! / total]));
  if (answer.type === 'noul') {
    if (Math.abs(answer.noul - normalized.yes!) > 1e-8) throw new Error('Classifier Noul value must match relative label scores.');
  } else if (keys.some(key => Math.abs((answer.probabilities?.[key] ?? NaN) - normalized[key]!) > 1e-8 || !Number.isFinite(answer.probabilities?.[key]))) throw new Error('Classifier distribution must match relative label scores.');
}

/** Relative normalization makes scores usable by existing weighted pipeline arithmetic, without inventing model confidence. */
function convert(request: EvaluationRequest, response: Record<string, unknown>): Evaluation {
  if (response.model !== GLINER_MODEL || response.revision !== GLINER_REVISION || response.scoreSemantics !== 'independent_sigmoid') throw new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER returned incompatible model or score metadata.');
  const scoreMap = response.scores as Record<string, Record<string, number>> | undefined;
  const logitMap = response.logits as Record<string, Record<string, number>> | undefined;
  const ids = Object.keys(request.questions);
  if (!scoreMap || !logitMap || ids.length !== Object.keys(scoreMap).length || ids.length !== Object.keys(logitMap).length) throw new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER returned incomplete question scores.');
  const answers: Record<string, Answer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const keys = Object.keys(labelsFor(question));
    const rawScores = scoreMap[id], rawLogits = logitMap[id];
    if (!rawScores || !rawLogits || Array.isArray(rawScores) || Array.isArray(rawLogits) || Object.keys(rawScores).length !== keys.length || Object.keys(rawLogits).length !== keys.length || keys.some(key => !Number.isFinite(rawScores[key]) || rawScores[key]! < 0 || rawScores[key]! > 1 || !Number.isFinite(rawLogits[key]))) throw new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER returned incomplete or invalid label scores.');
    // Preserve the native scores and logits so exports reveal exactly what was normalized.
    const classifier: LabelScoreEvidence = { semantics: 'independent_sigmoid', rawScores: { ...rawScores }, rawLogits: { ...rawLogits } };
    const total = keys.reduce((sum, key) => sum + rawScores[key]!, 0);
    if (!(total > 0)) throw new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER returned zero total label score; relative normalization is undefined.');
    const probabilities = Object.fromEntries(keys.map(key => [key, rawScores[key]! / total]));
    if (question.type === 'noul') answers[id] = { type: 'noul', noul: probabilities.yes!, classifier };
    else if (question.type === 'choice') {
      const choice = keys.reduce((best, key) => probabilities[key]! > probabilities[best]! ? key : best, keys[0]!);
      answers[id] = { type: 'choice', choice, probabilities, classifier };
    } else answers[id] = { type: 'score', score: keys.reduce((sum, key, index) => sum + probabilities[key]! * index, 0), probabilities, legend: labelsFor(question), classifier };
  }
  try { for (const [id, answer] of Object.entries(answers)) validateClassifierAnswer(answer, request.questions[id]!); }
  catch { throw new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER returned inconsistent native label scores or logits.'); }
  if (response.inputTokens !== undefined && (!Number.isSafeInteger(response.inputTokens) || (response.inputTokens as number) < 0)) throw new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER returned invalid tokenizer counts.');
  return { answers, model: `${GLINER_MODEL}@${GLINER_REVISION}`, usage: { inputTokens: 0, outputTokens: 0, tokenUsage: 'unreported', ...(response.inputTokens !== undefined ? { measuredInputTokens: response.inputTokens as number } : {}) } };
}

interface Pending { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
export function createGlinerProvider(config: GlinerConfig = {}): Provider {
  const selected = paths(config);
  const timeout = config.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('GLiNER timeout must be positive.');
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready: Promise<void> | undefined;
  let pending: Pending | undefined;
  let readyResolve: (() => void) | undefined;
  let readyReject: ((error: Error) => void) | undefined;
  let queue = Promise.resolve();
  let closed = false;
  let sequence = 0;
  let expectedId: number | undefined;
  let fatalError: ProviderError | undefined;
  const stop = (error: ProviderError): void => {
    fatalError ??= error;
    readyReject?.(fatalError);
    pending?.reject(fatalError);
    pending = undefined;
    child?.kill('SIGKILL');
  };
  const start = async (): Promise<void> => {
    if (closed) throw new ProviderError('GLINER_RUNTIME_FAILED', 'GLiNER provider is closed.');
    if (fatalError) throw fatalError;
    if (ready) return ready;
    const status = await glinerStatus(config);
    // close() may run while the asynchronous setup probe is in progress.
    if (closed) throw new ProviderError('GLINER_RUNTIME_FAILED', 'GLiNER provider is closed.');
    if (fatalError) throw fatalError;
    if (!status.ready) throw new ProviderError('GLINER_NOT_READY', status.message!);
    ready = new Promise<void>((resolveReady, rejectReady) => { readyResolve = resolveReady; readyReject = rejectReady; });
    child = spawn(selected.pythonPath, ['-u', selected.workerPath, '--runtime-dir', selected.runtimeDir], { cwd: repoRoot, env: { ...process.env, JEV_GLINER_RUNTIME_DIR: selected.runtimeDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    // Model/library diagnostics can contain input text. Drain stderr without reflecting it into reports or stdout.
    child.stderr.resume();
    child.on('error', () => stop(new ProviderError('GLINER_RUNTIME_FAILED', 'Could not launch GLiNER runtime. Run npm run setup:gliner.')));
    child.on('exit', () => {
      if (!closed) stop(new ProviderError('GLINER_RUNTIME_FAILED', 'GLiNER runtime exited before completing inference. Run npm run setup:gliner to repair the runtime.'));
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.type === 'ready') {
          if (value.protocol !== 1 || value.model !== GLINER_MODEL || value.revision !== GLINER_REVISION) throw new Error('incompatible runtime');
          readyResolve?.(); readyReject = undefined; readyResolve = undefined;
        } else if (value.type === 'error' && !pending) {
          stop(new ProviderError('GLINER_NOT_READY', 'GLiNER could not load its local model. Run npm run setup:gliner.'));
        } else if (pending && value.id === expectedId) {
          const active = pending; pending = undefined;
          if (value.error) {
            const code = (value.error as Record<string, unknown>).code;
            active.reject(new ProviderError(code === 'input_too_large' ? 'GLINER_INPUT_TOO_LARGE' : 'GLINER_RUNTIME_FAILED', code === 'input_too_large' ? 'GLiNER input exceeds the model context limit. Shorten study context or persona fields.' : 'GLiNER inference failed. Check the local runtime and question definitions.'));
          } else active.resolve(value);
        } else throw new Error('unexpected response');
      } catch { stop(new ProviderError('GLINER_RESPONSE_INVALID', 'GLiNER runtime returned an invalid protocol response.')); }
    });
    const timer = setTimeout(() => stop(new ProviderError('GLINER_TIMEOUT', 'GLiNER model loading timed out. Increase the local inference timeout or repair setup.')), timeout);
    try { await ready; } finally { clearTimeout(timer); }
  };
  return {
    name: 'gliner',
    cacheIdentity: `gliner-jsonl-v1:relative-sigmoid-v1:${GLINER_MODEL}@${GLINER_REVISION}`,
    evaluate(request) {
      const operation = queue.then(async () => {
        if (request.model !== GLINER_MODEL) throw new ProviderError('GLINER_UNSUPPORTED_MODEL', `GLiNER supports only ${GLINER_MODEL}.`);
        await start();
        expectedId = ++sequence;
        const message = { id: expectedId, action: 'evaluate', text: JSON.stringify(request.state), heads: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [id, { prompt: `${question.label}\n${question.instructions}`, labels: labelsFor(question) }])) };
        const response = new Promise<Record<string, unknown>>((resolveResponse, reject) => { pending = { resolve: resolveResponse, reject }; });
        const timer = setTimeout(() => stop(new ProviderError('GLINER_TIMEOUT', 'GLiNER inference timed out. Retry with a smaller input or increase the local inference timeout.')), timeout);
        child!.stdin.write(`${JSON.stringify(message)}\n`, error => { if (error) stop(new ProviderError('GLINER_RUNTIME_FAILED', 'Could not send request to GLiNER runtime.')); });
        try { return convert(request, await response); } finally { clearTimeout(timer); }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async close() {
      if (closed) return;
      closed = true;
      pending?.reject(new ProviderError('GLINER_RUNTIME_FAILED', 'GLiNER provider closed during inference.'));
      readyReject?.(new ProviderError('GLINER_RUNTIME_FAILED', 'GLiNER provider closed during model loading.'));
      pending = undefined;
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>(resolveExit => child!.once('exit', () => resolveExit()));
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}
