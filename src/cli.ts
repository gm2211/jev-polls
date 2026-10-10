#!/usr/bin/env node
import { Command, Option } from 'commander';
import { cp, mkdir, readdir, readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseCohort, parsePipeline, loadProject, stageOrder, jsonSchema } from './schema.js';
import { runPipeline, selectPersonas } from './engine.js';
import { compareRuns, simulateVotes } from './analysis.js';
import { GLINER_MODEL } from './gliner-provider.js';
import { createProvider } from './provider.js';
import { authStatus, setApiKey } from './auth.js';
import { verifyTypeSafeConnection } from './auth-check.js';
import { startWorkspaceServer } from './workspace.js';
import { WorkspaceStore, emptyWorkspaceDocument } from './workspace-store.js';
import { agentConnectionConfig } from './agent-config.js';
import { renderReport } from './report.js';
import { loadRun } from './run-record.js';
import { hashValue } from './engine-utils.js';
import { enforceBudgets, estimateBudgets } from './request-budget.js';
import { readJson, writeJson, writeText } from './io.js';
import type { Pipeline, Cohort } from './types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = (data: unknown) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error('Expected a positive integer');
  return Number(value);
}
function collect(value: string, previous: string[]) { return [...previous, value]; }
async function absent(path: string) { try { await access(path); } catch { return; } throw new Error(`Refusing to overwrite existing path: ${path}`); }

const program = new Command().name('jev-polls').description('Reusable synthetic audiences and branching Jev research pipelines. JSON on stdout; progress on stderr.').version('0.1.0');
program.option('--json', 'Emit machine-readable output (already the default)').showHelpAfterError(false).exitOverride();
program.configureOutput({ writeErr: () => {} });

program.command('init').argument('[directory]', 'New workspace directory', 'study')
  .addOption(new Option('--example <example>', 'Copy an illustrative CLI project instead of creating an empty workspace').choices(['game-naming']))
  .description('Create an empty research workspace; examples require --example').action(async (directory, opts) => {
  const destination = resolve(directory); await absent(destination);
  await mkdir(dirname(destination), { recursive: true });
  if (opts.example) {
    await cp(join(root, 'examples', opts.example), destination, { recursive: true, force: false, errorOnExist: true });
    output({ directory: destination, example: opts.example, pipeline: join(destination, 'pipeline.json'), next: [`jev-polls validate ${join(destination, 'pipeline.json')}`, `jev-polls connect ${join(destination, 'pipeline.json')}`], note: 'Example names, profiles and weights are illustrative. Replace them with your brief and researched cohort.' });
    return;
  }
  await mkdir(destination);
  await new WorkspaceStore(destination).save(emptyWorkspaceDocument(), 0);
  output({ directory: destination, workspace: join(destination, 'workspace.json'), next: [`jev-polls workspace --directory ${destination}`], note: 'Empty workspace created. Set up your own cohorts, questions and pipeline in the browser before running a study.' });
});

program.command('schema').argument('<kind>', 'pipeline or cohort').description('Print JSON Schema for an agent or editor').action(kind => {
  if (!['pipeline', 'cohort'].includes(kind)) throw new Error('Schema kind must be pipeline or cohort');
  output(jsonSchema(kind));
});

program.command('guide').description('Print agent workflow, file contracts, and research requirements').action(async () => {
  output({ guide: await readFile(join(root, 'docs/agent-guide.md'), 'utf8') });
});

program.command('validate').argument('<file>').description('Validate a pipeline and referenced cohorts, or a cohort').action(async file => {
  const input = await readJson(file);
  if (typeof input === 'object' && input !== null && 'personas' in input) {
    const cohort = parseCohort(input); output({ valid: true, kind: 'cohort', id: cohort.id, personas: cohort.personas.length, segments: cohort.segments.length });
  } else {
    const { pipeline, cohorts } = await loadProject(file); output({ valid: true, kind: 'pipeline', id: pipeline.id, stages: pipeline.stages.length, order: stageOrder(pipeline).map(s => s.id), cohorts: Object.fromEntries(Object.entries(cohorts).map(([key, c]) => [key, c.personas.length])) });
  }
});

