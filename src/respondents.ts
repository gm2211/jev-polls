import type { Answer, Cohort, Json, Persona, Vote } from './types.js';

/**
 * Who answered an earlier step, as handed to the next step's cohort. Each response can carry the respondent's own
 * profile when it fits Jev's request limits; every hand-off also carries a compact, weighted summary of the group.
 * Profiles are synthetic personas, never observed people.
 */

/** Most attributes summarized per hand-off, and most values listed per attribute before the rest become "other". */
const MAX_ATTRIBUTES = 12;
const MAX_VALUES = 6;
const MAX_SPLIT_OPTIONS = 3;
export const RESPONDENT_NOTE = 'Synthetic personas from the cohort that answered this earlier step, not observed people. Shares are weighted by population weight; answersBy shows how answers split across groups of respondents.';

export interface RespondentLookup { find(cohortId: string | undefined, personaId: string): { persona: Persona; cohort: Cohort } | undefined; cohorts: Cohort[] }

export function respondentLookup(cohorts: Cohort[]): RespondentLookup {
  const byCohort = new Map<string, { cohort: Cohort; personas: Map<string, Persona> }>();
  for (const cohort of cohorts) if (!byCohort.has(cohort.id)) byCohort.set(cohort.id, { cohort, personas: new Map(cohort.personas.map((persona) => [persona.id, persona])) });
  return {
    cohorts: [...byCohort.values()].map((item) => item.cohort),
    find(cohortId, personaId) {
      const scoped = cohortId === undefined ? undefined : byCohort.get(cohortId);
      const pools = scoped ? [scoped] : [...byCohort.values()];
      for (const pool of pools) {
        const persona = pool.personas.get(personaId);
        if (persona) return { persona, cohort: pool.cohort };
      }
      return undefined;
    },
  };
}

/** One respondent's profile, placed next to their answer when the full detail fits. */
export function respondentProfile(persona: Persona, cohort: Cohort): Json {
  const segment = cohort.segments.find((item) => item.id === persona.segment);
  return { label: persona.label, age: persona.age, segment: segment?.label ?? persona.segment, background: persona.background, attributes: persona.attributes };
}

const round = (value: number): number => Math.round(value * 1000) / 1000;
const isScalar = (value: Json): value is string | number | boolean => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

interface Person { persona: Persona; cohort: Cohort; weight: number; answers: Vote['answers'][]; weights: number[] }

/** Groups a respondent can fall into for one attribute (a list attribute can put them in several). */
type Grouper = (person: Person) => string[];

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Weighted shares per value, keeping the largest values and folding the rest into "other". */
function shares(people: Person[], group: Grouper, total: number): { shares: Record<string, number>; kept: Set<string> } {
  const weights = new Map<string, number>();
  for (const person of people) for (const key of group(person)) weights.set(key, (weights.get(key) ?? 0) + person.weight);
  const ordered = [...weights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const kept = ordered.slice(0, MAX_VALUES);
  const rest = ordered.slice(MAX_VALUES).reduce((sum, [, weight]) => sum + weight, 0);
  const result = Object.fromEntries(kept.map(([key, weight]) => [key, round(weight / total)]));
  if (rest > 0) result.other = round(rest / total);
  return { shares: result, kept: new Set(kept.map(([key]) => key)) };
}

/** A compact read of one group's answers to one question: top options for Choice, the mean for Score and Noul. */
function answerSplit(answers: Array<{ answer: Answer; weight: number }>): Json {
  const total = answers.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0) || !answers.length) return null;
  const first = answers[0]!.answer;
  if (first.type === 'noul') return round(answers.reduce((sum, item) => sum + (item.answer.type === 'noul' ? item.answer.noul : 0) * item.weight, 0) / total);
  if (first.type === 'score') return { mean: round(answers.reduce((sum, item) => sum + (item.answer.type === 'score' ? item.answer.score : 0) * item.weight, 0) / total) };
  const probabilities = new Map<string, number>();
  for (const { answer, weight } of answers) {
    if (answer.type !== 'choice') continue;
    for (const [key, value] of Object.entries(answer.probabilities)) probabilities.set(key, (probabilities.get(key) ?? 0) + value * weight);
  }
  return Object.fromEntries([...probabilities.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MAX_SPLIT_OPTIONS).map(([key, value]) => [key, round(value / total)]));
}

/**
 * Weighted summary of who answered an earlier step: segments, age, attribute distributions, and how each question's
 * answers split across those groups. Used on its own when per-person profiles would not fit.
 */
