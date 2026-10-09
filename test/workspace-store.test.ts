import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkspaceConflictError, WorkspaceStore, resolveWorkspaceProject, validateWorkspaceDocument, workspacePlan } from '../src/workspace-store.js';
import type { Cohort, Pipeline } from '../src/types.js';
import type { WorkspaceDocument } from '../src/workspace-types.js';

function cohort(): Cohort {
  return {
    version: 1, id: 'people', name: 'People', description: 'A synthetic panel', population: 'Adults', createdAt: '2026-10-03T12:00:00Z',
    sources: [],
    segments: [
      { id: 'players', label: 'Players', description: 'Regular players', weight: 0.7, weightBasis: 'assumed', sourceIds: [] },
      { id: 'nonplayers', label: 'Non-players', description: 'Rarely play', weight: 0.3, weightBasis: 'user', sourceIds: [] },
      { id: 'inactive', label: 'Inactive', description: 'Zero-weight profiles excluded from samples', weight: 0, weightBasis: 'user', sourceIds: [] },
    ],
    personas: [
      { id: 'p1', label: 'One', segment: 'players', age: 22, background: 'Plays weekly', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 1 },
      { id: 'p2', label: 'Two', segment: 'players', age: 31, background: 'Plays daily', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 },
      { id: 'p3', label: 'Three', segment: 'nonplayers', age: 45, background: 'Does not play', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 1 },
      { id: 'p4', label: 'Four', segment: 'inactive', age: 50, background: 'Excluded', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 },
    ],
    assumptions: ['Population shares are illustrative.'],
  };
}

function pipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    version: 1, id: 'study', name: 'Study', description: 'A draft study', context: {}, cohorts: { panel: 'people' },
    stages: [{
      id: 'first', label: 'First question', kind: 'poll', dependsOn: [], cohort: 'panel', repeats: 2,
      questions: { favorite: { type: 'choice', label: 'Favorite', instructions: 'Choose one', criteria: { a: 'A', b: 'B' } } },
    }],
    ...overrides,
  };
}

function documentWith(cohortValue = cohort(), pipelineValue = pipeline()): WorkspaceDocument {
  return { version: 1, cohorts: [cohortValue], pipelines: [pipelineValue] };
}

async function temporaryDirectory(): Promise<string> { return mkdtemp(join(tmpdir(), 'jev-workspace-')); }

test('reads empty defaults and atomically saves revisioned JSON', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  assert.deepEqual(await store.read(), { revision: 0, document: { version: 1, cohorts: [], pipelines: [], projects: [] } });
  const document = documentWith();
  document.cohorts[0]!.generationPrompt = 'Adults who recently chose a meal kit';
  assert.deepEqual(await store.save(document, 0), { revision: 1, document: validateWorkspaceDocument(document) });
  assert.deepEqual(await store.read(), { revision: 1, document: validateWorkspaceDocument(document) });
});

test('serializes competing saves and rejects a stale expected revision', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const storeA = new WorkspaceStore(directory); const storeB = new WorkspaceStore(directory);
  const outcomes = await Promise.allSettled([storeA.save(documentWith(), 0), storeB.save(documentWith(cohort(), pipeline({ name: 'Other' })), 0)]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')!;
  assert.ok(rejected.reason instanceof WorkspaceConflictError);
  assert.equal(rejected.reason.code, 'WORKSPACE_CONFLICT');
  assert.equal((await storeA.read()).revision, 1);
});

test('workspace preserves structured options and incomplete drafts, rejecting malformed descriptions', async t => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  const draft = documentWith();
  const stage = draft.pipelines[0]!.stages[0]!;
  assert.ok(stage.kind === 'poll' && stage.questions.favorite?.type === 'choice');
  const criteria = { a: { label: 'Everyday', description: 'Designed for daily use.' }, b: { label: '', description: '' } };
  stage.questions.favorite.criteria = criteria;
  await store.save(draft, 0);
  const saved = await store.read();
  const savedStage = saved.document.pipelines[0]!.stages[0]!;
  assert.ok(savedStage.kind === 'poll' && savedStage.questions.favorite?.type === 'choice');
  assert.deepEqual(savedStage.questions.favorite.criteria, criteria);
  assert.throws(() => workspacePlan(saved.document, 'study'));
  savedStage.questions.favorite.criteria.b = { label: 'Occasional', description: '' };
  assert.doesNotThrow(() => workspacePlan(saved.document, 'study'));
  for (const invalid of [{ label: 'Only name' }, { label: 'Name', description: 42 }, { label: 'Name', description: '', extra: true }, []]) {
    (savedStage.questions.favorite.criteria as Record<string, unknown>).a = invalid;
    assert.throws(() => validateWorkspaceDocument(saved.document));
  }
});