function plan(pipeline: Pipeline, cohorts: Record<string, Cohort>) {
  const budgets = estimateBudgets(pipeline, cohorts, stageOrder(pipeline));
  const budgetWarnings = enforceBudgets(budgets);
  const eligible = (c: Cohort) => c.personas.filter(p => c.segments.some(s => s.id === p.segment && s.weight > 0)).length;
  const stages = stageOrder(pipeline).map(s => ({ id: s.id, kind: s.kind, dependsOn: s.dependsOn, join: s.join ?? 'all', conditional: !!s.when, ...(s.kind === 'poll' ? { cohort: s.cohort, respondents: s.size ?? eligible(cohorts[s.cohort]), repeats: s.repeats ?? 1, questionsPerRequest: Object.keys(s.questions).length, maxRequests: (s.size ?? eligible(cohorts[s.cohort])) * (s.repeats ?? 1) * (budgets[s.id]?.batching?.requestsPerRun ?? 1), ...(budgets[s.id] ? { jevRequestSize: { ...budgets[s.id], batching: undefined } } : {}), ...(budgets[s.id]?.batching ? { batching: budgets[s.id]!.batching } : {}) } : { maxRequests: 0 }) }));
  return { pipeline: pipeline.id, stages, ...(budgetWarnings.length ? { warnings: budgetWarnings } : {}), maxRequests: stages.reduce((sum, s) => sum + s.maxRequests, 0), note: 'Upper bound includes mutually exclusive branches; cached responses use no new request. jevRequestSize estimates the largest request per step against Jev limits (32,000 tokens for persona details plus the longest question; 64,000 in total); steps over a limit fail this plan. A step with a batched input lists its layers: layerRequests are requests per respondent and repeat, the map layer first, then each combining round.' };
}
program.command('plan').argument('<pipeline>').description('Inspect graph and maximum request count without credentials or API calls').action(async file => { const { pipeline, cohorts } = await loadProject(file); output(plan(pipeline, cohorts)); });

