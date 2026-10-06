import { MAX_COHORT_PERSONAS, MAX_WORKSPACE_BYTES } from './limits.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Cohort, Json, Pipeline } from './types.js';
import type { WorkspaceDocument, WorkspaceProject, WorkspaceSaved } from './workspace-types.js';
import { parseCohort, parsePipeline, stageOrder } from './schema.js';

const FILE_NAME = 'workspace.json';
const MAX_DOCUMENT_BYTES = MAX_WORKSPACE_BYTES;
const MAX_COHORTS = 100;
const MAX_PIPELINES = 100;
const MAX_STAGES = 500;
const MAX_PERSONAS = MAX_COHORT_PERSONAS;
const MAX_SOURCES = 5_000;
const MAX_SEGMENTS = 1_000;
const MAX_QUESTIONS = 1_000;
const MAX_ITEMS = 20_000;
const LOCK_TIMEOUT_MS = 15_000;
const OWNERLESS_LOCK_STALE_MS = 5_000;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,159}$/;

const saveTails = new Map<string, Promise<void>>();

/** JSON-backed, revisioned persistence for editable workspace drafts. */
export class WorkspaceStore {
  private readonly directory: string;
  private readonly file: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
    this.file = join(this.directory, FILE_NAME);
  }

  async read(): Promise<WorkspaceSaved> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (isMissing(error)) return { revision: 0, document: emptyWorkspaceDocument() };
      throw error;
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('Workspace file exceeds the maximum size');
    let stored: unknown;
    try { stored = JSON.parse(text) as unknown; }
    catch { throw new Error('Workspace file is not valid JSON'); }
    const record = object(stored, 'workspace file', ['revision', 'document'], ['revision', 'document']);
    if (!Number.isSafeInteger(record.revision) || (record.revision as number) < 1) throw new Error('Workspace revision is invalid');
    return { revision: record.revision as number, document: validateWorkspaceDocument(record.document) };
  }

  async save(document: unknown, expectedRevision: number): Promise<WorkspaceSaved> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('Expected revision must be a non-negative safe integer');
    const validated = validateWorkspaceDocument(document);
    const key = this.file;
    return withSerializedSave(key, async () => {
      await mkdir(this.directory, { recursive: true });
      const release = await acquireWorkspaceFileLock(this.file);
      try {
        const current = await this.read();
        if (current.revision !== expectedRevision) throw new WorkspaceConflictError(expectedRevision, current.revision);
        const saved: WorkspaceSaved = { revision: current.revision + 1, document: validated };
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(saved, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
          await rename(temporary, this.file);
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => undefined);
          throw error;
        }
        return saved;
      } finally { await release(); }
    });
  }
}