test('serializes revision checks across separate Node processes', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src/workspace-store.ts')).href;
  const largeDocument = documentWith(); largeDocument.pipelines[0]!.context = { padded: 'x'.repeat(6 * 1024 * 1024) };
  const inputPath = join(directory, 'large-document.json');
  await writeFile(inputPath, JSON.stringify(largeDocument));
  const script = `
    import { readFile } from 'node:fs/promises';
    import { WorkspaceStore } from ${JSON.stringify(moduleUrl)};
    const [directory, inputPath, name] = process.argv.slice(1);
    const document = JSON.parse(await readFile(inputPath, 'utf8'));
    document.pipelines[0].name = name;
    try { await new WorkspaceStore(directory).save(document, 0); process.stdout.write('saved'); }
    catch (error) { if (error?.code === 'WORKSPACE_CONFLICT') process.stdout.write('conflict'); else throw error; }
  `;
  const launch = (name: string) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory, inputPath, name], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(`child exited ${code}: ${stderr}`)));
  });
  const outcomes = await Promise.all([launch('writer_a'), launch('writer_b')]);
  assert.deepEqual([...outcomes].sort(), ['conflict', 'saved']);
  const stored = await new WorkspaceStore(directory).read();
  assert.equal(stored.revision, 1);
  assert.ok(['writer_a', 'writer_b'].includes(stored.document.pipelines[0]!.name));
});

test('recovers a save lock left by a crashed process', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const lockDirectory = join(directory, 'workspace.json.lock');
  await mkdir(lockDirectory);
  await writeFile(join(lockDirectory, 'owner.json'), JSON.stringify({ pid: 2_147_483_647, token: 'dead-process' }));
  const saved = await new WorkspaceStore(directory).save(documentWith(), 0);
  assert.equal(saved.revision, 1);
  await assert.rejects(() => readFile(lockDirectory), { code: 'ENOENT' });

  await mkdir(lockDirectory);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockDirectory, old, old);
  const second = await new WorkspaceStore(directory).save(documentWith(), 1);
  assert.equal(second.revision, 2);
  await assert.rejects(() => readFile(lockDirectory), { code: 'ENOENT' });
});

test('persists structurally sound incomplete drafts and defers semantic checks to planning', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const draft = documentWith();
  draft.cohorts[0]!.name = ''; draft.cohorts[0]!.personas[0]!.background = '';
  draft.pipelines[0]!.name = ''; draft.pipelines[0]!.stages[0]!.label = '';
  (draft.pipelines[0]!.stages[0] as Extract<Pipeline['stages'][number], { kind: 'poll' }>).questions.favorite!.instructions = '';
  (draft.pipelines[0]!.stages[0] as Extract<Pipeline['stages'][number], { kind: 'poll' }>).inputs = { future: { stage: '', question: '', select: 'summary' } };
  const saved = await new WorkspaceStore(directory).save(draft, 0);
  assert.equal(saved.document.cohorts[0]!.name, '');
  assert.deepEqual((saved.document.pipelines[0]!.stages[0] as Extract<Pipeline['stages'][number], { kind: 'poll' }>).inputs, { future: { stage: '', question: '', select: 'summary' } });
  assert.throws(() => resolveWorkspaceProject(saved.document, 'study'), /too small|invalid|at least|characters/i);
});

test('validation returns a detached JSON snapshot for queued saves', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = documentWith();
  const validated = validateWorkspaceDocument(source);
  source.cohorts[0]!.name = 'mutated after validation';
  assert.equal(validated.cohorts[0]!.name, 'People');

  const queued = documentWith();
  const pending = new WorkspaceStore(directory).save(queued, 0);
  queued.cohorts[0]!.name = 'mutated after save was queued';
  assert.equal((await pending).document.cohorts[0]!.name, 'People');
});

