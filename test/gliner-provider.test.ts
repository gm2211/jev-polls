import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createProvider, GLINER_MODEL, glinerStatus, ProviderError } from '../src/provider.js';
import { GLINER_REVISION } from '../src/gliner-provider.js';
import { runPipeline, validateEvaluation } from '../src/engine.js';
import { parseRun } from '../src/run-record.js';
import { renderReport } from '../src/report.js';
import { loadProject } from '../src/schema.js';
import type { EvaluationRequest } from '../src/types.js';

const request: EvaluationRequest = {
  model: GLINER_MODEL, seed: 'deterministic', state: { persona: { id: 'p1', priorities: ['price'] }, sharedContext: { budget: 80 }, stageContext: 'Consider cost' },
  questions: {
    choose: { type: 'choice', label: 'Choose product', instructions: 'Use persona budget.', criteria: { alpha: 'Low cost', beta: 'Comfort', neither: null } },
    buy: { type: 'noul', label: 'Would persona buy?', instructions: 'Use all state.' },
    fit: { type: 'score', label: 'How well does it fit?', instructions: 'Use ordered rubric.', criteria: ['Poor', 'Mixed', 'Strong'] },
  },
};

async function fixture(t: { after(fn: () => Promise<void>): void }, mode = 'valid') {
  const dir = await mkdtemp(join(tmpdir(), 'jev-gliner-bridge-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const runtimeDir = join(dir, 'runtime'); await mkdir(join(runtimeDir, 'bin'), { recursive: true });
  const pythonPath = join(runtimeDir, 'bin/python');
  await writeFile(pythonPath, `#!/bin/sh\nshift\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  await writeFile(join(runtimeDir, 'ready.json'), JSON.stringify({ model: GLINER_MODEL, revision: GLINER_REVISION, protocol: 1 }));
  const workerPath = join(dir, 'worker.mjs'), captured = join(dir, 'captured.jsonl'), pid = join(dir, 'pid');
  await writeFile(workerPath, `import { createInterface } from 'node:readline';
import { writeFileSync, appendFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(pid)},String(process.pid));
const model=${JSON.stringify(GLINER_MODEL)}, revision=${JSON.stringify(GLINER_REVISION)};
console.log(JSON.stringify({type:'ready',model,revision,protocol:1}));
let active=false;
createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);appendFileSync(${JSON.stringify(captured)},line+'\\n');
 if(${JSON.stringify(mode)}==='oversized'){console.log(JSON.stringify({id:request.id,error:{code:'input_too_large',message:'hidden raw input'}}));return;}
 if(active) {console.log(JSON.stringify({id:request.id,error:{code:'OVERLAP'}}));return;}active=true;
 const scores={},logits={};for(const [id,head] of Object.entries(request.heads)){const keys=Object.keys(head.labels);scores[id]={};logits[id]={};keys.forEach((key,i)=>{const value=${JSON.stringify(mode)}==='zero'?0: i===0?0.8:0.2; scores[id][key]=value;logits[id][key]=value===0?-1000:Math.log(value/(1-value));});}
 if(${JSON.stringify(mode)}==='missing')delete scores[Object.keys(scores)[0]];
 if(${JSON.stringify(mode)}==='badlogits')logits[Object.keys(logits)[0]][Object.keys(logits[Object.keys(logits)[0]])[0]]=100;
 setTimeout(()=>{active=false;console.log(JSON.stringify({id:request.id,model,revision,scores,logits,scoreSemantics:'independent_sigmoid',inputTokens:41}));},${mode === 'timeout' ? 10_000 : 5});
});`);
  return { config: { pythonPath, workerPath, runtimeDir, timeoutMs: mode === 'timeout' ? 300 : 5_000 }, captured, pid };
}

test('GLiNER readiness requires successful matching model setup stamp', async t => {
  const { config } = await fixture(t);
  assert.equal((await glinerStatus(config)).ready, true);
  await rm(join(config.runtimeDir, 'ready.json'));
  assert.equal((await glinerStatus(config)).ready, false);
  const provider = createProvider('gliner', { gliner: config });
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_NOT_READY');
  await provider.close!();
});

test('GLiNER reuses serialized bridge, preserves state/questions, and retains native scores without confidence', async t => {
  const { config, captured, pid } = await fixture(t);
  const provider = createProvider('gliner', { gliner: config }); t.after(() => provider.close!());
  const [first, second] = await Promise.all([provider.evaluate(request), provider.evaluate({ ...request, seed: 'different' })]);
  assert.deepEqual(first, second);
  validateEvaluation(first, request.questions);
  assert.equal(first.model, `${GLINER_MODEL}@${GLINER_REVISION}`);
  assert.equal(first.usage.tokenUsage, 'unreported');
  assert.equal(first.usage.measuredInputTokens, 41);
  assert.ok(provider.cacheIdentity?.includes(GLINER_REVISION));
  for (const answer of Object.values(first.answers)) {
    assert.ok(answer.classifier);
    assert.equal('confidence' in answer, false);
    if (answer.type !== 'noul') assert.ok(Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-8);
  }
  assert.equal(first.answers.buy?.type === 'noul' && first.answers.buy.noul, 0.8);
  const calls = (await readFile(captured, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].text), request.state);
  assert.match(calls[0].heads.choose.prompt, /Choose product\nUse persona budget\./);
  assert.deepEqual(calls[0].heads.fit.labels, { 0: 'Poor', 1: 'Mixed', 2: 'Strong' });
  assert.equal(calls[0].heads.choose.labels.neither, 'neither');
  await provider.close!();
  const childPid = Number(await readFile(pid, 'utf8'));
  assert.throws(() => process.kill(childPid, 0));
});

test('GLiNER rejects unsupported models before starting subprocess', async t => {
  const { config } = await fixture(t);
  const provider = createProvider('gliner', { gliner: config });
  await assert.rejects(provider.evaluate({ ...request, model: 'jev-latest' }), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_UNSUPPORTED_MODEL');
  await provider.close!();
});

test('GLiNER sends both structured option names and descriptions while retaining native score evidence', async t => {
  const { config, captured } = await fixture(t);
  const provider = createProvider('gliner', { gliner: config }); t.after(() => provider.close!());
  const structuredRequest: EvaluationRequest = { ...request, questions: { choose: { type: 'choice', label: 'Which concept fits?', instructions: 'Use persona budget.', criteria: { option_a: { label: 'Daily ritual', description: 'A compact kit for everyday use.' }, option_b: { label: 'Weekend escape', description: '' }, legacy: 'Existing answer', neither: null } } } };
  const result = await provider.evaluate(structuredRequest);
  validateEvaluation(result, structuredRequest.questions);
  const call = JSON.parse((await readFile(captured, 'utf8')).trim());
  assert.deepEqual(call.heads.choose.labels, { option_a: 'Daily ritual: A compact kit for everyday use.', option_b: 'Weekend escape', legacy: 'Existing answer', neither: 'neither' });
  const answer = result.answers.choose;
  assert.ok(answer?.type === 'choice');
  assert.deepEqual(Object.keys(answer.probabilities), ['option_a', 'option_b', 'legacy', 'neither']);
  assert.equal(answer.classifier?.semantics, 'independent_sigmoid');
  assert.equal('confidence' in answer, false);
  assert.ok(Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-8);
});

test('GLiNER close during asynchronous setup probe prevents subprocess creation', async t => {
  const { config, pid } = await fixture(t);
  const provider = createProvider('gliner', { gliner: config });
  const evaluation = provider.evaluate(request);
  // evaluate's serialized operation starts on this microtask and awaits the
  // filesystem readiness probe; close must take effect before that probe returns.
  await Promise.resolve();
  await provider.close!();
  try {
    await assert.rejects(evaluation, (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_RUNTIME_FAILED');
    await assert.rejects(readFile(pid, 'utf8'), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  } finally {
    // A regression must not leave its unexpectedly spawned test worker behind.
    try { process.kill(Number(await readFile(pid, 'utf8')), 'SIGKILL'); } catch {}
  }
});

for (const mode of ['missing', 'zero', 'badlogits']) test(`GLiNER rejects ${mode} native score evidence`, async t => {
  const { config } = await fixture(t, mode);
  const provider = createProvider('gliner', { gliner: config }); t.after(() => provider.close!());
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_RESPONSE_INVALID');
});

test('GLiNER timeout kills runtime and makes queued failures bounded', async t => {
  const { config, pid } = await fixture(t, 'timeout');
  const provider = createProvider('gliner', { gliner: config });
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_TIMEOUT');
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_TIMEOUT');
  await provider.close!();
  const childPid = Number(await readFile(pid, 'utf8'));
  assert.throws(() => process.kill(childPid, 0));
});

test('GLiNER pipeline round trips provenance, omits confidence, and invalidates evidence tampering', async t => {
  const { config } = await fixture(t);
  const provider = createProvider('gliner', { gliner: config }); t.after(() => provider.close!());
  const { pipeline, cohorts } = await loadProject('examples/game-naming/pipeline.json');
  const run = await runPipeline(pipeline, cohorts, { provider, model: GLINER_MODEL, seed: 'test', concurrency: 3, size: 4 });
  assert.equal(run.status, 'completed', JSON.stringify(Object.values(run.stages).map(stage => ({ id: stage.id, reason: stage.reason }))));
  assert.deepEqual(parseRun(JSON.parse(JSON.stringify(run))), run);
  for (const stage of Object.values(run.stages)) for (const summary of Object.values(stage.summaries)) assert.equal(summary.meanConfidence, undefined);
  const html = renderReport(run);
  assert.match(html, /LOCAL CLASSIFIER/); assert.match(html, /not calibrated probabilities/); assert.match(html, /Token usage and billing: unreported/);
  const corrupt = structuredClone(run);
  const vote = Object.values(corrupt.stages).flatMap(stage => stage.votes)[0]!;
  Object.values(vote.answers)[0]!.classifier!.rawScores = {};
  assert.throws(() => parseRun(corrupt), /missing native score evidence/);
});

 test('GLiNER context overflow remains actionable and closed providers refuse requests', async t => {
  const { config } = await fixture(t, 'oversized');
  const provider = createProvider('gliner', { gliner: config });
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_INPUT_TOO_LARGE' && !error.message.includes('hidden raw input'));
  await provider.close!();
  await assert.rejects(provider.evaluate(request), (error: unknown) => error instanceof ProviderError && error.code === 'GLINER_RUNTIME_FAILED');
 });