export class WorkspaceConflictError extends Error {
  readonly code = 'WORKSPACE_CONFLICT';
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(expectedRevision: number, actualRevision: number) {
    super(`Workspace revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}`);
    this.name = 'WorkspaceConflictError';
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function emptyWorkspaceDocument(): WorkspaceDocument {
  return { version: 1, cohorts: [], pipelines: [], projects: [] };
}

/** Strict structural validation for drafts; semantic requirements are enforced at review/run time. */
export function validateWorkspaceDocument(input: unknown): WorkspaceDocument {
  let serialized: string;
  try { serialized = JSON.stringify(input); }
  catch { throw new Error('Workspace document must be JSON-serializable'); }
  if (serialized === undefined) throw new Error('Workspace document must be a JSON object');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) throw new Error('Workspace document exceeds the maximum size');
  const root = object(input, 'workspace document', ['version', 'cohorts', 'pipelines', 'projects'], ['version', 'cohorts', 'pipelines']);
  if (root.version !== 1) throw new Error('Workspace document version must be 1');
  const cohorts = array(root.cohorts, 'workspace cohorts', MAX_COHORTS);
  const pipelines = array(root.pipelines, 'workspace pipelines', MAX_PIPELINES);
  cohorts.forEach((item, index) => validateCohortDraft(item, `cohorts[${index}]`));
  pipelines.forEach((item, index) => validatePipelineDraft(item, `pipelines[${index}]`));
  uniqueIds(cohorts, 'cohort', 'cohorts');
  uniqueIds(pipelines, 'pipeline', 'pipelines');
  const document = JSON.parse(serialized) as WorkspaceDocument;
  // Migration is in memory until the next ordinary revisioned save; existing files
  // and their revision numbers are not rewritten merely by opening a workspace.
  if (document.projects === undefined) document.projects = cohorts.length || pipelines.length ? [{
    id: 'existing-research', name: 'Existing research', description: '',
    cohortIds: document.cohorts.map(cohort => cohort.id), pipelineIds: document.pipelines.map(pipeline => pipeline.id),
  }] : [];
  validateProjectOwnership(document);
  return document;
}

function validateProjectOwnership(document: WorkspaceDocument): void {
  const projects = array(document.projects, 'workspace projects', 100);
  const cohortOwners = new Map<string, string>();
  const pipelineOwners = new Map<string, string>();
  const cohortIds = new Set(document.cohorts.map(cohort => cohort.id));
  const pipelineIds = new Set(document.pipelines.map(pipeline => pipeline.id));
  projects.forEach((entry, index) => {
    const path = `projects[${index}]`;
    const project = object(entry, path, ['id', 'name', 'description', 'cohortIds', 'pipelineIds'], ['id', 'name', 'description', 'cohortIds', 'pipelineIds']);
    id(project.id, `${path}.id`);
    string(project.name, `${path}.name`); string(project.description, `${path}.description`);
    for (const [field, existing, owners] of [
      ['cohortIds', cohortIds, cohortOwners], ['pipelineIds', pipelineIds, pipelineOwners],
    ] as const) {
      array(project[field], `${path}.${field}`, 100).forEach((reference, referenceIndex) => {
        id(reference, `${path}.${field}[${referenceIndex}]`);
        if (!existing.has(reference)) throw new Error(`${path}.${field} references missing ${field === 'cohortIds' ? 'cohort' : 'pipeline'} id '${reference}'`);
        if (owners.has(reference)) throw new Error(`${field} '${reference}' must belong to exactly one project`);
        owners.set(reference, project.id as string);
      });
    }
  });
  uniqueIds(projects, 'project', 'projects');
  for (const cohort of document.cohorts) if (!cohortOwners.has(cohort.id)) throw new Error(`Cohort '${cohort.id}' must belong to exactly one project`);
  for (const pipeline of document.pipelines) {
    const owner = pipelineOwners.get(pipeline.id);
    if (!owner) throw new Error(`Pipeline '${pipeline.id}' must belong to exactly one project`);
    for (const cohortId of Object.values(pipeline.cohorts)) {
      if (cohortId === '') continue; // Editable unselected reference; planning rejects it.
      if (cohortOwners.has(cohortId) && cohortOwners.get(cohortId) !== owner) throw new Error(`Pipeline '${pipeline.id}' references cohort '${cohortId}' from another project`);
    }
  }
}

export function workspaceProjectForPipeline(document: WorkspaceDocument, pipelineId: string): WorkspaceProject | undefined {
  return validateWorkspaceDocument(document).projects!.find(project => project.pipelineIds.includes(pipelineId));
}

export function resolveWorkspaceProject(document: WorkspaceDocument, pipelineId: string): { projectId: string; pipeline: Pipeline; cohorts: Record<string, Cohort> } {
  const validated = validateWorkspaceDocument(document);
  const draftPipeline = validated.pipelines.find((pipeline) => pipeline.id === pipelineId);
  if (!draftPipeline) throw new Error(`Unknown workspace pipeline '${pipelineId}'`);
  const pipeline = parsePipeline(draftPipeline);
  const cohortIds = new Set(Object.values(pipeline.cohorts));
  const cohortsById = new Map<string, Cohort>();
  for (const draftCohort of validated.cohorts) {
    if (!cohortIds.has(draftCohort.id)) continue;
    cohortsById.set(draftCohort.id, parseCohort(draftCohort));
  }
  const cohorts: Record<string, Cohort> = {};
  for (const [alias, cohortId] of Object.entries(pipeline.cohorts)) {
    const cohort = cohortsById.get(cohortId);
    if (!cohort) throw new Error(`Pipeline '${pipeline.id}' references missing cohort id '${cohortId}'`);
    cohorts[alias] = cohort;
  }
  for (const stage of pipeline.stages) {
    if (stage.kind !== 'poll') continue;
    const cohort = cohorts[stage.cohort];
    if (!cohort) throw new Error(`Stage '${stage.id}' references unresolved cohort '${stage.cohort}'`);
    const positive = cohort.segments.filter((segment) => segment.weight > 0);
    const positiveIds = new Set(positive.map((segment) => segment.id));
    const available = cohort.personas.filter((persona) => positiveIds.has(persona.segment)).length;
    for (const segment of positive) {
      if (!cohort.personas.some((persona) => persona.segment === segment.id)) {
        throw new Error(`Stage '${stage.id}': positive-weight segment '${segment.id}' has no profiles`);
      }
    }
    const size = stage.size ?? available;
    if (size > available) throw new Error(`Stage '${stage.id}': sample size ${size} exceeds ${available} distinct positive-weight profiles`);
    if (size < positive.length) throw new Error(`Stage '${stage.id}': sample size ${size} cannot cover all ${positive.length} positive-weight segments`);
  }
  return { projectId: validated.projects!.find(project => project.pipelineIds.includes(pipelineId))!.id, pipeline, cohorts };
}

export function workspacePlan(document: WorkspaceDocument, pipelineId: string): {
  projectId: string;
  pipeline: Pipeline;
  cohorts: Record<string, Cohort>;
  maxRequests: number;
  stages: Array<{ id: string; label: string; kind: string; dependsOn: string[]; cohort?: string; profiles?: number; repeats?: number; requests: number }>;
  warnings: string[];
} {
  const { projectId, pipeline, cohorts } = resolveWorkspaceProject(document, pipelineId);
  let maxRequests = 0;
  const stages = stageOrder(pipeline).map((stage) => {
    if (stage.kind !== 'poll') return { id: stage.id, label: stage.label, kind: stage.kind, dependsOn: [...stage.dependsOn], requests: 0 };
    const cohort = cohorts[stage.cohort]!;
    const positiveIds = new Set(cohort.segments.filter((segment) => segment.weight > 0).map((segment) => segment.id));
    const profiles = stage.size ?? cohort.personas.filter((persona) => positiveIds.has(persona.segment)).length;
    const repeats = stage.repeats ?? 1;
    const requests = profiles * repeats;
    maxRequests += requests;
    return { id: stage.id, label: stage.label, kind: stage.kind, dependsOn: [...stage.dependsOn], cohort: stage.cohort, profiles, repeats, requests };
  });
  const warnings = new Set<string>();
  for (const cohort of new Set(Object.values(cohorts))) {
    if (cohort.sources.length === 0) warnings.add(`Cohort '${cohort.name}' has no source records; treat profile details and population estimates as assumptions.`);
    if (cohort.assumptions.length > 0) warnings.add(`Cohort '${cohort.name}' contains ${cohort.assumptions.length} declared assumption(s).`);
    for (const segment of cohort.segments) {
      if (segment.weightBasis === 'assumed') warnings.add(`Cohort '${cohort.name}' segment '${segment.label}' has an assumed population weight.`);
      if (segment.weightBasis === 'user' && segment.sourceIds.length === 0) warnings.add(`Cohort '${cohort.name}' segment '${segment.label}' has a user-provided weight without linked sources.`);
    }
    const synthetic = cohort.personas.filter((persona) => persona.syntheticFields.length > 0).length;
    if (synthetic) warnings.add(`Cohort '${cohort.name}' has ${synthetic} profile(s) with synthetic fields; votes are model outputs over synthetic profiles, not observed people.`);
    const noProfileSources = cohort.personas.filter((persona) => persona.sourceIds.length === 0).length;
    if (noProfileSources) warnings.add(`Cohort '${cohort.name}' has ${noProfileSources} profile(s) without linked source records.`);
  }
  return { projectId, pipeline, cohorts, maxRequests, stages, warnings: [...warnings] };
}

function validateCohortDraft(value: unknown, path: string): void {
  const c = object(value, path, ['version', 'id', 'name', 'description', 'population', 'createdAt', 'sources', 'segments', 'personas', 'assumptions', 'generationPrompt'], ['version', 'id', 'name', 'description', 'population', 'createdAt', 'sources', 'segments', 'personas', 'assumptions']);
  versionOne(c.version, `${path}.version`); id(c.id, `${path}.id`);
  for (const key of ['name', 'description', 'population', 'createdAt'] as const) string(c[key], `${path}.${key}`);
  if (c.generationPrompt !== undefined) {
    string(c.generationPrompt, `${path}.generationPrompt`);
    if ((c.generationPrompt as string).length > 10_000) throw new Error(`${path}.generationPrompt exceeds 10000 characters`);
  }
  array(c.sources, `${path}.sources`, MAX_SOURCES).forEach((entry, index) => {
    const p = `${path}.sources[${index}]`;
    const s = object(entry, p, ['id', 'title', 'url', 'retrievedAt', 'notes'], ['id', 'title', 'url', 'retrievedAt', 'notes']);
    id(s.id, `${p}.id`); for (const key of ['title', 'url', 'retrievedAt', 'notes']) string(s[key], `${p}.${key}`);
  });
  array(c.segments, `${path}.segments`, MAX_SEGMENTS).forEach((entry, index) => {
    const p = `${path}.segments[${index}]`;
    const s = object(entry, p, ['id', 'label', 'description', 'weight', 'weightBasis', 'sourceIds'], ['id', 'label', 'description', 'weight', 'weightBasis', 'sourceIds']);
    id(s.id, `${p}.id`); string(s.label, `${p}.label`); string(s.description, `${p}.description`); number(s.weight, `${p}.weight`, 0);
    enumValue(s.weightBasis, ['sourced', 'assumed', 'user'], `${p}.weightBasis`); stringArray(s.sourceIds, `${p}.sourceIds`, 10_000, true);
  });
  array(c.personas, `${path}.personas`, MAX_PERSONAS).forEach((entry, index) => {
    const p = `${path}.personas[${index}]`;
    const persona = object(entry, p, ['id', 'label', 'segment', 'age', 'background', 'attributes', 'sourceIds', 'syntheticFields', 'weight'], ['id', 'label', 'segment', 'age', 'background', 'attributes', 'sourceIds', 'syntheticFields', 'weight']);
    id(persona.id, `${p}.id`); string(persona.label, `${p}.label`); id(persona.segment, `${p}.segment`);
    if (!Number.isSafeInteger(persona.age) || (persona.age as number) < 0 || (persona.age as number) > 120) throw new Error(`${p}.age must be an integer between 0 and 120`);
    string(persona.background, `${p}.background`); validateJson(persona.attributes, `${p}.attributes`);
    if (!isRecord(persona.attributes)) throw new Error(`${p}.attributes must be an object`);
    stringArray(persona.sourceIds, `${p}.sourceIds`, 10_000, true); stringArray(persona.syntheticFields, `${p}.syntheticFields`, 10_000, false); number(persona.weight, `${p}.weight`, 0);
  });
  stringArray(c.assumptions, `${path}.assumptions`, 10_000, false);
}

function validatePipelineDraft(value: unknown, path: string): void {
  const p = object(value, path, ['version', 'id', 'name', 'description', 'context', 'cohorts', 'stages'], ['version', 'id', 'name', 'description', 'context', 'cohorts', 'stages']);
  versionOne(p.version, `${path}.version`); id(p.id, `${path}.id`);
  for (const key of ['name', 'description'] as const) string(p[key], `${path}.${key}`);
  validateJson(p.context, `${path}.context`);
  const refs = object(p.cohorts, `${path}.cohorts`, undefined, []);
  if (Object.keys(refs).length > MAX_COHORTS) throw new Error(`${path}.cohorts exceeds ${MAX_COHORTS} entries`);
  for (const [alias, reference] of Object.entries(refs)) { id(alias, `${path}.cohorts key`); string(reference, `${path}.cohorts.${alias}`); if (reference !== '') id(reference, `${path}.cohorts.${alias}`); }
  array(p.stages, `${path}.stages`, MAX_STAGES).forEach((entry, index) => validateStageDraft(entry, `${path}.stages[${index}]`));
  uniqueIds(p.stages as unknown[], 'stage', `${path}.stages`);
}

function validateStageDraft(value: unknown, path: string): void {
  const common = ['id', 'label', 'kind', 'dependsOn', 'join', 'when'];
  const preliminary = object(value, path, [...common, 'cohort', 'questions', 'size', 'repeats', 'context', 'inputs', 'outputQuestion', 'from'], ['id', 'label', 'kind', 'dependsOn']);
  id(preliminary.id, `${path}.id`); string(preliminary.label, `${path}.label`); stringArray(preliminary.dependsOn, `${path}.dependsOn`, MAX_STAGES, true);
  if (preliminary.join !== undefined) enumValue(preliminary.join, ['all', 'any'], `${path}.join`);
  if (preliminary.when !== undefined) validateCondition(preliminary.when, `${path}.when`, 0);
  if (preliminary.kind === 'poll') {
    const s = object(value, path, [...common, 'cohort', 'questions', 'size', 'repeats', 'context', 'inputs'], ['id', 'label', 'kind', 'dependsOn', 'cohort', 'questions']);
    string(s.cohort, `${path}.cohort`); if (s.cohort !== '') id(s.cohort, `${path}.cohort`);
    const questions = object(s.questions, `${path}.questions`, undefined, []);
    if (Object.keys(questions).length > MAX_QUESTIONS) throw new Error(`${path}.questions exceeds ${MAX_QUESTIONS} entries`);
    for (const [key, question] of Object.entries(questions)) { id(key, `${path}.questions key`); validateQuestionDraft(question, `${path}.questions.${key}`); }
    if (s.size !== undefined && (!Number.isSafeInteger(s.size) || (s.size as number) < 1)) throw new Error(`${path}.size must be a positive integer`);
    if (s.repeats !== undefined && (!Number.isSafeInteger(s.repeats) || (s.repeats as number) < 1 || (s.repeats as number) > 100)) throw new Error(`${path}.repeats must be an integer between 1 and 100`);
    if (s.context !== undefined) validateJson(s.context, `${path}.context`);
    if (s.inputs !== undefined) {
      const bindings = object(s.inputs, `${path}.inputs`, undefined, []);
      if (Object.keys(bindings).length > MAX_QUESTIONS) throw new Error(`${path}.inputs exceeds ${MAX_QUESTIONS} bindings`);
      for (const [alias, binding] of Object.entries(bindings)) {
        id(alias, `${path}.inputs key`);
        const entryPath = `${path}.inputs.${alias}`;
        const b = object(binding, entryPath, ['stage', 'question', 'select'], ['stage', 'question']);
        string(b.stage, `${entryPath}.stage`); if (b.stage !== '') id(b.stage, `${entryPath}.stage`);
        string(b.question, `${entryPath}.question`); if (b.question !== '') id(b.question, `${entryPath}.question`);
        if (b.select !== undefined) enumValue(b.select, ['summary', 'winner', 'mean', 'probabilities', 'responses'], `${entryPath}.select`);
      }
    }
  } else if (preliminary.kind === 'aggregate') {
    const s = object(value, path, [...common, 'inputs', 'outputQuestion'], ['id', 'label', 'kind', 'dependsOn', 'inputs', 'outputQuestion']);
    const inputs = array(s.inputs, `${path}.inputs`, MAX_STAGES);
    inputs.forEach((entry, inputIndex) => {
      const q = object(entry, `${path}.inputs[${inputIndex}]`, ['stage', 'question', 'weight'], ['stage', 'question', 'weight']);
      string(q.stage, `${path}.inputs[${inputIndex}].stage`); if (q.stage !== '') id(q.stage, `${path}.inputs[${inputIndex}].stage`);
      string(q.question, `${path}.inputs[${inputIndex}].question`); if (q.question !== '') id(q.question, `${path}.inputs[${inputIndex}].question`);
      number(q.weight, `${path}.inputs[${inputIndex}].weight`, 0);
    });
    string(s.outputQuestion, `${path}.outputQuestion`); if (s.outputQuestion !== '') id(s.outputQuestion, `${path}.outputQuestion`);
  } else if (preliminary.kind === 'decision') {
    const s = object(value, path, [...common, 'from', 'outputQuestion'], ['id', 'label', 'kind', 'dependsOn', 'from', 'outputQuestion']);
    const from = object(s.from, `${path}.from`, ['stage', 'question'], ['stage', 'question']);
    string(from.stage, `${path}.from.stage`); if (from.stage !== '') id(from.stage, `${path}.from.stage`);
    string(from.question, `${path}.from.question`); if (from.question !== '') id(from.question, `${path}.from.question`);
    string(s.outputQuestion, `${path}.outputQuestion`); if (s.outputQuestion !== '') id(s.outputQuestion, `${path}.outputQuestion`);
  } else throw new Error(`${path}.kind must be poll, aggregate, or decision`);
}

function validateQuestionDraft(value: unknown, path: string): void {
  const q = object(value, path, ['type', 'label', 'instructions', 'criteria'], ['type', 'label', 'instructions']);
  string(q.label, `${path}.label`); string(q.instructions, `${path}.instructions`);
  if (q.type === 'noul') {
    object(value, path, ['type', 'label', 'instructions'], ['type', 'label', 'instructions']);
  } else if (q.type === 'choice') {
    const choice = object(value, path, ['type', 'label', 'instructions', 'criteria'], ['type', 'label', 'instructions', 'criteria']);
    const criteria = object(choice.criteria, `${path}.criteria`, undefined, []);
    if (Object.keys(criteria).length > 255) throw new Error(`${path}.criteria exceeds 255 entries`);
    for (const [key, item] of Object.entries(criteria)) { safeKey(key, `${path}.criteria key`); if (item !== null) string(item, `${path}.criteria.${key}`); }
  } else if (q.type === 'score') {
    const score = object(value, path, ['type', 'label', 'instructions', 'criteria'], ['type', 'label', 'instructions', 'criteria']);
    array(score.criteria, `${path}.criteria`, 255).forEach((item, index) => string(item, `${path}.criteria[${index}]`));
  } else throw new Error(`${path}.type must be choice, noul, or score`);
}

function validateCondition(value: unknown, path: string, depth: number): void {
  if (depth > 20) throw new Error(`${path} is nested too deeply`);
  const c = object(value, path, ['all', 'any', 'not', 'stage', 'question', 'metric', 'op', 'value'], []);
  const keys = Object.keys(c);
  if (keys.length === 1 && (keys[0] === 'all' || keys[0] === 'any')) {
    array(c[keys[0]], `${path}.${keys[0]}`, MAX_STAGES).forEach((child, index) => validateCondition(child, `${path}.${keys[0]}[${index}]`, depth + 1));
  } else if (keys.length === 1 && keys[0] === 'not') validateCondition(c.not, `${path}.not`, depth + 1);
  else if (['stage', 'question', 'metric', 'op', 'value'].every((key) => Object.hasOwn(c, key)) && keys.length === 5) {
    id(c.stage, `${path}.stage`); id(c.question, `${path}.question`);
    enumValue(c.metric, ['margin', 'topProbability', 'mean', 'winner'], `${path}.metric`);
    enumValue(c.op, ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'], `${path}.op`);
    if (typeof c.value !== 'string' && (typeof c.value !== 'number' || !Number.isFinite(c.value))) throw new Error(`${path}.value must be a finite number or string`);
  } else throw new Error(`${path} must contain one valid condition form`);
}

function validateJson(value: unknown, path: string): asserts value is Json {
  let entries = 0;
  function visit(item: unknown, depth: number): void {
    if (depth > 32) throw new Error(`${path} is nested too deeply`);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (Array.isArray(item)) {
      entries += item.length;
      if (entries > MAX_ITEMS) throw new Error(`${path} contains too many values`);
      item.forEach((child) => visit(child, depth + 1)); return;
    }
    if (isRecord(item)) {
      const keys = Object.keys(item); entries += keys.length;
      if (entries > MAX_ITEMS) throw new Error(`${path} contains too many values`);
      for (const key of keys) { safeKey(key, `${path} key`); visit(item[key], depth + 1); }
      return;
    }
    throw new Error(`${path} must contain JSON values`);
  }
  visit(value, 0);
}

function object(value: unknown, path: string, allowed?: string[], required: string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    safeKey(key, `${path} key`);
    if (allowed && !allowed.includes(key)) throw new Error(`${path} contains unknown field '${key}'`);
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new Error(`${path} is missing '${key}'`);
  return value;
}

function array(value: unknown, path: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  if (value.length > maximum) throw new Error(`${path} exceeds ${maximum} entries`);
  return value;
}

function string(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.length > 100_000) throw new Error(`${path} must be a string of at most 100000 characters`);
}

function id(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || RESERVED.has(value)) throw new Error(`${path} must be a safe lowercase ID`);
}