test('workspace drafts preserve and validate optional cohort distribution targets', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const draft = documentWith();
  draft.cohorts[0]!.distributionTargets = [{ field: 'age', kind: 'numeric', buckets: [{ label: '18–39', min: 18, max: 40, percent: 45 }, { label: '40+', min: 40, max: 121, percent: 55 }] }];
  const saved = await new WorkspaceStore(directory).save(draft, 0);
  assert.deepEqual(saved.document.cohorts[0]!.distributionTargets, draft.cohorts[0]!.distributionTargets);
  const invalid = structuredClone(draft);
  invalid.cohorts[0]!.distributionTargets![0]!.buckets[1]!.min = 39;
  assert.throws(() => validateWorkspaceDocument(invalid), /overlapping/);
});

test('rejects wrong fields, unsafe IDs, prototype keys, and oversized arrays', () => {
  const base = documentWith();
  assert.throws(() => validateWorkspaceDocument({ ...base, typo: true }), /unknown field/);
  const badId = structuredClone(base); badId.pipelines[0]!.id = '__proto__';
  assert.throws(() => validateWorkspaceDocument(badId), /safe lowercase ID/);
  const polluted = JSON.parse('{"version":1,"cohorts":[],"pipelines":[],"constructor":{}}') as unknown;
  assert.throws(() => validateWorkspaceDocument(polluted), /reserved|unknown field/);
  assert.throws(() => validateWorkspaceDocument({ version: 1, cohorts: Array(101).fill(cohort()), pipelines: [] }), /exceeds 100/);
});

