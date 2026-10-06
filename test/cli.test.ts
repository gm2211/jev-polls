import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
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

interface RunningCli {
  child: ChildProcess;
  initialOutput: Record<string, any>;
  stdout: string;
  stderr: string;
}

async function startCli(args: string[], cwd: string): Promise<RunningCli> {
  const child = spawn(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), cli, ...args], {
    cwd,
    env: { ...process.env, TYPESAFE_API_KEY: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let ready = false;
  let resolveReady!: (value: Record<string, any>) => void;
  let rejectReady!: (error: Error) => void;
  const initial = new Promise<Record<string, any>>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timer = setTimeout(() => rejectReady(new Error(`CLI did not emit startup JSON. stderr=${stderr.slice(0, 500)}`)), 15_000);
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
    if (ready) return;
    try { resolveReady(JSON.parse(stdout.trim()) as Record<string, any>); }
    catch { /* Commander action has not finished writing the complete pretty-printed JSON yet. */ }
  });
  child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', error => rejectReady(error));
  child.once('exit', (code, signal) => {
    if (!ready) rejectReady(new Error(`CLI exited before startup JSON (code=${code}, signal=${signal}); stderr=${stderr.slice(0, 500)}`));
  });
  try {
    const initialOutput = await initial;
    ready = true;
    clearTimeout(timer);
    return {
      child, initialOutput,
      get stdout() { return stdout; },
      get stderr() { return stderr; },
    };
  } catch (error) {
    clearTimeout(timer);
    child.kill('SIGKILL');
    throw error;
  }
}

