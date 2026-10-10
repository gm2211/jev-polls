import type { Cohort, DistributionTarget, DistributionTargetBucket, Persona } from './types.js';

/**
 * Browser-safe cohort analytics. Keep this factory self-contained: the workspace
 * serializes `createCohortInsights.toString()` into its inline client script.
 */
export function createCohortInsights() {
  type Kind = 'numeric' | 'categorical';
  type Target = { field: string; kind: Kind; buckets: { label: string; percent: number; value?: string | number | boolean | null; min?: number; max?: number }[] };
  const reserved = new Set(['__proto__', 'prototype', 'constructor']);
  function canonical(value: any): any {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const ordered: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) ordered[key] = canonical(value[key]);
      return ordered;
    }
    return value;
  }
  function stable(value: unknown): string { return typeof value === 'string' ? value : JSON.stringify(canonical(value)); }
  function categoryKey(value: unknown): string { return `${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}:${stable(value)}`; }
  function getPersonaFieldValue(persona: any, field: string): unknown {
    if (field === 'age') return persona?.age;
    if (field === 'segment') return persona?.segment;
    if (!field.startsWith('attributes.')) return undefined;
    const parts = field.slice('attributes.'.length).split('.');
    if (parts.some((part) => !part || reserved.has(part))) return undefined;
    let value: any = persona?.attributes;
    for (const part of parts) {
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return Array.isArray(value) ? stable(value) : value;
  }
  function rawFieldValue(persona: any, field: string): unknown {
    if (!field.startsWith('attributes.')) return undefined;
    let value: any = persona?.attributes;
    for (const part of field.slice('attributes.'.length).split('.')) {
      if (!part || reserved.has(part) || value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
      value = value[part];
    }
    return value;
  }
  function arrayItems(value: unknown): string[] { return [...new Set((value as unknown[]).map((item) => (item === null ? 'null' : stable(item))))]; }
  function matchesDistributionBucket(value: unknown, bucket: any, kind?: Kind): boolean {
    const bucketKind = kind ?? (typeof bucket?.min === 'number' || typeof bucket?.max === 'number' ? 'numeric' : 'categorical');
    if (bucketKind === 'numeric') return typeof value === 'number' && Number.isFinite(value) && typeof bucket?.min === 'number' && typeof bucket?.max === 'number' && value >= bucket.min && value < bucket.max;
    return Object.hasOwn(bucket ?? {}, 'value') && (value === null || value === undefined ? bucket.value === null : value === bucket.value);
  }
  function validateTargets(targets: unknown): true {
    if (!Array.isArray(targets) || targets.length > 100) throw new Error('distributionTargets must be an array with at most 100 entries');
    const targetFields = new Set<string>();
    for (const [targetIndex, raw] of targets.entries()) {
      const path = `distributionTargets[${targetIndex}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${path} must be an object`);
      const target = raw as any;
      if (Object.keys(target).some((key) => !['field', 'kind', 'buckets'].includes(key))) throw new Error(`${path} has an unknown field`);
      if (typeof target.field !== 'string' || target.field.length < 1 || target.field.length > 256) throw new Error(`${path}.field must be a nonempty path up to 256 characters`);
      const fieldParts = target.field.split('.');
      if (!(['age', 'segment'].includes(target.field) || (fieldParts[0] === 'attributes' && fieldParts.length > 1)) || fieldParts.some((part: string) => !/^[A-Za-z0-9_-]+$/.test(part) || reserved.has(part))) throw new Error(`${path}.field must be age, segment, or a safe attributes.<path>`);
      if (targetFields.has(target.field)) throw new Error(`Duplicate distribution target field '${target.field}'`);
      targetFields.add(target.field);
      if (target.kind !== 'numeric' && target.kind !== 'categorical') throw new Error(`${path}.kind must be numeric or categorical`);
      if (!Array.isArray(target.buckets) || target.buckets.length < 1 || target.buckets.length > 100) throw new Error(`${path}.buckets must contain 1–100 entries`);
      let total = 0;
      const categoricalValues = new Set<string>();
      const numericRanges: Array<{ min: number; max: number; index: number }> = [];
      for (const [bucketIndex, bucket] of target.buckets.entries()) {
        const bucketPath = `${path}.buckets[${bucketIndex}]`;
        if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error(`${bucketPath} must be an object`);
        if (Object.keys(bucket).some((key) => !['label', 'percent', 'value', 'min', 'max'].includes(key))) throw new Error(`${bucketPath} has an unknown field`);
        if (typeof bucket.label !== 'string' || !bucket.label.trim() || bucket.label.length > 200) throw new Error(`${bucketPath}.label must be nonempty and at most 200 characters`);
        if (typeof bucket.percent !== 'number' || !Number.isFinite(bucket.percent) || bucket.percent < 0 || bucket.percent > 100) throw new Error(`${bucketPath}.percent must be between 0 and 100`);
        total += bucket.percent;
        if (target.kind === 'numeric') {
          if (Object.hasOwn(bucket, 'value') || typeof bucket.min !== 'number' || !Number.isFinite(bucket.min) || typeof bucket.max !== 'number' || !Number.isFinite(bucket.max)) throw new Error(`${bucketPath} numeric buckets require min and max and cannot have value`);
          if (bucket.min >= bucket.max) throw new Error(`${bucketPath} must have min < max`);
          if (target.field === 'age' && (bucket.min < 18 || bucket.max > 121 || !Number.isInteger(bucket.min) || !Number.isInteger(bucket.max))) throw new Error(`${bucketPath} age bounds must use integer boundaries within 18..120 (max exclusive 121)`);
          numericRanges.push({ min: bucket.min, max: bucket.max, index: bucketIndex });
        } else {
          if (!Object.hasOwn(bucket, 'value') || Object.hasOwn(bucket, 'min') || Object.hasOwn(bucket, 'max')) throw new Error(`${bucketPath} categorical buckets require value and cannot have min or max`);
          if (!(bucket.value === null || (typeof bucket.value === 'string' && bucket.value.length <= 1000) || typeof bucket.value === 'boolean' || (typeof bucket.value === 'number' && Number.isFinite(bucket.value)))) throw new Error(`${bucketPath}.value must be a string up to 1000 characters, number, boolean, or null`);
          const key = categoryKey(bucket.value);
          if (categoricalValues.has(key)) throw new Error(`${path} has duplicate categorical bucket value ${key}`);
          categoricalValues.add(key);
        }
      }
      if (Math.abs(total - 100) > 0.01) throw new Error(`${path} bucket percentages must total 100`);
      numericRanges.sort((a, b) => a.min - b.min || a.max - b.max);
      let furthestRange = numericRanges[0];
      for (let index = 1; index < numericRanges.length; index += 1) {
        const current = numericRanges[index]!;
        if (furthestRange && current.min < furthestRange.max) throw new Error(`${path} has overlapping numeric ranges in buckets ${furthestRange.index} and ${current.index}`);
        if (!furthestRange || current.max > furthestRange.max) furthestRange = current;
      }
    }
    return true;
  }
  function effectiveWeights(cohort: any): { personaId: string; segment: string; weight: number }[] {
    const segments = Array.isArray(cohort?.segments) ? cohort.segments : [];
    const personas = Array.isArray(cohort?.personas) ? cohort.personas : [];
    const segmentTotal = segments.reduce((sum: number, segment: any) => sum + (Number.isFinite(segment?.weight) && segment.weight > 0 ? segment.weight : 0), 0);
    const segmentById = new Map(segments.map((segment: any) => [segment.id, segment]));
    const bySegment = new Map<string, { total: number; personas: any[] }>();
    for (const persona of personas) {
      const group = bySegment.get(persona.segment) ?? { total: 0, personas: [] };
      const weight = Number.isFinite(persona.weight) && persona.weight > 0 ? persona.weight : 0;
      group.total += weight;
      group.personas.push(persona);
      bySegment.set(persona.segment, group);
    }
    return personas.map((persona: any) => {
      const segment: any = segmentById.get(persona.segment);
      const group = bySegment.get(persona.segment);
      const segmentShare = segmentTotal > 0 && Number.isFinite(segment?.weight) && segment.weight > 0 ? segment.weight / segmentTotal : 0;
      const withinWeight = Number.isFinite(persona.weight) && persona.weight > 0 ? persona.weight : 0;
      return { personaId: String(persona.id), segment: String(persona.segment), weight: group?.total ? segmentShare * withinWeight / group.total : 0 };
    });
  }
  function discoverFields(cohort: any): { field: string; kind: Kind; values: string[] }[] {
    const personas = Array.isArray(cohort?.personas) ? cohort.personas : [];
    const fields = new Map<string, unknown[]>();
    fields.set('age', personas.map((persona: any) => persona.age));
    fields.set('segment', personas.map((persona: any) => persona.segment));
    function visit(value: any, path: string) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        const values = fields.get(path) ?? [];
        values.push(value);
        fields.set(path, values);
        return;
      }
      for (const [key, nested] of Object.entries(value)) {
        if (!key || reserved.has(key) || key.includes('.')) continue;
        visit(nested, path ? `${path}.${key}` : key);
      }
    }
    for (const persona of personas) visit(persona.attributes ?? {}, 'attributes');
    return [...fields.entries()].map(([field, values]) => {
      const present = values.filter((value) => value !== undefined && value !== null);
      const numeric = present.length > 0 && present.every((value) => typeof value === 'number' && Number.isFinite(value));
      const kind: Kind = numeric ? 'numeric' : 'categorical';
      const uniqueValues = new Map<string, string>();
      for (const value of values) if (value !== undefined) uniqueValues.set(categoryKey(value), value === null ? 'null' : stable(value));
      const categories = [...uniqueValues.values()].sort((a, b) => a.localeCompare(b));
      return { field, kind, values: kind === 'categorical' ? categories : [] };
    }).sort((a, b) => a.field.localeCompare(b.field));
  }
  function distribution(cohort: any, field: string, weighted = false) {
    const discovered = discoverFields(cohort).find((entry) => entry.field === field) ?? (field.startsWith('attributes.') && field.slice('attributes.'.length).split('.').every((part) => /^[A-Za-z0-9_-]+$/.test(part) && !reserved.has(part)) ? { field, kind: 'categorical' as const, values: [] } : undefined);
    if (!discovered) throw new Error(`Unknown cohort field '${field}'`);
    const personas = Array.isArray(cohort?.personas) ? cohort.personas : [];
    const weightById = new Map(effectiveWeights(cohort).map((entry) => [entry.personaId, entry.weight]));
    const records: { persona: any; value: unknown; weight: number }[] = personas.map((persona: any) => {
      const raw = getPersonaFieldValue(persona, field);
      const value = raw === undefined ? null : raw;
      return { persona, value, weight: weighted ? weightById.get(String(persona.id)) ?? 0 : 1 };
    });
    const multi = field.startsWith('attributes.') && personas.some((persona: any) => Array.isArray(rawFieldValue(persona, field)));
    if (multi) {
      const items = new Map<string, typeof records>();
      const none: typeof records = [];
      for (const [index, record] of records.entries()) {
        const raw = rawFieldValue(personas[index], field);
        const list = Array.isArray(raw) ? arrayItems(raw) : raw === undefined || raw === null ? [] : [stable(raw)];
        if (!list.length) none.push(record);
        for (const item of list) { const group = items.get(item) ?? []; group.push(record); items.set(item, group); }
      }
      const totalWeight = weighted ? 1 : records.length;
      const toBucket = (label: string, members: typeof records, value: unknown) => { const mass = members.reduce((sum, record) => sum + record.weight, 0); return { label, count: members.length, weight: mass, percent: totalWeight > 0 ? mass / totalWeight * 100 : 0, value, member: value !== null } as any; };
      const buckets = [...items.entries()].sort(([a, am], [b, bm]) => bm.length - am.length || a.localeCompare(b)).map(([item, members]) => toBucket(item, members, item));
      if (none.length) buckets.push(toBucket('Missing', none, null));
      const observed = records.reduce((sum, record) => sum + record.weight, 0);
      const result: any = { field, kind: 'categorical', multi: true, total: records.length, missing: none.length, buckets };
      if (weighted && observed < 1 - 1e-9) result.warning = `Observed cohort profiles cover ${(observed * 100).toFixed(1)}% of the effective population weight.`;
      return result;
    }
    const missing = records.filter((record) => record.value === null);
    const present = records.filter((record) => record.value !== null);
    const observedMass = records.reduce((sum, record) => sum + record.weight, 0);
    const totalMass = weighted ? 1 : records.length;
    function makeBucket(label: string, members: typeof records, range?: { min: number; max: number }, value?: unknown) {
      const mass = members.reduce((sum, record) => sum + record.weight, 0);
      const bucket: any = { label, count: members.length, weight: mass, percent: totalMass > 0 ? mass / totalMass * 100 : 0 };
      if (range) { bucket.min = range.min; bucket.max = range.max; }
      if (value !== undefined) bucket.value = value;
      return bucket;
    }
    const buckets: any[] = [];
    if (discovered.kind === 'numeric') {
      const numbers = present.map((record) => record.value as number).filter(Number.isFinite);
      if (numbers.length && discovered.field === 'age') {
        const bounds = [18, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 121];
        for (let index = 0; index < bounds.length - 1; index += 1) {
          const min = bounds[index]!;
          const max = bounds[index + 1]!;
          const members = present.filter((record) => typeof record.value === 'number' && record.value >= min && record.value < max);
          if (members.length) buckets.push(makeBucket(max - min === 1 ? `${min}` : `${min}–${max - 1}`, members, { min, max }));
        }
      } else if (numbers.length) {
        const minimum = Math.min(...numbers);
        const observedMaximum = Math.max(...numbers);
        const desired = (observedMaximum - minimum) / Math.max(2, Math.min(12, Math.ceil(Math.sqrt(numbers.length))));
        const power = 10 ** Math.floor(Math.log10(desired || 1));
        const fraction = desired / power;
        const step = (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
        const start = Math.floor(minimum / step) * step;
        const end = (Math.floor(observedMaximum / step) + 1) * step;
        for (let min = start; min < end; min += step) {
          const max = min + step;
          const members = present.filter((record) => typeof record.value === 'number' && record.value >= min && record.value < max);
          if (members.length) buckets.push(makeBucket(`${Number(min.toPrecision(5))}–<${Number(max.toPrecision(5))}`, members, { min, max }));
        }
      }
    } else {
      const categories = new Map<string, typeof records>();
      for (const record of present) {
        const key = categoryKey(record.value);
        const group = categories.get(key) ?? [];
        group.push(record);
        categories.set(key, group);
      }
      const display = (value: unknown) => value === null ? 'null' : stable(value);
      for (const [, members] of [...categories.entries()].sort(([left], [right]) => left.localeCompare(right))) buckets.push(makeBucket(display(members[0]!.value), members, undefined, members[0]!.value));
    }
    if (missing.length) buckets.push(makeBucket('Missing', missing, undefined, null));
    const result: any = { field, kind: discovered.kind, total: records.length, missing: missing.length, buckets };
    if (weighted && observedMass < 1 - 1e-9) result.warning = `Observed cohort profiles cover ${(observedMass * 100).toFixed(1)}% of the effective population weight.`;
    return result;
  }
  function allocateTargets(targets: Target[], size: number) {
    validateTargets(targets);
    if (!Number.isSafeInteger(size) || size < 0 || size > 20_000) throw new Error('size must be an integer between 0 and 20000');
    const slots = Array.from({ length: size }, (_, slot) => ({ slot, buckets: {} as Record<string, number> }));
    for (const target of targets) {
      const exact = target.buckets.map((bucket) => bucket.percent * size / 100);
      const quota = exact.map(Math.floor);
      let remaining = size - quota.reduce((sum, value) => sum + value, 0);
      const order = exact.map((amount, index) => ({ index, fraction: amount - Math.floor(amount) })).sort((left, right) => right.fraction - left.fraction || left.index - right.index);
      for (const item of order) { if (!remaining) break; quota[item.index]! += 1; remaining -= 1; }
      let hash = 2166136261;
      for (const char of target.field) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
      const ranked = slots.map(({ slot }) => {
        let value = hash ^ Math.imul(slot + 1, 0x9e3779b1);
        value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
        value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
        return { slot, rank: (value ^ (value >>> 16)) >>> 0 };
      }).sort((left, right) => left.rank - right.rank || left.slot - right.slot);
      let cursor = 0;
      for (let bucketIndex = 0; bucketIndex < quota.length; bucketIndex += 1) {
        for (let count = 0; count < quota[bucketIndex]!; count += 1) {
          const rankedSlot = ranked[cursor++]!;
          slots[rankedSlot.slot]!.buckets[target.field] = bucketIndex;
        }
      }
    }
    return slots;
  }
  function matchesBucket(persona: any, field: string, bucket: any, kind?: Kind): boolean {
    if (bucket?.member) { const raw = rawFieldValue(persona, field); return Array.isArray(raw) ? arrayItems(raw).includes(bucket.value) : raw !== undefined && raw !== null && stable(raw) === bucket.value; }
    if (bucket?.value === null && bucket.label === 'Missing') { const raw = rawFieldValue(persona, field); if (Array.isArray(raw)) return raw.length === 0; }
    return matchesDistributionBucket(getPersonaFieldValue(persona, field), bucket, kind); }
  return { discoverFields, distribution, effectiveWeights, allocateTargets, matchesBucket, getPersonaFieldValue, matchesDistributionBucket, validateTargets };
}

const cohortInsights = createCohortInsights();
export const getPersonaFieldValue = (persona: Persona | Record<string, unknown>, field: string): unknown => cohortInsights.getPersonaFieldValue(persona, field);
export const matchesDistributionBucket = (value: unknown, bucket: DistributionTargetBucket, kind?: DistributionTarget['kind']): boolean => cohortInsights.matchesDistributionBucket(value, bucket, kind);
export const validateTargets = (targets: unknown): true => cohortInsights.validateTargets(targets);

// Keep the Cohort import in the public module's type surface useful to editors.
export type CohortInsightInput = Cohort;