test('resolves cohort IDs only from the workspace and never treats references as paths', () => {
  const directoryPromise = temporaryDirectory();
  return directoryPromise.then(async (directory) => {
    try {
      await writeFile(join(directory, 'ghost.json'), JSON.stringify(cohort()));
      const document = documentWith(cohort(), pipeline({ cohorts: { panel: 'ghost' } }));
      assert.throws(() => resolveWorkspaceProject(document, 'study'), /missing cohort id 'ghost'/);
      assert.equal(document.cohorts[0]!.id, 'people');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('planning validates references, cycles, weighted-profile coverage, and exact request totals', () => {
  const doc = documentWith();
  const plan = workspacePlan(doc, 'study');
  assert.equal(plan.maxRequests, 6); // 3 eligible positive-weight profiles × 2 repeats.
  assert.deepEqual(plan.stages[0], { id: 'first', label: 'First question', kind: 'poll', dependsOn: [], cohort: 'panel', profiles: 3, repeats: 2, requests: 6 });
  assert.ok(plan.warnings.some((warning) => warning.includes('assumed population weight')));
  assert.ok(plan.warnings.some((warning) => warning.includes('synthetic fields')));
  assert.ok(plan.warnings.some((warning) => warning.includes('no source records')));

  const cycle = documentWith(cohort(), pipeline({ stages: [
    { id: 'one', label: 'One', kind: 'poll', dependsOn: ['two'], cohort: 'panel', questions: { q: { type: 'noul', label: 'Q', instructions: 'I' } } },
    { id: 'two', label: 'Two', kind: 'poll', dependsOn: ['one'], cohort: 'panel', questions: { q: { type: 'noul', label: 'Q', instructions: 'I' } } },
  ] }));
  assert.throws(() => workspacePlan(cycle, 'study'), /Cycle/);

  const oversized = documentWith(cohort(), pipeline({ stages: [{
    id: 'first', label: 'First', kind: 'poll', dependsOn: [], cohort: 'panel', size: 4,
    questions: { q: { type: 'noul', label: 'Q', instructions: 'I' } },
  }] }));
  assert.throws(() => workspacePlan(oversized, 'study'), /Step 1 \(First\) asks 4 people but its cohort has 3\. Lower the sample size to 3/);

  const missing = documentWith(cohort(), pipeline({ cohorts: { panel: 'ghost' } }));
  assert.throws(() => workspacePlan(missing, 'study'), /missing cohort id 'ghost'/);
});

test('a valid pipeline is not blocked by an unrelated incomplete cohort draft', () => {
  const unrelated = cohort(); unrelated.id = 'unfinished'; unrelated.name = ''; unrelated.personas[0]!.background = '';
  const doc = documentWith(); doc.cohorts.push(unrelated);
  const resolved = resolveWorkspaceProject(doc, 'study');
  assert.deepEqual(Object.keys(resolved.cohorts), ['panel']);
  assert.equal(workspacePlan(doc, 'study').maxRequests, 6);
});


test('legacy migration is deterministic, preserves drafts, and does not rewrite on read', async t => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const legacy = documentWith();
  legacy.pipelines.push(pipeline({ id: 'second-study', cohorts: { panel: 'not-yet-created' } }));
  const original = JSON.stringify({ revision: 7, document: legacy });
  await writeFile(join(directory, 'workspace.json'), original);
  const store = new WorkspaceStore(directory);
  const saved = await store.read();
  assert.equal(saved.revision, 7);
  assert.deepEqual(saved.document.projects, [{ id: 'existing-research', name: 'Existing research', description: '', cohortIds: ['people'], pipelineIds: ['study', 'second-study'] }]);
  assert.deepEqual(saved.document.cohorts, legacy.cohorts);
  assert.deepEqual(saved.document.pipelines, legacy.pipelines);
  assert.deepEqual(await store.read(), saved);
  assert.equal(await readFile(join(directory, 'workspace.json'), 'utf8'), original);
  assert.throws(() => workspacePlan(saved.document, 'second-study'), /missing cohort id/);
  assert.equal((await store.save(saved.document, 7)).revision, 8);
});

test('projects own every entity exactly once and enforce pipeline boundaries at save and plan', () => {
  const doc = documentWith();
  doc.cohorts.push({ ...cohort(), id: 'other-people' });
  doc.projects = [
    { id: 'first-project', name: 'First', description: '', cohortIds: ['people'], pipelineIds: ['study'] },
    { id: 'second-project', name: 'Second', description: '', cohortIds: ['other-people'], pipelineIds: [] },
  ];
  assert.equal(workspacePlan(doc, 'study').projectId, 'first-project');
  const crossProject = structuredClone(doc); crossProject.pipelines[0]!.cohorts.panel = 'other-people';
  assert.throws(() => validateWorkspaceDocument(crossProject), /another project/);
  assert.throws(() => workspacePlan(crossProject, 'study'), /another project/);
  for (const mutate of [
    (d: WorkspaceDocument) => { d.projects![0]!.cohortIds = []; },
    (d: WorkspaceDocument) => { d.projects![1]!.cohortIds.push('people'); },
    (d: WorkspaceDocument) => { d.projects![0]!.pipelineIds.push('study'); },
  ]) {
    const invalid = structuredClone(doc); mutate(invalid);
    assert.throws(() => validateWorkspaceDocument(invalid), /exactly one project/);
  }
  const missing = structuredClone(doc); missing.projects![0]!.cohortIds.push('ghost');
  assert.throws(() => validateWorkspaceDocument(missing), /missing cohort/);
  const duplicate = structuredClone(doc); duplicate.projects![1]!.id = 'first-project';
  assert.throws(() => validateWorkspaceDocument(duplicate), /duplicate project/);
  assert.throws(() => validateWorkspaceDocument({ ...doc, projects: null }), /must be an array/);
  assert.throws(() => validateWorkspaceDocument({ ...doc, projects: [] }), /exactly one project/);
  const unfinished = structuredClone(doc); unfinished.pipelines[0]!.cohorts.panel = '';
  assert.equal(validateWorkspaceDocument(unfinished).projects!.length, 2);
  assert.throws(() => workspacePlan(unfinished, 'study'));
});

test('saved studies keep canvas positions and reject malformed ones', async (t) => {
  const directory = await temporaryDirectory(); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new WorkspaceStore(directory);
  const document = documentWith();
  const stageId = document.pipelines[0]!.stages[0]!.id;
  document.pipelines[0]!.layout = { [stageId]: { x: 120, y: 48 } };
  await store.save(document, 0);
  assert.deepEqual((await store.read()).document.pipelines[0]!.layout, { [stageId]: { x: 120, y: 48 } });
  const bad = structuredClone(document) as any;
  bad.pipelines[0].layout[stageId] = { x: 'left', y: 0 };
  assert.throws(() => validateWorkspaceDocument(bad), /layout\..*x must be a finite number/);
  bad.pipelines[0].layout[stageId] = { x: 0, y: 0, z: 1 };
  assert.throws(() => validateWorkspaceDocument(bad), /unknown field 'z'/);
});