async function stopCli(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()));
  child.kill('SIGINT');
  await Promise.race([exited, delay(3000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
  assert.equal(child.exitCode, 0, 'workspace CLI should exit cleanly on SIGINT');
}

test('init creates an empty workspace by default and copies examples only when requested', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'jev-polls-init-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const directory = join(temp, 'research');
  const initialized = invoke(['init', directory], root);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(initialized.stderr, '');
  const created = output(initialized);
  assert.equal(created.directory, directory);
  assert.equal(created.workspace, join(directory, 'workspace.json'));
  assert.deepEqual(created.next, [`jev-polls workspace --directory ${directory}`]);
  assert.equal(created.pipeline, undefined);
  assert.doesNotMatch(initialized.stdout, /game-naming|name worth|illustrative/i);
  assert.deepEqual(await readdir(directory), ['workspace.json']);
  const originalWorkspace = await readFile(created.workspace, 'utf8');
  assert.deepEqual(JSON.parse(originalWorkspace), { revision: 1, document: { version: 1, cohorts: [], pipelines: [], projects: [] } });

  for (const args of [['init', directory], ['init', directory, '--example', 'game-naming']]) {
    const refused = invoke(args, root);
    assert.equal(refused.status, 1);
    assert.match(output(refused).error.message, /Refusing to overwrite/);
    assert.equal(await readFile(created.workspace, 'utf8'), originalWorkspace);
  }

  const exampleDirectory = join(temp, 'example');
  const example = invoke(['init', exampleDirectory, '--example', 'game-naming'], root);
  assert.equal(example.status, 0, example.stderr);
  const copied = output(example);
  assert.equal(copied.example, 'game-naming');
  assert.equal(copied.pipeline, join(exampleDirectory, 'pipeline.json'));
  assert.equal(await exists(join(exampleDirectory, 'workspace.json')), false);
  const validated = invoke(['validate', copied.pipeline], root);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(output(validated).valid, true);
  assert.equal(output(validated).id, 'game-naming');
  const originalPipeline = await readFile(copied.pipeline, 'utf8');
  const refusedExample = invoke(['init', exampleDirectory, '--example', 'game-naming'], root);
  assert.equal(refusedExample.status, 1);
  assert.match(output(refusedExample).error.message, /Refusing to overwrite/);
  assert.equal(await readFile(copied.pipeline, 'utf8'), originalPipeline);

  const invalidDirectory = join(temp, 'invalid');
  const invalidExample = invoke(['init', invalidDirectory, '--example', 'unknown'], root);
  assert.equal(invalidExample.status, 1);
  assert.match(output(invalidExample).error.message, /Allowed choices|invalid/i);
  assert.equal(await exists(invalidDirectory), false);
});

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

test('workspace opens empty without running; connect imports a pipeline for editing only', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'jev-polls-workspace-cli-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));

  const emptyDirectory = join(temp, 'empty-workspace');
  const initialized = invoke(['init', emptyDirectory], root);
  assert.equal(initialized.status, 0, initialized.stderr);
  const empty = await startCli(['workspace', '--directory', emptyDirectory], temp);
  t.after(() => stopCli(empty.child));
  assert.equal(empty.initialOutput.status, 'workspace-ready');
  assert.match(empty.initialOutput.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
  assert.deepEqual(JSON.parse(empty.stdout.trim()), empty.initialOutput, 'stdout contains only the startup JSON object');
  assert.match(empty.initialOutput.note, /never runs a study/i);
  const page = await fetch(empty.initialOutput.url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Research workspace'), 'CLI serves the browser workspace');
  const emptyStateResponse = await fetch(new URL('/api/workspace', empty.initialOutput.url));
  assert.equal(emptyStateResponse.status, 200);
  const emptyState = await emptyStateResponse.json() as { document: { version: number; cohorts: unknown[]; pipelines: unknown[] }; runs: unknown[]; activeRun: unknown };
  assert.deepEqual(emptyState.document, { version: 1, cohorts: [], pipelines: [], projects: [] });
  assert.deepEqual(emptyState.runs, []);
  assert.equal(emptyState.activeRun, null);
  await delay(100);
  assert.equal(empty.child.exitCode, null, 'workspace remains open for user actions');
  assert.doesNotMatch(empty.stderr, /"event":"(?:progress|workspace-run)"/);
  assert.equal(await exists(join(emptyDirectory, 'runs')), false);
  await stopCli(empty.child);

  const importedDirectory = join(temp, 'imported-workspace');
  const imported = await startCli(['connect', join(fixture, 'pipeline.json'), '--directory', importedDirectory], temp);
  t.after(() => stopCli(imported.child));
  assert.equal(imported.initialOutput.status, 'workspace-ready');
  assert.deepEqual(JSON.parse(imported.stdout.trim()), imported.initialOutput, 'stdout contains only the startup JSON object');
  assert.match(imported.initialOutput.note, /never runs a study/i);
  const saved = JSON.parse(await readFile(join(importedDirectory, 'workspace.json'), 'utf8')) as {
    revision: number;
    document: { cohorts: Array<{ id: string }>; pipelines: Array<{ id: string; cohorts: Record<string, string> }>; projects: Array<{ name: string; cohortIds: string[]; pipelineIds: string[] }> };
  };
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.document.cohorts.map(cohort => cohort.id).sort(), ['review-panel', 'strategy-players']);
  assert.equal(saved.document.pipelines.length, 1);
  assert.equal(saved.document.projects.length, 1);
  assert.deepEqual(saved.document.projects[0]!.pipelineIds, ['game-naming']);
  assert.deepEqual([...saved.document.projects[0]!.cohortIds].sort(), ['review-panel', 'strategy-players']);
  assert.equal(saved.document.pipelines[0]?.id, 'game-naming');
  assert.deepEqual(saved.document.pipelines[0]?.cohorts, { players: 'strategy-players', reviewers: 'review-panel' });
  const importedState = await (await fetch(new URL('/api/workspace', imported.initialOutput.url))).json() as { runs: unknown[]; activeRun: unknown };
  assert.deepEqual(importedState.runs, []);
  assert.equal(importedState.activeRun, null);
  await delay(100);
  assert.equal(imported.child.exitCode, null);
  assert.doesNotMatch(imported.stderr, /"event":"(?:progress|workspace-run)"/);
  assert.equal(await exists(join(importedDirectory, 'runs')), false);
  await stopCli(imported.child);

  const malformedPath = join(temp, 'malformed-pipeline.json');
  await writeFile(malformedPath, '{ not json');
  const invalid = invoke(['connect', malformedPath, '--directory', join(temp, 'must-not-start')], root);
  assert.equal(invalid.status, 1);
  const errorOutput = output(invalid);
  assert.equal(typeof errorOutput.error.code, 'string');
  assert.match(errorOutput.error.message, /JSON|parse|valid/i);
  assert.deepEqual(JSON.parse(invalid.stdout.trim()), errorOutput, 'failures also emit only one JSON object to stdout');
  assert.equal(invalid.stderr, '');
  assert.equal(await exists(join(temp, 'must-not-start')), false);
});

test('connect imports an isolated project beside legacy research and reimports without duplicating or overwriting it', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'jev-polls-cli-projects-'));
  t.after(async () => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source');
  await cp(fixture, source, { recursive: true });
  const directory = join(temp, 'workspace');
  const file = join(source, 'pipeline.json');
  const first = await startCli(['connect', file, '--directory', directory], temp);
  t.after(() => stopCli(first.child));
  await stopCli(first.child);
  const workspaceFile = join(directory, 'workspace.json');
  const original = JSON.parse(await readFile(workspaceFile, 'utf8'));
  delete original.document.projects; // An existing version-1 workspace before project grouping.
  await writeFile(workspaceFile, JSON.stringify(original));

  const pipeline = JSON.parse(await readFile(file, 'utf8'));
  pipeline.id = 'another-study'; pipeline.name = 'Another research project';
  await writeFile(file, JSON.stringify(pipeline));
  const second = await startCli(['connect', file, '--directory', directory], temp);
  t.after(() => stopCli(second.child));
  await stopCli(second.child);
  const savedText = await readFile(workspaceFile, 'utf8');
  const saved = JSON.parse(savedText);
  const legacy = saved.document.projects.find((p: any) => p.id === 'existing-research');
  const added = saved.document.projects.find((p: any) => p.pipelineIds.includes('another-study'));
  assert.ok(legacy); assert.ok(added);
  assert.equal(added.name, pipeline.name);
  assert.deepEqual(legacy.pipelineIds, ['game-naming']);
  assert.deepEqual(saved.document.pipelines[0], original.document.pipelines[0]);
  assert.deepEqual(saved.document.cohorts.slice(0, original.document.cohorts.length), original.document.cohorts);
  assert.equal(saved.document.cohorts.length, original.document.cohorts.length * 2);
  assert.ok(added.cohortIds.every((id: string) => !legacy.cohortIds.includes(id)));
  const importedPipeline = saved.document.pipelines.find((p: any) => p.id === 'another-study');
  for (const [alias, id] of Object.entries(importedPipeline.cohorts)) {
    assert.ok(added.cohortIds.includes(id));
    const cloned = saved.document.cohorts.find((c: any) => c.id === id);
    const originalCohort = original.document.cohorts.find((c: any) => c.id === original.document.pipelines[0].cohorts[alias]);
    assert.deepEqual({ ...cloned, id: originalCohort.id }, originalCohort);
  }

  const repeated = await startCli(['connect', file, '--directory', directory], temp);
  t.after(() => stopCli(repeated.child));
  await stopCli(repeated.child);
  assert.equal(await readFile(workspaceFile, 'utf8'), savedText, 'identical reimport does not change revisions or ownership');
  pipeline.name = 'Conflicting renamed study';
  await writeFile(file, JSON.stringify(pipeline));
  const conflict = invoke(['connect', file, '--directory', directory], root);
  assert.equal(conflict.status, 1);
  assert.match(output(conflict).error.message, /already exists with different content/);
  assert.equal(await readFile(workspaceFile, 'utf8'), savedText, 'conflicting import preserves every project');
});