function safeKey(value: string, path: string): void {
  if (value.length < 1 || value.length > 160 || RESERVED.has(value)) throw new Error(`${path} is an invalid or reserved key`);
}

function stringArray(value: unknown, path: string, maximum: number, references: boolean): void {
  array(value, path, maximum).forEach((item, index) => {
    string(item, `${path}[${index}]`);
    if (references && item !== '') id(item, `${path}[${index}]`);
  });
}

function number(value: unknown, path: string, minimum: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) throw new Error(`${path} must be a finite number >= ${minimum}`);
}

function enumValue(value: unknown, choices: readonly string[], path: string): void {
  if (typeof value !== 'string' || !choices.includes(value)) throw new Error(`${path} must be one of ${choices.join(', ')}`);
}

function versionOne(value: unknown, path: string): void { if (value !== 1) throw new Error(`${path} must be 1`); }

function uniqueIds(values: unknown[], label: string, path: string): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || typeof value.id !== 'string') continue;
    if (seen.has(value.id)) throw new Error(`${path} contains duplicate ${label} id '${value.id}' at index ${index}`);
    seen.add(value.id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function withSerializedSave<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = saveTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
  const tail = previous.catch(() => undefined).then(() => gate);
  saveTails.set(key, tail);
  try { await previous.catch(() => undefined); return await operation(); }
  finally {
    release();
    if (saveTails.get(key) === tail) saveTails.delete(key);
  }
}

