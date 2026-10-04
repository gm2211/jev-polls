import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { Cohort, Condition, Pipeline, Question, Stage } from './types.js';

const safeKey = z.string().min(1).max(160).refine(v => !['__proto__', 'prototype', 'constructor'].includes(v), 'Reserved key');
const id = safeKey.regex(/^[a-z][a-z0-9_-]*$/, 'Use lowercase letters, digits, underscores, and hyphens, starting with a letter');
const text = z.string().trim().min(1);
const positive = z.number().finite().positive();
const date = z.string().datetime({ offset: true });
const source = z.object({ id, title: text, url: z.string().url().refine(value => { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password; }, 'Use an HTTP(S) URL without credentials'), retrievedAt: date, notes: text }).strict();
const segment = z.object({ id, label: text, description: text, weight: z.number().finite().nonnegative(), weightBasis: z.enum(['sourced', 'assumed', 'user']), sourceIds: z.array(id) }).strict();
const persona = z.object({ id, label: text, segment: id, age: z.number().int().min(18).max(120), background: text, attributes: z.record(safeKey, z.json()), sourceIds: z.array(id), syntheticFields: z.array(text), weight: positive }).strict();
export const cohortSchema = z.object({ version: z.literal(1), id, name: text, description: text, population: text, createdAt: date, sources: z.array(source), segments: z.array(segment).min(1), personas: z.array(persona).min(1), assumptions: z.array(text) }).strict();
export const questionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), label: text, instructions: text, criteria: z.record(safeKey, z.string().nullable()).refine(v => Object.keys(v).length >= 2 && Object.keys(v).length <= 255, 'Choice requires 2–255 options') }).strict(),
  z.object({ type: z.literal('noul'), label: text, instructions: text }).strict(),
  z.object({ type: z.literal('score'), label: text, instructions: text, criteria: z.array(text).min(2).max(255) }).strict(),
]);
const conditionSchema: z.ZodType<Condition> = z.lazy(() => z.union([
  z.object({ all: z.array(conditionSchema).min(1) }).strict(),
  z.object({ any: z.array(conditionSchema).min(1) }).strict(),
  z.object({ not: conditionSchema }).strict(),
  z.object({ stage: id, question: id, metric: z.enum(['margin', 'topProbability', 'mean', 'winner']), op: z.enum(['gt', 'gte', 'lt', 'lte', 'eq', 'ne']), value: z.union([z.number().finite(), text]) }).strict(),
]));
const base = { id, label: text, dependsOn: z.array(id), join: z.enum(['all', 'any']).optional(), when: conditionSchema.optional() };
export const pipelineSchema = z.object({ version: z.literal(1), id, name: text, description: text, context: z.json(), cohorts: z.record(id, text), stages: z.array(z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('poll'), cohort: id, questions: z.record(id, questionSchema).refine(v => Object.keys(v).length > 0, 'At least one question is required'), size: z.number().int().positive().optional(), repeats: z.number().int().min(1).max(100).optional(), context: z.json().optional() }).strict(),
  z.object({ ...base, kind: z.literal('aggregate'), inputs: z.array(z.object({ stage: id, question: id, weight: positive }).strict()).min(1), outputQuestion: id }).strict(),
  z.object({ ...base, kind: z.literal('decision'), from: z.object({ stage: id, question: id }).strict(), outputQuestion: id }).strict(),
])).min(1) }).strict();

function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
function unique(values: string[], label: string) { assert(new Set(values).size === values.length, `Duplicate ${label}`); }

export function parseCohort(input: unknown): Cohort {
  const c = cohortSchema.parse(input) as Cohort;
  unique(c.sources.map(v => v.id), 'source id'); unique(c.segments.map(v => v.id), 'segment id'); unique(c.personas.map(v => v.id), 'persona id');
  const sources = new Set(c.sources.map(v => v.id)); const segments = new Set(c.segments.map(v => v.id));
  assert(c.segments.some(s => s.weight > 0), 'At least one segment must have positive weight');
  for (const s of c.segments) {
    for (const ref of s.sourceIds) assert(sources.has(ref), `Segment ${s.id}: unknown source ${ref}`);
    assert(s.weightBasis !== 'sourced' || s.sourceIds.length > 0, `Segment ${s.id}: sourced weights need evidence`);
    assert(s.weight === 0 || c.personas.some(p => p.segment === s.id), `Segment ${s.id}: positive weight requires at least one persona`);
  }
  for (const p of c.personas) {
    assert(segments.has(p.segment), `Persona ${p.id}: unknown segment ${p.segment}`);
    for (const ref of p.sourceIds) assert(sources.has(ref), `Persona ${p.id}: unknown source ${ref}`);
  }
  return c;
}