async function openWorkspace(file: string | undefined, opts: { directory?: string; port?: number }) {
  if (opts.port && opts.port > 65535) throw new Error('Port must be at most 65535');
  const directory = resolve(opts.directory ?? '.jev-polls/workspace');
  if (file) {
    const project = await loadProject(file);
    const store = new WorkspaceStore(directory);
    const saved = await store.read();
    const draft = structuredClone(saved.document);
    const pipeline = { ...project.pipeline, cohorts: Object.fromEntries(Object.entries(project.cohorts).map(([alias, cohort]) => [alias, cohort.id])) };
    const existing = draft.pipelines.find(p => p.id === pipeline.id);
    if (existing) {
      // Reimport is idempotent even when this project's cohorts were cloned on first import.
      const sameCohorts = Object.keys(project.cohorts).length === Object.keys(existing.cohorts).length && Object.entries(project.cohorts).every(([alias, cohort]) => {
        const savedCohort = draft.cohorts.find(c => c.id === existing.cohorts[alias]);
        return savedCohort && hashValue(savedCohort) === hashValue({ ...cohort, id: savedCohort.id });
      });
      if (!sameCohorts || hashValue(existing) !== hashValue({ ...pipeline, cohorts: existing.cohorts })) {
        throw new Error(`Study ${pipeline.id} already exists with different content. Import under a new id to preserve it.`);
      }
    } else {
      const freshId = (base: string, used: Set<string>) => {
        let candidate = base.slice(0, 160), suffix = 2;
        while (used.has(candidate)) {
          const tail = `-${suffix++}`;
          candidate = `${base.slice(0, 160 - tail.length)}${tail}`;
        }
        used.add(candidate); return candidate;
      };
      const used = new Set(draft.cohorts.map(c => c.id));
      const imported = new Map<string, { id: string; hash: string }>();
      for (const [alias, cohort] of Object.entries(project.cohorts)) {
        let copy = imported.get(cohort.id);
        if (copy && copy.hash !== hashValue(cohort)) throw new Error(`Imported cohort ${cohort.id} has conflicting content across aliases.`);
        if (!copy) {
          copy = { id: freshId(cohort.id, used), hash: hashValue(cohort) };
          imported.set(cohort.id, copy); draft.cohorts.push({ ...cohort, id: copy.id });
        }
        pipeline.cohorts[alias] = copy.id;
      }
      const projects = draft.projects ?? [];
      projects.push({ id: freshId(`project-${pipeline.id}`, new Set(projects.map(p => p.id))), name: pipeline.name, description: pipeline.description, cohortIds: [...imported.values()].map(c => c.id), pipelineIds: [pipeline.id] });
      draft.projects = projects;
      draft.pipelines.push(pipeline);
      await store.save(draft, saved.revision);
    }
  }
  const workspace = await startWorkspaceServer({ directory, port: opts.port, emit: event => process.stderr.write(JSON.stringify(event) + '\n') });
  const shutdown = () => { void workspace.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  output({ status: 'workspace-ready', url: workspace.url, directory, note: 'Create or open a project, add its cohorts and pipeline, then review before choosing Run study. Opening the workspace or connecting an account never runs a study.' });
}
program.command('workspace').option('--directory <directory>', 'Saved workspace directory').option('--port <port>', 'Local workspace port', integer)
  .description('Open the cohort builder, visual pipeline editor, and run history').action(opts => openWorkspace(undefined, opts));
program.command('connect').argument('[pipeline]', 'Optional existing pipeline to import for editing; never runs automatically')
  .option('--directory <directory>', 'Saved workspace directory').option('--port <port>', 'Local workspace port', integer)
  .description('Connect TypeSafe and set up studies in the browser workspace').action(openWorkspace);

program.command('mcp').option('--workspace-url <url>', 'Running loopback workspace URL', 'http://127.0.0.1:4181/')
  .description('Connect an existing agent to this workspace over MCP stdio')
  .action(async opts => { const { startResearchMcpServer } = await import('./mcp.js'); await startResearchMcpServer(opts.workspaceUrl); });
program.command('mcp-config').option('--workspace-url <url>', 'Running loopback workspace URL', 'http://127.0.0.1:4181/')
  .description('Print credential-free Codex, Claude Code, and MCP client configuration')
  .action(opts => { output(agentConnectionConfig(opts.workspaceUrl)); });

program.command('run').argument('<pipeline>').description('Execute pipeline, resume exact cached evaluations, and write JSON plus standalone HTML')
  .addOption(new Option('--provider <provider>', 'typesafe for hosted Jev, gliner for local GLiNER2.5-Decide, mock for demonstrations').choices(['typesafe', 'gliner', 'mock']).default('typesafe'))
  .option('--out <directory>', 'Output directory (contains run.json and report.html)')
  .option('--overwrite', 'Replace run artifacts already present in the output directory')
  .option('--model <model>', 'Provider model/version; defaults to Jev or the pinned GLiNER model')
  .option('--seed <seed>', 'Reproducible profile sampling and option order', '1')
  .option('--concurrency <count>', 'Maximum in-flight evaluations across all stages', integer, 8)
  .option('--max-requests <count>', 'Maximum new evaluations (SDK retries may add HTTP attempts)', integer, 1000)
  .option('--repeats <count>', 'Override repetitions on every poll stage', integer)
  .option('--size <stage=count>', 'Override one poll stage sample size; may be repeated', collect, [])
  .option('--cache <directory>', 'Cache directory', '.jev-polls/cache')
  .option('--refresh', 'Ignore saved evaluations and issue fresh calls')
  .action(async (file, opts) => {
    const project = await loadProject(file);
    for (const entry of opts.size as string[]) {
      const match = /^([a-z][a-z0-9_-]*)=(\d+)$/.exec(entry); if (!match) throw new Error('--size expects stage=count');
      const stage = project.pipeline.stages.find(s => s.id === match[1]); if (!stage || stage.kind !== 'poll') throw new Error(`Unknown poll stage: ${match[1]}`);
      stage.size = integer(match[2]);
      const c = project.cohorts[stage.cohort];
      const active = new Set(c.segments.filter(s => s.weight > 0).map(s => s.id));
      if (stage.size > c.personas.filter(p => active.has(p.segment)).length) throw new Error(`Stage ${stage.id}: requested more people than eligible distinct profiles; expand the cohort first`);
      if (stage.size < active.size) throw new Error(`Stage ${stage.id}: sample size must cover all ${active.size} positive-weight segments`);
    }
    if (opts.repeats) for (const s of project.pipeline.stages) if (s.kind === 'poll') s.repeats = opts.repeats;
    project.pipeline = parsePipeline(project.pipeline);
    if (opts.provider === 'typesafe' && !(await authStatus()).configured) throw new Error('TypeSafe credentials missing. Run jev-polls connect with your pipeline path to prepare a study in the browser workspace, or jev-polls auth set for a hidden terminal prompt.');
    const directory = resolve(opts.out ?? `.jev-polls/runs/${project.pipeline.id}-${Date.now()}-${randomUUID().slice(0, 8)}`);
    if (!opts.overwrite) {
      await absent(join(directory, 'run.json'));
      await absent(join(directory, 'report.html'));
    }
    const provider = createProvider(opts.provider);
    const model = opts.model ?? (opts.provider === 'gliner' ? GLINER_MODEL : 'jev-1.13.0');
    const run = await runPipeline(project.pipeline, project.cohorts, { provider, model, seed: opts.seed, concurrency: opts.concurrency, maxRequests: opts.maxRequests, cacheDir: resolve(opts.cache), refresh: !!opts.refresh, onProgress: event => process.stderr.write(JSON.stringify({ event: 'progress', ...event }) + '\n') }).finally(() => provider.close?.());
    await writeJson(join(directory, 'run.json'), run);
    await writeText(join(directory, 'report.html'), renderReport(run));
    output({ status: run.status, id: run.id, provider: run.provider, usage: run.usage, stages: Object.fromEntries(Object.entries(run.stages).map(([id, s]) => [id, { status: s.status, reason: s.reason, summaries: s.summaries }])), warnings: run.warnings, files: { run: join(directory, 'run.json'), report: join(directory, 'report.html') } });
    if (run.status === 'failed') process.exitCode = 1;
  });

program.command('report').argument('<run>').requiredOption('--out <file>', 'Standalone HTML path').description('Rebuild report from a saved run; no inference').action(async (file, opts) => {
  const run = await loadRun(file); await writeText(resolve(opts.out), renderReport(run)); output({ report: resolve(opts.out), provider: run.provider });
});

program.command('compare').argument('<runs...>').requiredOption('--stage <id>').requiredOption('--question <id>').option('--out <file>', 'Save comparison JSON').description('Compare repeated runs without treating them as independent people').action(async (files, opts) => {
  const runs = await Promise.all((files as string[]).map(loadRun)); const comparison = compareRuns(runs, opts.stage, opts.question);
  if (opts.out) await writeJson(resolve(opts.out), comparison); output(comparison);
});

program.command('simulate').argument('<run>').requiredOption('--stage <id>').requiredOption('--question <id>').option('--draws <count>', 'Number of conditional virtual elections', integer, 1000).option('--seed <seed>', 'Simulation seed', '1').option('--out <file>').description('Sample virtual votes from saved distributions; no new model calls').action(async (file, opts) => {
  if (opts.draws > 100000) throw new Error('Draws capped at 100000');
  const simulation = simulateVotes(await loadRun(file), opts.stage, opts.question, opts.draws, opts.seed);
  if (opts.out) await writeJson(resolve(opts.out), simulation); output(simulation);
});

const cohort = program.command('cohort').description('Manage portable, reusable audience JSON');
cohort.command('list').option('--dir <directory>', 'Cohort library', '.jev-polls/cohorts').action(async opts => {
  const directory = resolve(opts.dir); let files: string[];
  try { files = await readdir(directory); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') { output({ directory, cohorts: [] }); return; } throw err; }
  const results = await Promise.all(files.filter(f => f.endsWith('.json')).sort().map(async f => { try { const c = parseCohort(await readJson(join(directory, f))); return { file: join(directory, f), id: c.id, name: c.name, personas: c.personas.length, sources: c.sources.length }; } catch { return { file: join(directory, f), error: 'Invalid cohort; run validate for details' }; } }));
  output({ directory, cohorts: results });
});
cohort.command('import').argument('<file>').option('--dir <directory>', 'Cohort library', '.jev-polls/cohorts').description('Save immutable content-addressed cohort revision').action(async (file, opts) => {
  const c = parseCohort(await readJson(file)); const revision = hashValue(c).slice(0, 16);
  const destination = resolve(opts.dir, `${c.id}-${revision}.json`); await writeJson(destination, c); output({ file: destination, id: c.id, revision, personas: c.personas.length });
});
cohort.command('inspect').argument('<file>').action(async file => { output(parseCohort(await readJson(file))); });
cohort.command('sample').argument('<file>').requiredOption('--size <count>', 'Distinct profiles to retain', integer).option('--seed <seed>', 'Reproducible sampling seed', '1').requiredOption('--out <file>', 'Sampled cohort path').action(async (file, opts) => {
  const c = parseCohort(await readJson(file)); c.personas = selectPersonas(c, opts.size, opts.seed); c.assumptions = [...c.assumptions, `Sampled ${opts.size} distinct profiles with seed ${opts.seed}; original segment weights retained.`];
  parseCohort(c); await absent(resolve(opts.out)); await writeJson(resolve(opts.out), c); output({ file: resolve(opts.out), personas: c.personas.length, segments: c.segments.length });
});

const auth = program.command('auth').description('Store credentials in macOS Keychain; never in project files');
auth.command('status').action(async () => { output(await authStatus()); });
auth.command('check').description('Verify account access with one live Jev request covering all three question types').action(async () => { output(await verifyTypeSafeConnection()); });
auth.command('set').option('--stdin', 'Read secret from stdin, for secret-manager piping').description('Read API key without echo and save to macOS Keychain').action(async opts => {
  let key: string;
  if (opts.stdin) {
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of process.stdin) { const b = Buffer.from(chunk); bytes += b.length; if (bytes > 16384) throw new Error('Credential input too long'); chunks.push(b); }
    key = Buffer.concat(chunks).toString('utf8').trim();
  } else {
    if (!process.stdin.isTTY) throw new Error('Use --stdin to read from a secret manager, or run auth set in an interactive terminal');
    process.stderr.write('TypeSafe API key (hidden): ');
    const hidden = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
    const reader = createInterface({ input: process.stdin, output: hidden, terminal: true, historySize: 0 });
    try { key = (await reader.question('')).trim(); } finally { reader.close(); process.stderr.write('\n'); }
  }
  if (!key) throw new Error('The TypeSafe API key cannot be empty.');
  const verified = await verifyTypeSafeConnection(key);
  await setApiKey(key); key = ''; output({ stored: true, source: 'keychain', ...verified });
});

try { await program.parseAsync(process.argv); }
catch (error) {
  const commandError = error as { code?: string; message?: string; exitCode?: number };
  if (commandError.code === 'commander.helpDisplayed' || commandError.code === 'commander.version') { process.exitCode = 0; }
  else if (process.argv[2] === 'mcp') { process.stderr.write(JSON.stringify({ error: { code: 'MCP_START_FAILED', message: 'Could not start the MCP server. Check arguments and use a running local workspace URL.' } }) + '\n'); process.exitCode = 1; }
  else { output({ error: { code: commandError.code ?? 'INVALID_INPUT', message: commandError.message ?? 'Operation failed' } }); process.exitCode = 1; }
}