export function respondentsSummary(votes: Vote[], questions: string[], lookup: RespondentLookup): Json {
  const people = new Map<string, Person>();
  for (const vote of votes) {
    const found = lookup.find(vote.cohortId, vote.personaId);
    if (!found) continue;
    const key = `${found.cohort.id}\u0000${found.persona.id}`;
    const person = people.get(key) ?? { ...found, weight: 0, answers: [], weights: [] };
    person.weight += vote.weight;
    person.answers.push(vote.answers);
    person.weights.push(vote.weight);
    people.set(key, person);
  }
  const list = [...people.values()].filter((person) => person.weight > 0);
  const total = list.reduce((sum, person) => sum + person.weight, 0);
  if (!list.length || !(total > 0)) return null;
  const cohorts = [...new Map(list.map((person) => [person.cohort.id, person.cohort])).values()];

  const groupers: Array<{ name: string; group: Grouper; distribution: Json }> = [];
  const segmentOf: Grouper = (person) => [person.cohort.segments.find((item) => item.id === person.persona.segment)?.label ?? person.persona.segment];
  const numeric = (name: string, value: (person: Person) => number | undefined): void => {
    const values = list.map(value).filter((item): item is number => typeof item === 'number' && Number.isFinite(item));
    if (!values.length) return;
    const weighted = list.reduce((sum, person) => { const item = value(person); return typeof item === 'number' && Number.isFinite(item) ? { value: sum.value + item * person.weight, weight: sum.weight + person.weight } : sum; }, { value: 0, weight: 0 });
    const cut = median(values);
    const group: Grouper = (person) => { const item = value(person); return typeof item === 'number' && Number.isFinite(item) ? [item < cut ? `under ${round(cut)}` : `${round(cut)} or more`] : []; };
    groupers.push({ name, group, distribution: { min: round(Math.min(...values)), max: round(Math.max(...values)), mean: round(weighted.value / weighted.weight) } });
  };
  groupers.push({ name: 'segment', group: segmentOf, distribution: shares(list, segmentOf, total).shares });
  numeric('age', (person) => person.persona.age);

  const attributeCounts = new Map<string, number>();
  for (const person of list) for (const key of Object.keys(person.persona.attributes ?? {})) attributeCounts.set(key, (attributeCounts.get(key) ?? 0) + 1);
  const attributes = [...attributeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key]) => key);
  let omitted = 0;
  for (const key of attributes) {
    const values = list.map((person) => person.persona.attributes?.[key]).filter((value): value is Json => value !== undefined && value !== null);
    const isNumbers = values.length > 0 && values.every((value) => typeof value === 'number');
    const isCategorical = values.length > 0 && values.every((value) => isScalar(value) || (Array.isArray(value) && value.every(isScalar)));
    if (!isNumbers && !isCategorical) { omitted += 1; continue; }
    if (groupers.length - 2 >= MAX_ATTRIBUTES) { omitted += 1; continue; }
    if (isNumbers) { numeric(key, (person) => person.persona.attributes?.[key] as number | undefined); continue; }
    const raw: Grouper = (person) => { const value = person.persona.attributes?.[key]; return value === undefined || value === null ? [] : (Array.isArray(value) ? value : [value]).map(String); };
    const { shares: distribution, kept } = shares(list, raw, total);
    groupers.push({ name: key, group: (person) => [...new Set(raw(person).map((value) => kept.has(value) ? value : 'other'))], distribution });
  }

  const answersBy: Record<string, Json> = {};
  for (const question of questions) {
    const byGroup: Record<string, Json> = {};
    for (const { name, group } of groupers) {
      const buckets = new Map<string, { people: number; answers: Array<{ answer: Answer; weight: number }> }>();
      for (const person of list) {
        const given = person.answers.flatMap((answers, index) => answers[question] ? [{ answer: answers[question]!, weight: person.weights[index]! }] : []);
        if (!given.length) continue;
        for (const key of group(person)) {
          const bucket = buckets.get(key) ?? { people: 0, answers: [] };
          bucket.people += 1;
          bucket.answers.push(...given);
          buckets.set(key, bucket);
        }
      }
      if (buckets.size < 2) continue;
      byGroup[name] = Object.fromEntries([...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, bucket]) => [key, { people: bucket.people, answer: answerSplit(bucket.answers) }]));
    }
    if (Object.keys(byGroup).length) answersBy[question] = byGroup;
  }

  return {
    note: RESPONDENT_NOTE,
    cohorts: cohorts.map((cohort) => ({ id: cohort.id, name: cohort.name, population: cohort.population })),
    people: list.length,
    answers: list.reduce((sum, person) => sum + person.answers.length, 0),
    distributions: Object.fromEntries(groupers.map(({ name, distribution }) => [name, distribution])),
    ...(omitted ? { omittedAttributes: omitted } : {}),
    answersBy,
  } as unknown as Json;
}
