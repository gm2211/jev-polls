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
test('poll input bindings require declared outputs and type-compatible selectors', () => {
  const p = pipeline();
  p.stages.push({ ...structuredClone(poll), id: 'second', dependsOn: ['first'], inputs: { prior: { stage: 'first', question: 'favorite', select: 'probabilities' } } });
  assert.equal(parsePipeline(p).stages.length, 2);
  (p.stages[1] as any).inputs.prior.stage = 'missing'; assert.throws(() => parsePipeline(p), /must be in dependsOn/);
  (p.stages[1] as any).inputs.prior.stage = 'first'; (p.stages[1] as any).inputs.prior.question = 'unknown'; assert.throws(() => parsePipeline(p), /unknown input question/);
  (p.stages[1] as any).inputs.prior.question = 'favorite'; (p.stages[1] as any).inputs.prior.select = 'mean'; assert.throws(() => parsePipeline(p), /incompatible with choice/);
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

test('Choice accepts names and descriptions without replacing stable keys or legacy criteria', () => {
  const p = pipeline();
  const criteria = { option_a: { label: 'Daily ritual', description: 'A compact kit for everyday use.' }, legacy: 'Existing answer', neither: null };
  (p.stages[0] as any).questions.favorite.criteria = criteria;
  p.stages.push({ ...structuredClone(poll), id: 'followup', dependsOn: ['first'], when: { stage: 'first', question: 'favorite', metric: 'winner', op: 'eq', value: 'option_a' } });
  const parsed = parsePipeline(p);
  assert.deepEqual(parsed.stages[0]?.kind === 'poll' && parsed.stages[0].questions.favorite?.type === 'choice' && parsed.stages[0].questions.favorite.criteria, criteria);
  criteria.option_a.description = '';
  assert.doesNotThrow(() => parsePipeline(p));
  for (const invalid of [{ label: ' ', description: 'Missing name' }, { label: 'Name' }, { label: 'Name', description: 42 }, { label: 'Name', description: '', extra: true }]) {
    (p.stages[0] as any).questions.favorite.criteria.option_a = invalid;
    assert.throws(() => parsePipeline(p));
  }
});

test('cohorts validate optional regeneration distribution targets', () => {
  const c: any = { version: 1, id: 'people', name: 'People', description: 'Example', population: 'Adult gamers', createdAt: '2026-10-03T12:00:00Z', sources: [], segments: [{ id: 'players', label: 'Players', description: 'Players', weight: 1, weightBasis: 'assumed', sourceIds: [] }], personas: [{ id: 'p1', label: 'Person', segment: 'players', age: 22, background: 'Plays games', attributes: { residence: { region: 'north' } }, sourceIds: [], syntheticFields: ['background'], weight: 1 }], assumptions: [] };
  c.distributionTargets = [
    { field: 'age', kind: 'numeric', buckets: [{ label: '18–39', min: 18, max: 40, percent: 35 }, { label: '40+', min: 40, max: 121, percent: 65 }] },
    { field: 'attributes.residence.region', kind: 'categorical', buckets: [{ label: 'North', value: 'north', percent: 80 }, { label: 'Unknown', value: null, percent: 20 }] },
  ];
  assert.equal(parseCohort(c).distributionTargets?.length, 2);
  c.distributionTargets[0].buckets[1].min = 39;
  assert.throws(() => parseCohort(c), /overlapping/);
  c.distributionTargets[0].buckets[1].min = 40;
  c.distributionTargets[1].field = 'attributes.residence.__proto__';
  assert.throws(() => parseCohort(c), /safe attributes/);
});

test('study layout stores finite canvas positions only', () => {
  assert.deepEqual(parsePipeline({ ...pipeline(), layout: { first: { x: 10, y: 20.5 } } }).layout, { first: { x: 10, y: 20.5 } });
  assert.throws(() => parsePipeline({ ...pipeline(), layout: { first: { x: 10 } } }));
  assert.throws(() => parsePipeline({ ...pipeline(), layout: { first: { x: 1, y: 2, z: 3 } } }), /Unrecognized/);
});
