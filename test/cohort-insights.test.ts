import test from 'node:test';
import assert from 'node:assert/strict';
import { createCohortInsights, getPersonaFieldValue, matchesDistributionBucket, validateTargets } from '../src/cohort-insights.js';
import type { Cohort, DistributionTarget } from '../src/types.js';

const cohort: Cohort = {
  version: 1, id: 'people', name: 'People', description: 'Test cohort', population: 'Adults', createdAt: '2026-10-03T12:00:00Z',
  sources: [],
  segments: [
    { id: 'a', label: 'A', description: 'A', weight: 0.75, weightBasis: 'assumed', sourceIds: [] },
    { id: 'b', label: 'B', description: 'B', weight: 0.25, weightBasis: 'user', sourceIds: [] },
    { id: 'zero', label: 'Zero', description: 'Zero', weight: 0, weightBasis: 'user', sourceIds: [] },
  ],
  personas: [
    { id: 'p1', label: 'One', segment: 'a', age: 20, background: 'One', attributes: { home: { region: 'north', years: 2 }, tags: ['quiet', 'coastal'], empty: null }, sourceIds: [], syntheticFields: [], weight: 1 },
    { id: 'p2', label: 'Two', segment: 'a', age: 40, background: 'Two', attributes: { home: { region: 'south', years: 4 }, tags: ['loud'], empty: null }, sourceIds: [], syntheticFields: [], weight: 3 },
    { id: 'p3', label: 'Three', segment: 'b', age: 60, background: 'Three', attributes: { home: { years: 8 }, tags: null }, sourceIds: [], syntheticFields: [], weight: 1 },
    { id: 'p4', label: 'Four', segment: 'zero', age: 80, background: 'Four', attributes: {}, sourceIds: [], syntheticFields: [], weight: 1 },
  ], assumptions: [],
};

test('effective weights normalize segment population shares and persona weights', () => {
  const weights = createCohortInsights().effectiveWeights(cohort);
  assert.deepEqual(weights.map(({ personaId, weight }) => [personaId, weight]), [
    ['p1', 0.1875], ['p2', 0.5625], ['p3', 0.25], ['p4', 0],
  ]);
  assert.equal(weights.reduce((sum, item) => sum + item.weight, 0), 1);
});

test('serialized browser factory remains self-contained', () => {
  // esbuild's keepNames transform emits these harmless names, and the inline
  // workspace wrapper supplies the same scoped shim before constructing this factory.
  const browserFactory = new Function('__name', `return (${createCohortInsights.toString()})()`) as (helper: (target: unknown) => unknown) => ReturnType<typeof createCohortInsights>;
  const insights = browserFactory((target) => target);
  assert.equal(insights.discoverFields(cohort).some(({ field }) => field === 'attributes.home.region'), true);
  assert.equal(insights.matchesBucket(cohort.personas[0]!, 'age', { min: 20, max: 30 }, 'numeric'), true);
});

test('discovers nested structured fields and stable array categories, with explicit missing values', () => {
  const insights = createCohortInsights();
  const fields = insights.discoverFields(cohort);
  assert.deepEqual(fields.find(({ field }) => field === 'attributes.home.years')?.kind, 'numeric');
  assert.deepEqual(fields.find(({ field }) => field === 'attributes.home.region'), { field: 'attributes.home.region', kind: 'categorical', values: ['north', 'south'] });
  assert.deepEqual(fields.find(({ field }) => field === 'attributes.tags')?.values, ['["loud"]', '["quiet","coastal"]', 'null']);
  assert.equal(getPersonaFieldValue(cohort.personas[2]!, 'attributes.home.region'), undefined);
  assert.equal(getPersonaFieldValue(cohort.personas[0]!, 'attributes.tags'), '["quiet","coastal"]');
  assert.equal(getPersonaFieldValue(cohort.personas[0]!, 'attributes.__proto__'), undefined);
  const result = insights.distribution(cohort, 'attributes.home.region');
  assert.deepEqual(result.buckets.map(({ label, count, value }) => [label, count, value]), [['north', 1, 'north'], ['south', 1, 'south'], ['Missing', 2, null]]);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.percent, 0), 100);
  const absent = insights.distribution(cohort, 'attributes.demographics.ethnicity');
  assert.equal(absent.buckets[0]?.value, null);
  assert.equal(absent.buckets[0]?.count, cohort.personas.length);
});