export function stageOrder(pipeline: Pipeline): Stage[] {
  const found = new Set<string>(); const pending = new Set<string>(); const ordered: Stage[] = [];
  const byId = new Map(pipeline.stages.map(s => [s.id, s]));
  function visit(stage: Stage) {
    if (found.has(stage.id)) return;
    assert(!pending.has(stage.id), `Cycle detected at stage ${stage.id}`); pending.add(stage.id);
    for (const ref of stage.dependsOn) { const dependency = byId.get(ref); assert(dependency, `Stage ${stage.id}: unknown dependency ${ref}`); visit(dependency); }
    pending.delete(stage.id); found.add(stage.id); ordered.push(stage);
  }
  for (const stage of pipeline.stages) visit(stage);
  return ordered;
}

export function outputQuestions(pipeline: Pipeline): Record<string, Record<string, Question>> {
  const outputs: Record<string, Record<string, Question>> = {};
  for (const s of stageOrder(pipeline)) {
    if (s.kind === 'poll') { outputs[s.id] = s.questions; continue; }
    const refs = s.kind === 'aggregate' ? s.inputs : [s.from];
    const questions = refs.map(ref => {
      assert(s.dependsOn.includes(ref.stage), `Stage ${s.id}: input ${ref.stage} must be in dependsOn`);
      const question = outputs[ref.stage]?.[ref.question];
      assert(question, `Stage ${s.id}: unknown question ${ref.stage}.${ref.question}`);
      return question;
    });
    const signature = (q: Question) => JSON.stringify(q.type === 'noul' ? { type: q.type } : { type: q.type, criteria: q.type === 'choice' ? Object.fromEntries(Object.entries(q.criteria).sort(([a], [b]) => a.localeCompare(b))) : q.criteria });
    assert(questions.every(q => signature(q) === signature(questions[0])), `Stage ${s.id}: aggregate question types and criteria must match`);
    if (s.kind === 'decision') assert(questions[0].type === 'choice', `Stage ${s.id}: decision requires a choice question`);
    outputs[s.id] = { [s.outputQuestion]: { ...questions[0], label: s.label } };
  }
  return outputs;
}

export function parsePipeline(input: unknown): Pipeline {
  const p = pipelineSchema.parse(input) as Pipeline;
  unique(p.stages.map(s => s.id), 'stage id');
  for (const s of p.stages) {
    unique(s.dependsOn, `dependency in ${s.id}`);
    if (s.kind === 'poll') assert(Object.hasOwn(p.cohorts, s.cohort), `Stage ${s.id}: unknown cohort ${s.cohort}`);
    if (s.kind === 'aggregate') unique(s.inputs.map(i => `${i.stage}.${i.question}`), `aggregate input in ${s.id}`);
  }
  const outputs = outputQuestions(p);
  for (const s of p.stages) {
    function check(c: Condition) {
      if ('all' in c) return c.all.forEach(check);
      if ('any' in c) return c.any.forEach(check);
      if ('not' in c) return check(c.not);
      assert(s.dependsOn.includes(c.stage), `Stage ${s.id}: condition ${c.stage} must be in dependsOn`);
      const q = outputs[c.stage]?.[c.question]; assert(q, `Stage ${s.id}: unknown condition question ${c.stage}.${c.question}`);
      assert(c.metric === 'mean' ? q.type !== 'choice' : q.type === 'choice', `Stage ${s.id}: metric ${c.metric} is incompatible with ${q.type}`);
      assert(c.metric === 'winner' ? typeof c.value === 'string' && ['eq', 'ne'].includes(c.op) : typeof c.value === 'number', `Stage ${s.id}: condition value/operator does not match metric`);
      if (c.metric === 'winner' && q.type === 'choice') assert(Object.hasOwn(q.criteria, c.value as string), `Stage ${s.id}: unknown winner option ${c.value}`);
    }
    if (s.when) check(s.when);
  }
  return p;
}

export async function loadProject(path: string): Promise<{ pipeline: Pipeline; cohorts: Record<string, Cohort> }> {
  const pipeline = parsePipeline(JSON.parse(await readFile(path, 'utf8')));
  const cohorts: Record<string, Cohort> = {};
  for (const [name, relative] of Object.entries(pipeline.cohorts)) {
    cohorts[name] = parseCohort(JSON.parse(await readFile(resolve(dirname(path), relative), 'utf8')));
  }
  for (const s of pipeline.stages) if (s.kind === 'poll') {
    const c = cohorts[s.cohort];
    const activeSegments = new Set(c.segments.filter(segment => segment.weight > 0).map(segment => segment.id));
    const available = c.personas.filter(persona => activeSegments.has(persona.segment)).length;
    const size = s.size ?? available;
    assert(size <= available, `Stage ${s.id}: size exceeds distinct positive-weight cohort profiles; add profiles instead of duplicating respondents`);
    assert(size >= activeSegments.size, `Stage ${s.id}: size must cover all ${activeSegments.size} positive-weight segments`);
  }
  return { pipeline, cohorts };
}

export function jsonSchema(kind: 'pipeline' | 'cohort') {
  return { ...z.toJSONSchema(kind === 'pipeline' ? pipelineSchema : cohortSchema), title: `Jev Polls ${kind} v1` };
}
