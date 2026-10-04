import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCohort, parsePipeline, jsonSchema } from '../src/schema.js';

const poll = { id: 'first', label: 'First', kind: 'poll', dependsOn: [], cohort: 'people', questions: { favorite: { type: 'choice', label: 'Favorite', instructions: 'Which is preferred?', criteria: { a: 'A', b: 'B' } } } };
const pipeline = () => ({ version: 1, id: 'study', name: 'Study', description: 'A study', context: {}, cohorts: { people: 'people.json' }, stages: [structuredClone(poll)] as unknown[] });
test('rejects cycles, unknown dependencies and unknown keys', () => {
  const p = pipeline(); (p.stages[0] as any).dependsOn = ['first']; assert.throws(() => parsePipeline(p), /Cycle/);
  (p.stages[0] as any).dependsOn = ['missing']; assert.throws(() => parsePipeline(p), /unknown dependency/);
  assert.throws(() => parsePipeline({ ...pipeline(), typo: true }), /Unrecognized/);
});
test('conditions require declared dependencies and compatible metrics', () => {
  const p = pipeline(); p.stages.push({ ...structuredClone(poll), id: 'second', when: { stage: 'first', question: 'favorite', metric: 'margin', op: 'lt', value: 0.1 } });
  assert.throws(() => parsePipeline(p), /must be in dependsOn/);
  (p.stages[1] as any).dependsOn = ['first']; assert.equal(parsePipeline(p).stages.length, 2);
  (p.stages[1] as any).when.metric = 'mean'; assert.throws(() => parsePipeline(p), /incompatible/);
});
test('rejects aggregating incompatible options and undeclared question refs', () => {
  const p = pipeline(); p.stages.push({ ...structuredClone(poll), id: 'second' });
  (p.stages[1] as any).questions.favorite.criteria = { x: 'X', y: 'Y' };
  p.stages.push({ id: 'combine', label: 'Combine', kind: 'aggregate', dependsOn: ['first', 'second'], inputs: [{ stage: 'first', question: 'favorite', weight: 1 }, { stage: 'second', question: 'favorite', weight: 1 }], outputQuestion: 'favorite' });
  assert.throws(() => parsePipeline(p), /criteria must match/);
});
test('cohort provenance and positive population support are enforced', () => {
  const c: any = { version: 1, id: 'people', name: 'People', description: 'Example', population: 'Adult gamers', createdAt: '2026-10-03T12:00:00Z', sources: [], segments: [{ id: 'players', label: 'Players', description: 'Players', weight: 1, weightBasis: 'assumed', sourceIds: [] }], personas: [{ id: 'p1', label: 'Person', segment: 'players', age: 22, background: 'Plays games', attributes: {}, sourceIds: [], syntheticFields: ['background'], weight: 1 }], assumptions: [] };
  assert.equal(parseCohort(c).personas.length, 1);
  c.segments[0].weightBasis = 'sourced'; assert.throws(() => parseCohort(c), /need evidence/);
  c.segments[0].weightBasis = 'assumed'; c.personas[0].age = 17; assert.throws(() => parseCohort(c));
  c.personas[0].age = 25; c.personas[0].sourceIds = ['unknown']; assert.throws(() => parseCohort(c), /unknown source/);
});
test('exports machine-readable schema and rejects prototype pollution keys', () => {
  assert.equal(jsonSchema('pipeline').type, 'object');
  const p = pipeline(); (p.stages[0] as any).id = '__proto__'; assert.throws(() => parsePipeline(p));
});

test('Score schemas match TypeSafe’s 2–10 level limit in validation and JSON Schema', () => {
  const p = pipeline();
  (p.stages[0] as any).questions = { rating: { type: 'score', label: 'Rating', instructions: 'Rate the idea.', criteria: Array.from({ length: 10 }, (_, i) => `Level ${i}`) } };
  assert.equal(parsePipeline(p).stages.length, 1);
  (p.stages[0] as any).questions.rating.criteria.push('Level 10');
  assert.throws(() => parsePipeline(p), /Score requires 2–10 levels/);

  const schema = jsonSchema('pipeline') as any;
  const questionVariants = schema.properties.stages.items.oneOf[0].properties.questions.additionalProperties.oneOf;
  const scoreVariant = questionVariants.find((variant: any) => variant.properties?.type?.const === 'score');
  assert.equal(scoreVariant?.properties?.criteria?.maxItems, 10);
});
