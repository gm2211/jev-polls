import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { authStatus } from '../src/auth.js';
import { parseRun } from '../src/run-record.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(root, 'src/cli.ts');
const fixture = join(root, 'examples/game-naming');

interface CliResult { status: number | null; stdout: string; stderr: string; error?: Error }

function invoke(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): CliResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd,
    env: { ...env, NO_COLOR: '1' },
    encoding: 'utf8',
    timeout: 45_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', ...(result.error ? { error: result.error } : {}) };
}

function output(result: CliResult): Record<string, any> {
  assert.ifError(result.error);
  assert.doesNotThrow(() => JSON.parse(result.stdout), `Expected JSON stdout; received: ${result.stdout.slice(0, 500)}\n${result.stderr}`);
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

test('CLI commands work offline with a temporary study and mock provider', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'jev-polls-cli-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const example = join(temp, 'game-naming');
  await cp(fixture, example, { recursive: true });
  const pipelinePath = join(example, 'pipeline.json');

  const schemaResult = invoke(['schema', 'pipeline'], root);
  assert.equal(schemaResult.status, 0, schemaResult.stderr);
  const schema = output(schemaResult);
  assert.equal(schema.title, 'Jev Polls pipeline v1');
  assert.equal(schema.type, 'object');

  const planResult = invoke(['plan', pipelinePath], root);
  assert.equal(planResult.status, 0, planResult.stderr);
  const planned = output(planResult);
  assert.equal(planned.pipeline, 'game-naming');
  assert.ok(planned.maxRequests > 0);
  assert.ok(planned.stages.some((stage: { id: string }) => stage.id === 'recommendation'));

  const invalidPath = join(temp, 'bad-graph.json');
  const invalid = JSON.parse(await readFile(pipelinePath, 'utf8')) as { stages: Array<{ dependsOn: string[] }> };
  invalid.stages[0]!.dependsOn = ['missing-stage'];
  await writeFile(invalidPath, JSON.stringify(invalid));
  const badGraph = invoke(['validate', invalidPath], root);
  assert.equal(badGraph.status, 1);
  assert.match(output(badGraph).error.message, /unknown dependency|Unknown dependency/i);

  const sizes = ['--size', 'audience=4', '--size', 'blind-review=3', '--size', 'close-review=3', '--size', 'clear-review=3'];
  const runArgs = (seed: string, out: string, cache: string) => [
    'run', pipelinePath, '--provider', 'mock', '--out', out, '--cache', cache,
    '--seed', seed, '--repeats', '1', ...sizes,
  ];
  const runOneDir = join(temp, 'run-one');
  const runOne = invoke(runArgs('first-seed', runOneDir, join(temp, 'cache-one')), root);
  assert.equal(runOne.status, 0, `${runOne.stdout}\n${runOne.stderr}`);
  const runOneSummary = output(runOne);
  assert.equal(runOneSummary.status, 'completed');
  assert.equal(runOneSummary.provider, 'mock');
  assert.ok(await exists(join(runOneDir, 'run.json')));
  assert.ok((await readFile(join(runOneDir, 'report.html'), 'utf8')).includes('MOCK SIMULATION'));
  const savedRun = parseRun(JSON.parse(await readFile(join(runOneDir, 'run.json'), 'utf8')));
  assert.equal(savedRun.status, 'completed');
  assert.ok(savedRun.stages.audience?.votes.length);
  assert.ok(savedRun.stages.recommendation?.summaries.favorite);

  const overwritten = invoke(runArgs('different-seed', runOneDir, join(temp, 'cache-one')), root);
  assert.equal(overwritten.status, 1);
  assert.match(output(overwritten).error.message, /Refusing to overwrite/);
  assert.equal(JSON.parse(await readFile(join(runOneDir, 'run.json'), 'utf8')).id, savedRun.id);
  assert.equal(overwritten.stderr.includes('"event":"progress"'), false);

  const rebuiltReport = join(temp, 'rebuilt.html');
  const reportResult = invoke(['report', join(runOneDir, 'run.json'), '--out', rebuiltReport], root);
  assert.equal(reportResult.status, 0, reportResult.stderr);
  assert.equal(output(reportResult).provider, 'mock');
  assert.ok((await readFile(rebuiltReport, 'utf8')).includes('<!doctype html>'));

  const runTwoDir = join(temp, 'run-two');
  const runTwo = invoke(runArgs('second-seed', runTwoDir, join(temp, 'cache-two')), root);
  assert.equal(runTwo.status, 0, `${runTwo.stdout}\n${runTwo.stderr}`);
  const comparePath = join(temp, 'comparison.json');
  const comparisonResult = invoke([
    'compare', join(runOneDir, 'run.json'), join(runTwoDir, 'run.json'),
    '--stage', 'audience', '--question', 'favorite', '--out', comparePath,
  ], root);
  assert.equal(comparisonResult.status, 0, comparisonResult.stderr);
  const comparison = output(comparisonResult);
  assert.equal(comparison.runs.length, 2);
  assert.equal(JSON.parse(await readFile(comparePath, 'utf8')).baselineRunId, savedRun.id);

  const simulationPath = join(temp, 'simulation.json');
  const simulationResult = invoke([
    'simulate', join(runOneDir, 'run.json'), '--stage', 'audience', '--question', 'favorite',
    '--draws', '100', '--seed', 'simulation-seed', '--out', simulationPath,
  ], root);
  assert.equal(simulationResult.status, 0, simulationResult.stderr);
  const simulation = output(simulationResult);
  assert.equal(simulation.label, 'conditional on model outputs');
  assert.equal(simulation.draws, 100);
  assert.equal(simulation.metric, 'choice-share');
  assert.equal(JSON.parse(await readFile(simulationPath, 'utf8')).respondentCount, 4);

  const cohortDir = join(temp, 'cohort-library');
  const importResult = invoke(['cohort', 'import', join(example, 'players.json'), '--dir', cohortDir], root);
  assert.equal(importResult.status, 0, importResult.stderr);
  const imported = output(importResult);
  assert.equal(imported.id, 'strategy-players');
  assert.equal(imported.personas, 24);
  const listResult = invoke(['cohort', 'list', '--dir', cohortDir], root);
  assert.equal(listResult.status, 0, listResult.stderr);
  assert.equal(output(listResult).cohorts.length, 1);
  const sampledPath = join(temp, 'sampled-players.json');
  const sampleResult = invoke(['cohort', 'sample', join(example, 'players.json'), '--size', '8', '--seed', 'sample-seed', '--out', sampledPath], root);
  assert.equal(sampleResult.status, 0, sampleResult.stderr);
  assert.equal(output(sampleResult).personas, 8);
  assert.equal(JSON.parse(await readFile(sampledPath, 'utf8')).personas.length, 8);

  const failedDir = join(temp, 'failed-run');
  const limited = invoke([...runArgs('failure-seed', failedDir, join(temp, 'cache-fail')), '--max-requests', '1'], root);
  assert.equal(limited.status, 1);
  assert.equal(output(limited).status, 'failed');
  assert.equal(JSON.parse(await readFile(join(failedDir, 'run.json'), 'utf8')).status, 'failed');
  assert.ok(await exists(join(failedDir, 'report.html')));

  const auth = await authStatus();
  if (auth.configured) {
    t.skip('Cannot safely exercise the missing-credential gate while a TypeSafe key is configured.');
    return;
  }
  const missingOutput = join(temp, 'should-not-exist');
  const noKey = invoke(['run', pipelinePath, '--out', missingOutput, '--cache', join(temp, 'cache-no-key')], root, {
    ...process.env,
    TYPESAFE_API_KEY: '',
  });
  assert.equal(noKey.status, 1);
  assert.match(output(noKey).error.message, /credentials missing/i);
  assert.equal(await exists(missingOutput), false);
});