test('numeric distributions expose non-overlapping half-open bins and weighted population shares', () => {
  const unweighted = createCohortInsights().distribution(cohort, 'age');
  assert.equal(unweighted.kind, 'numeric');
  assert.equal(unweighted.buckets.reduce((sum, bucket) => sum + bucket.count, 0), 4);
  assert.equal(unweighted.buckets.find((bucket) => bucket.min === 20)?.label, '20–29');
  const weighted = createCohortInsights().distribution(cohort, 'age', true);
  assert.equal(weighted.buckets.reduce((sum, bucket) => sum + bucket.percent, 0), 100);
  assert.equal(weighted.buckets.find((bucket) => bucket.min !== undefined && bucket.min <= 20 && 20 < bucket.max!)?.percent, 18.75);
  assert.equal(matchesDistributionBucket(20, { label: '20–40', min: 20, max: 40, percent: 100 }, 'numeric'), true);
  assert.equal(matchesDistributionBucket(40, { label: '20–40', min: 20, max: 40, percent: 100 }, 'numeric'), false);
  assert.equal(matchesDistributionBucket(undefined, { label: 'Missing', value: null, percent: 100 }, 'categorical'), true);
  assert.equal(matchesDistributionBucket(undefined, { label: 'Missing', value: null, percent: 100 }), true);
  const missingBucket = unweighted.buckets.find((bucket) => bucket.label === '18–19');
  assert.equal(missingBucket, undefined);
  assert.equal(createCohortInsights().matchesBucket(cohort.personas[2]!, 'attributes.home.region', { label: 'Missing', value: null, percent: 100 }), true);
});

test('preserves uncovered population mass and reports its share', () => {
  const partial = structuredClone(cohort);
  partial.segments.push({ id: 'unsampled', label: 'Unsampled', description: 'No represented profiles', weight: 3, weightBasis: 'assumed', sourceIds: [] });
  const result = createCohortInsights().distribution(partial, 'segment', true);
  assert.ok(Math.abs(result.buckets.reduce((sum, bucket) => sum + bucket.percent, 0) - 25) < 1e-9);
  assert.match(result.warning ?? '', /cover 25\.0%/);
});

test('categorical aggregation keeps numeric and string values distinct', () => {
  const mixed = structuredClone(cohort);
  mixed.personas[0]!.attributes.mixed = 1;
  mixed.personas[1]!.attributes.mixed = '1';
  mixed.personas[2]!.attributes.mixed = 1;
  const result = createCohortInsights().distribution(mixed, 'attributes.mixed');
  assert.equal(result.buckets.length, 3); // Number, string, and missing.
  assert.deepEqual(result.buckets.slice(0, 2).map((bucket) => bucket.value), [1, '1']);
});

test('validates target ranges, categorical null buckets, and safe field paths', () => {
  const valid: DistributionTarget[] = [
    { field: 'age', kind: 'numeric', buckets: [{ label: '18–39', min: 18, max: 40, percent: 50 }, { label: '40+', min: 40, max: 121, percent: 50 }] },
    { field: 'attributes.home.region', kind: 'categorical', buckets: [{ label: 'North', value: 'north', percent: 60 }, { label: 'Missing', value: null, percent: 40 }] },
  ];
  assert.equal(validateTargets(valid), true);
  assert.throws(() => validateTargets([{ ...valid[0], buckets: [{ label: 'Bad', min: 17, max: 121, percent: 100 }] }]), /age bounds/);
  assert.throws(() => validateTargets([{ ...valid[0], field: 'attributes.__proto__.x' }]), /safe attributes/);
  assert.throws(() => validateTargets([{ ...valid[0], buckets: [{ label: 'One', min: 18, max: 50, percent: 50 }, { label: 'Two', min: 49, max: 121, percent: 50 }] }]), /overlapping/);
  assert.throws(() => validateTargets([{ field: 'segment', kind: 'categorical', buckets: [{ label: 'Missing', value: null, percent: 40 }, { label: 'Missing again', value: null, percent: 60 }] }]), /duplicate categorical bucket/);
});

test('allocates deterministic marginal quotas with separate field orderings', () => {
  const targets: DistributionTarget[] = [
    { field: 'segment', kind: 'categorical', buckets: [{ label: 'A', value: 'a', percent: 50 }, { label: 'B', value: 'b', percent: 30 }, { label: 'Missing', value: null, percent: 20 }] },
    { field: 'attributes.home.region', kind: 'categorical', buckets: [{ label: 'North', value: 'north', percent: 50 }, { label: 'Other', value: null, percent: 50 }] },
  ];
  const insights = createCohortInsights();
  const first = insights.allocateTargets(targets, 11);
  assert.deepEqual(first, insights.allocateTargets(targets, 11));
  assert.deepEqual(first.map((slot) => slot.buckets.segment).reduce((counts, index) => { counts[index!] = (counts[index!] ?? 0) + 1; return counts; }, {} as Record<number, number>), { 0: 6, 1: 3, 2: 2 });
  assert.notDeepEqual(first.map((slot) => slot.buckets.segment), first.map((slot) => slot.buckets['attributes.home.region']));
});