interface LockOwner { pid: number; token: string }

async function acquireWorkspaceFileLock(workspaceFile: string): Promise<() => Promise<void>> {
  const lockDirectory = `${workspaceFile}.lock`;
  const ownerFile = join(lockDirectory, 'owner.json');
  const reaperFile = join(lockDirectory, 'reaper');
  const token = randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      try {
        await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token } satisfies LockOwner), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      } catch (error) {
        // Another process may have recovered an ownerless lock and acquired this path.
        // Never remove the directory here: it may now belong to that newer writer.
        throw error;
      }
      if ((await readLockOwner(ownerFile))?.token !== token) continue;
      return async () => {
        const owner = await readLockOwner(ownerFile);
        if (owner?.token === token && owner.pid === process.pid) await rm(lockDirectory, { recursive: true, force: true });
      };
    } catch (error) {
      if (!isCode(error, 'EEXIST')) throw error;
      await reapDeadWorkspaceLock(lockDirectory, ownerFile, reaperFile).catch(() => undefined);
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
  }
  throw new Error('Timed out waiting for the workspace save lock; another writer may still be active. Retry the save.');
}

async function reapDeadWorkspaceLock(lockDirectory: string, ownerFile: string, reaperFile: string): Promise<void> {
  const initialStat = await stat(lockDirectory).catch((error: unknown) => isCode(error, 'ENOENT') ? undefined : Promise.reject(error));
  if (!initialStat) return;
  const initialOwner = await readLockOwner(ownerFile);
  const initiallyStale = initialOwner
    ? !processIsAlive(initialOwner.pid)
    : Date.now() - initialStat.mtimeMs >= OWNERLESS_LOCK_STALE_MS;
  if (!initiallyStale) return;
  let reaper;
  try { reaper = await open(reaperFile, 'wx', 0o600); }
  catch (error) { if (isCode(error, 'EEXIST') || isCode(error, 'ENOENT')) return; throw error; }
  try {
    // Recheck while holding the one reaper marker so simultaneous contenders cannot
    // remove a newly acquired owner's lock after another contender has recovered it.
    const currentStat = await stat(lockDirectory).catch((error: unknown) => isCode(error, 'ENOENT') ? undefined : Promise.reject(error));
    if (!currentStat || currentStat.dev !== initialStat.dev || currentStat.ino !== initialStat.ino) return;
    const currentOwner = await readLockOwner(ownerFile);
    const stillStale = currentOwner
      ? !processIsAlive(currentOwner.pid)
      : Boolean(initiallyStale && (!initialOwner || !processIsAlive(initialOwner.pid)));
    if (stillStale) await rm(lockDirectory, { recursive: true, force: true });
  } finally { await reaper.close(); }
}

async function staleLockState(lockDirectory: string, ownerFile: string): Promise<boolean> {
  let lockStat;
  try { lockStat = await stat(lockDirectory); }
  catch (error) { if (isCode(error, 'ENOENT')) return false; throw error; }
  const owner = await readLockOwner(ownerFile);
  if (owner) return !processIsAlive(owner.pid);
  return Date.now() - lockStat.mtimeMs >= OWNERLESS_LOCK_STALE_MS;
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!isRecord(parsed) || !Number.isSafeInteger(parsed.pid) || (parsed.pid as number) < 1 || typeof parsed.token !== 'string') return undefined;
    return { pid: parsed.pid as number, token: parsed.token };
  } catch { return undefined; }
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return isCode(error, 'EPERM'); }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
