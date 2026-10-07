import type {
  Answer, ChoiceQuestion, Question, QuestionSummary, RunRecord, ScoreQuestion,
  SummaryBase, Vote,
} from './types.js';
import { hashValue, seededRandom, stableStringify } from './engine-utils.js';

export interface ComparisonValue {
  runId: string;
  createdAt: string;
  status: RunRecord['status'];
  winner?: string;
  mean?: number;
  topProbability?: number;
  margin?: number;
  probabilities?: Record<string, number>;
}

export interface RunComparison {
  stageId: string;
  questionId: string;
  provider: RunRecord['provider'];
  model: string;
  pipelineHash: string;
  baselineRunId: string;
  runs: ComparisonValue[];
  differencesFromBaseline: Array<{ runId: string; metric: string; difference: number }>;
  averagesAcrossRuns: {
    runCount: number;
    mean?: number;
    meanSpread?: number;
    topProbability?: number;
    margin?: number;
    probabilities?: Record<string, number>;
    probabilitySpread?: Record<string, number>;
  };
  notes: string[];
}

export interface SimulationInterval { mean: number; lower: number; upper: number }
export interface VoteSimulation {
  label: 'conditional on model outputs';
  runId: string;
  stageId: string;
  questionId: string;
  draws: number;
  seed: string;
  respondentCount: number;
  metric: 'choice-share' | 'yes-probability' | 'score';
  intervals: Record<string, SimulationInterval>;
  winnerFrequency?: Record<string, number>;
  tieCount?: number;
  tieRate?: number;
  intervalBasis: 'synthetic respondent predictions; conditional on model outputs';
  intervalsArePopulationConfidenceIntervals: false;
}

export function summarizeVotes(questions: Record<string, Question>, votes: Vote[]): Record<string, QuestionSummary> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, summarizeOne(question, votes, id)]));
}

function summarizeOne(question: Question, votes: Vote[], questionId: string): QuestionSummary {
  const summarize = (group: Vote[]): SummaryBase => {
    const valid = group.filter((vote) => vote.answers[questionId] !== undefined && vote.weight > 0).sort(compareVotes);
    const totalWeight = valid.reduce((sum, vote) => sum + vote.weight, 0);
    const base: SummaryBase = {
      type: question.type,
      label: question.label,
      respondentCount: new Set(valid.map((vote) => `${vote.cohortId ?? ''}\0${vote.personaId}`)).size,
      totalWeight,
    };
    if (!totalWeight) return base;
    if (question.type === 'noul') {
      const mean = valid.reduce((sum, vote) => sum + answerAsNoul(vote.answers[questionId]!) * vote.weight, 0) / totalWeight;
      return { ...base, mean, topProbability: mean };
    }
    const probabilities = valid[0]!.answers[questionId]!.type === 'choice'
      ? (valid[0]!.answers[questionId] as Extract<Answer, { type: 'choice' }>).probabilities
      : (valid[0]!.answers[questionId] as Extract<Answer, { type: 'score' }>).probabilities;
    const keys = question.type === 'choice'
      ? Object.keys(question.criteria)
      : question.criteria.map((_, index) => String(index));
    const distribution = Object.fromEntries(keys.map((key) => [key,
      valid.reduce((sum, vote) => sum + answerProbability(vote.answers[questionId]!, key) * vote.weight, 0) / totalWeight,
    ]));
    const optionOrder = question.type === 'choice' ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
    const ranked = Object.entries(distribution).sort(([leftKey, left], [rightKey, right]) => right - left || optionOrder.indexOf(leftKey) - optionOrder.indexOf(rightKey));
    const winner = ranked[0]?.[0];
    const topProbability = ranked[0]?.[1] ?? 0;
    const hasConfidence = valid.every(vote => answerConfidence(vote.answers[questionId]!) !== undefined);
    const confidenceSummary = hasConfidence ? { meanConfidence: valid.reduce((sum, vote) => sum + answerConfidence(vote.answers[questionId]!)! * vote.weight, 0) / totalWeight } : {};
    if (question.type === 'choice') {
      return { ...base, probabilities: distribution, winner, topProbability, margin: topProbability - (ranked[1]?.[1] ?? 0), ...confidenceSummary };
    }
    const mean = valid.reduce((sum, vote) => sum + (vote.answers[questionId] as Extract<Answer, { type: 'score' }>).score * vote.weight, 0) / totalWeight;
    return { ...base, probabilities: distribution, winner, topProbability, mean, ...confidenceSummary };
  };
  const orderedVotes = [...votes].sort(compareVotes);
  const all = summarize(orderedVotes);
  const bySegment: Record<string, SummaryBase> = {};
  const segmentName = (vote: Vote): string => vote.segment;
  for (const segment of new Set(orderedVotes.map(segmentName))) bySegment[segment] = summarize(orderedVotes.filter((vote) => segmentName(vote) === segment));
  const byRepeat: Record<string, SummaryBase> = {};
  for (const repeat of new Set(orderedVotes.map((vote) => vote.repeat))) byRepeat[String(repeat)] = summarize(orderedVotes.filter((vote) => vote.repeat === repeat));
  return { ...all, bySegment, byRepeat };
}

function compareVotes(left: Vote, right: Vote): number {
  return (left.cohortId ?? '').localeCompare(right.cohortId ?? '') ||
    left.personaId.localeCompare(right.personaId) ||
    left.repeat - right.repeat ||
    left.segment.localeCompare(right.segment) ||
    stableStringify(left.answers).localeCompare(stableStringify(right.answers));
}

export function compareRuns(runs: RunRecord[], stageId: string, questionId: string): RunComparison {
  if (runs.length < 2) throw new Error('compare requires at least two runs');
  const first = runs[0]!;
  const firstQuestion = first.pipeline.stages.find((stage) => stage.id === stageId);
  const firstSummary = first.stages[stageId]?.summaries[questionId];
  if (!firstQuestion || !firstSummary) throw new Error(`run '${first.id}' has no summary for ${stageId}.${questionId}`);
  for (const run of runs.slice(1)) {
    if (run.provider !== first.provider) throw new Error('runs use different providers and are not comparable');
    if (run.model !== first.model) throw new Error('runs use different models and are not comparable');
    if (compatibilityHash(run) !== compatibilityHash(first)) throw new Error('runs use different questions, contexts, or dependency graphs and are not comparable');
    const stage = run.pipeline.stages.find((candidate) => candidate.id === stageId);
    const summary = run.stages[stageId]?.summaries[questionId];
    if (!stage || !summary) throw new Error(`run '${run.id}' has no summary for ${stageId}.${questionId}`);
    if (!compatibleSummaries(firstQuestion, firstSummary, stage, summary, questionId)) {
      throw new Error(`runs have incompatible question criteria at ${stageId}.${questionId}`);
    }
  }
  const resolvedModel = resolvedModels(first, stageId);
  for (const run of runs.slice(1)) {
    if (stableRecord(Object.fromEntries(resolvedModel.map((model) => [model, model]))) !== stableRecord(Object.fromEntries(resolvedModels(run, stageId).map((model) => [model, model])))) {
      throw new Error('runs resolved to different provider models and are not comparable');
    }
  }
  const values = runs.map((run): ComparisonValue => {
    const summary = run.stages[stageId]!.summaries[questionId]!;
    return {
      runId: run.id,
      createdAt: run.createdAt,
      status: run.status,
      ...(summary.winner !== undefined ? { winner: summary.winner } : {}),
      ...(summary.mean !== undefined ? { mean: summary.mean } : {}),
      ...(summary.topProbability !== undefined ? { topProbability: summary.topProbability } : {}),
      ...(summary.margin !== undefined ? { margin: summary.margin } : {}),
      ...(summary.probabilities !== undefined ? { probabilities: summary.probabilities } : {}),
    };
  });
  const base = values[0]!;
  const differenceMetrics: Array<keyof Pick<ComparisonValue, 'mean' | 'topProbability' | 'margin'>> = ['mean', 'topProbability', 'margin'];
  const scalarDifferences: RunComparison['differencesFromBaseline'] = values.slice(1).flatMap((value) => differenceMetrics.flatMap((metric) =>
    value[metric] !== undefined && base[metric] !== undefined
      ? [{ runId: value.runId, metric, difference: value[metric]! - base[metric]! }]
      : [],
  ));
  const probabilityDifferences: RunComparison['differencesFromBaseline'] = values.slice(1).flatMap((value) => Object.keys({ ...base.probabilities, ...value.probabilities }).flatMap((key) =>
    base.probabilities?.[key] !== undefined && value.probabilities?.[key] !== undefined
      ? [{ runId: value.runId, metric: `probability:${key}`, difference: value.probabilities[key]! - base.probabilities[key]! }]
      : [],
  ));
  const differencesFromBaseline = [...scalarDifferences, ...probabilityDifferences];
  const probabilityKeys = [...new Set(values.flatMap((value) => Object.keys(value.probabilities ?? {})))].sort();
  const probabilities = probabilityKeys.length ? Object.fromEntries(probabilityKeys.map((key) => [key,
    values.reduce((sum, value) => sum + (value.probabilities?.[key] ?? 0), 0) / values.length,
  ])) : undefined;
  const probabilitySpread = probabilityKeys.length ? Object.fromEntries(probabilityKeys.map((key) => [key,
    standardDeviation(values.map((value) => value.probabilities?.[key] ?? 0)),
  ])) : undefined;
  const means = values.flatMap((value) => value.mean === undefined ? [] : [value.mean]);
  const scalarAverage = (metric: 'topProbability' | 'margin'): number | undefined => {
    const entries = values.flatMap((value) => value[metric] === undefined ? [] : [value[metric]!]);
    return entries.length ? entries.reduce((sum, value) => sum + value, 0) / entries.length : undefined;
  };
  const notes = [...cohortDifferenceNotes(first, runs.slice(1)), ...sampleDifferenceNotes(first, runs.slice(1), stageId, questionId)];
  return {
    stageId,
    questionId,
    provider: first.provider,
    model: first.model,
    pipelineHash: first.pipelineHash,
    baselineRunId: first.id,
    runs: values,
    differencesFromBaseline,
    averagesAcrossRuns: {
      runCount: values.length,
      ...(means.length ? { mean: means.reduce((sum, value) => sum + value, 0) / means.length, meanSpread: standardDeviation(means) } : {}),
      ...(scalarAverage('topProbability') !== undefined ? { topProbability: scalarAverage('topProbability') } : {}),
      ...(scalarAverage('margin') !== undefined ? { margin: scalarAverage('margin') } : {}),
      ...(probabilities ? { probabilities } : {}),
      ...(probabilitySpread ? { probabilitySpread } : {}),
    },
    notes,
  };
}

function compatibleSummaries(firstStage: RunRecord['pipeline']['stages'][number], firstSummary: QuestionSummary, secondStage: RunRecord['pipeline']['stages'][number], secondSummary: QuestionSummary, questionId: string): boolean {
  if (firstSummary.type !== secondSummary.type) return false;
  const questionFrom = (stage: RunRecord['pipeline']['stages'][number]): Question | undefined => {
    if (stage.kind === 'poll') return stage.questions[questionId];
    return undefined;
  };
  const first = questionFrom(firstStage);
  const second = questionFrom(secondStage);
  if (!first || !second) {
    const firstOptions = Object.keys(firstSummary.probabilities ?? {}).sort();
    const secondOptions = Object.keys(secondSummary.probabilities ?? {}).sort();
    return firstOptions.length === secondOptions.length && firstOptions.every((key, index) => key === secondOptions[index]);
  }
  if (first.type !== second.type) return false;
  if (first.type === 'noul' && second.type === 'noul') return true;
  if (first.type === 'choice' && second.type === 'choice') return stableRecord(first.criteria) === stableRecord(second.criteria);
  return first.type === 'score' && second.type === 'score' && JSON.stringify(first.criteria) === JSON.stringify(second.criteria);
}

function stableRecord(value: Record<string, unknown>): string {
  return stableStringify(value);
}

function compatibilityHash(run: RunRecord): string {
  const pipeline = {
    ...run.pipeline,
    cohorts: Object.fromEntries(Object.keys(run.pipeline.cohorts).sort().map((alias) => [alias, 'cohort-snapshot'])),
    stages: run.pipeline.stages.map((stage) => {
      if (stage.kind !== 'poll') return stage;
      const { size: _size, repeats: _repeats, ...questionAndGraph } = stage;
      return questionAndGraph;
    }),
  };
  return hashValue(pipeline);
}

function resolvedModels(run: RunRecord, stageId: string): string[] {
  const votes = run.stages[stageId]?.votes ?? [];
  const models = [...new Set(votes.map((vote) => vote.model).filter(Boolean))].sort();
  return models.length ? models : [run.model];
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

function cohortDifferenceNotes(first: RunRecord, others: RunRecord[]): string[] {
  const notes: string[] = [];
  for (const run of others) {
    const ids = new Set([...Object.keys(first.cohorts), ...Object.keys(run.cohorts)]);
    for (const id of ids) {
      const baseline = first.cohorts[id];
      const current = run.cohorts[id];
      if (!baseline || !current) {
        notes.push(`Run ${run.id} has a different cohort set (${id}).`);
        continue;
      }
      if (hashValue(baseline) !== hashValue(current)) notes.push(`Run ${run.id} uses a changed cohort snapshot for ${id}.`);
      if (baseline.personas.length !== current.personas.length) {
        notes.push(`Run ${run.id} cohort ${id} has ${current.personas.length} profiles; baseline has ${baseline.personas.length}.`);
      }
      const baselineWeights = new Map(baseline.segments.map((segment) => [segment.id, segment.weight]));
      const currentWeights = new Map(current.segments.map((segment) => [segment.id, segment.weight]));
      for (const segment of new Set([...baselineWeights.keys(), ...currentWeights.keys()])) {
        if (baselineWeights.get(segment) !== currentWeights.get(segment)) {
          notes.push(`Run ${run.id} cohort ${id} segment ${segment} weight differs from baseline (${baselineWeights.get(segment) ?? 'missing'} vs ${currentWeights.get(segment) ?? 'missing'}).`);
        }
      }
    }
  }
  return notes;
}

function sampleDifferenceNotes(first: RunRecord, others: RunRecord[], stageId: string, questionId: string): string[] {
  const firstStage = first.stages[stageId];
  const baseRespondents = firstStage?.summaries[questionId]?.respondentCount;
  const baseRepeats = Math.max(0, ...((firstStage?.votes ?? []).map((vote) => vote.repeat)));
  const notes: string[] = [];
  for (const run of others) {
    const stage = run.stages[stageId];
    const respondents = stage?.summaries[questionId]?.respondentCount;
    const repeats = Math.max(0, ...(stage?.votes ?? []).map((vote) => vote.repeat));
    if (respondents !== undefined && baseRespondents !== undefined && respondents !== baseRespondents) {
      notes.push(`Run ${run.id} summarizes ${respondents} synthetic respondents; baseline summarizes ${baseRespondents}.`);
    }
    if (repeats !== baseRepeats) notes.push(`Run ${run.id} used ${repeats} repeats; baseline used ${baseRepeats}.`);
  }
  return notes;
}

export function simulateVotes(run: RunRecord, stageId: string, questionId: string, draws: number, seed: string): VoteSimulation {
  if (!Number.isInteger(draws) || draws < 1) throw new Error('draws must be a positive integer');
  const result = run.stages[stageId];
  if (!result || result.status !== 'completed') throw new Error(`stage '${stageId}' is not completed`);
  const question = findQuestion(run, stageId, questionId);
  const rows = collapseRepeats(result.votes, questionId);
  if (!rows.length) throw new Error(`stage '${stageId}' has no votes for '${questionId}'`);
  const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
  if (!(totalWeight > 0)) throw new Error('simulation has no positive respondent weight');
  const respondentCount = rows.length;
  const random = seededRandom(`${seed}:${hashValue({ pipeline: run.pipelineHash, stageId, questionId, votes: result.votes })}`);
  const samples: Record<string, number[]> = {};
  const winnerCounts: Record<string, number> = {};
  let tieCount = 0;
  if (question.type === 'choice') {
    for (const key of Object.keys(question.criteria)) { samples[key] = []; winnerCounts[key] = 0; }
  } else if (question.type === 'score') {
    samples.score = [];
  } else {
    samples.yes = [];
  }

  for (let draw = 0; draw < draws; draw += 1) {
    const totals: Record<string, number> = Object.fromEntries(Object.keys(samples).map((key) => [key, 0]));
    for (const row of rows) {
      const answer = row.answer;
      const outcome = drawOutcome(question, answer, random);
      if (question.type === 'choice') totals[outcome] = (totals[outcome] ?? 0) + row.weight / totalWeight;
      else totals[question.type === 'score' ? 'score' : 'yes']! += (question.type === 'score' ? Number(outcome) : Number(outcome)) * row.weight / totalWeight;
    }
    if (question.type === 'choice') {
      const top = Math.max(...Object.values(totals));
      const winners = Object.keys(totals).filter((key) => Math.abs(totals[key]! - top) < 1e-12);
      if (winners.length > 1) tieCount += 1;
      else if (winners[0]) winnerCounts[winners[0]] = (winnerCounts[winners[0]] ?? 0) + 1;
    }
    for (const key of Object.keys(samples)) samples[key]!.push(totals[key] ?? 0);
  }
  return {
    label: 'conditional on model outputs',
    runId: run.id,
    stageId,
    questionId,
    draws,
    seed,
    respondentCount,
    metric: question.type === 'choice' ? 'choice-share' : question.type === 'noul' ? 'yes-probability' : 'score',
    intervals: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, interval(values)])),
    ...(question.type === 'choice' ? { winnerFrequency: Object.fromEntries(Object.entries(winnerCounts).map(([key, count]) => [key, count / draws])), tieCount, tieRate: tieCount / draws } : {}),
    intervalBasis: 'synthetic respondent predictions; conditional on model outputs',
    intervalsArePopulationConfidenceIntervals: false,
  };
}

function findQuestion(run: RunRecord, stageId: string, questionId: string): Question {
  const stage = run.pipeline.stages.find((candidate) => candidate.id === stageId);
  if (stage?.kind === 'poll') {
    const question = stage.questions[questionId];
    if (question) return question;
  }
  const summary = run.stages[stageId]?.summaries[questionId];
  if (!summary) throw new Error(`question '${questionId}' is unavailable at stage '${stageId}'`);
  if (summary.type === 'noul') return { type: 'noul', label: summary.label, instructions: summary.label };
  if (summary.type === 'choice') {
    const options = Object.keys(summary.probabilities ?? {});
    return { type: 'choice', label: summary.label, instructions: summary.label, criteria: Object.fromEntries(options.map((option) => [option, option])) } satisfies ChoiceQuestion;
  }
  const levels = Object.keys(summary.probabilities ?? {}).sort((a, b) => Number(a) - Number(b));
  return { type: 'score', label: summary.label, instructions: summary.label, criteria: levels } satisfies ScoreQuestion;
}

function collapseRepeats(votes: Vote[], questionId: string): Array<{ answer: Answer; weight: number }> {
  const groups = new Map<string, Vote[]>();
  for (const vote of votes) {
    if (!vote.answers[questionId]) continue;
    const groupId = `${vote.cohortId ?? ''}\0${vote.personaId}`;
    const group = groups.get(groupId) ?? [];
    group.push(vote);
    groups.set(groupId, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!.answers[questionId]!;
    const weight = group.reduce((sum, vote) => sum + vote.weight, 0);
    if (first.type === 'noul') {
      const noul = group.reduce((sum, vote) => sum + (vote.answers[questionId] as Extract<Answer, { type: 'noul' }>).noul * vote.weight, 0) / weight;
      return { answer: { type: 'noul', noul } as Answer, weight };
    }
    const probabilities = Object.fromEntries(Object.keys(first.probabilities).map((key) => [key,
      group.reduce((sum, vote) => sum + answerProbability(vote.answers[questionId]!, key) * vote.weight, 0) / weight,
    ]));
    const confidence = group.every(vote => answerConfidence(vote.answers[questionId]!) !== undefined) ? group.reduce((sum, vote) => sum + answerConfidence(vote.answers[questionId]!)! * vote.weight, 0) / weight : undefined;
    if (first.type === 'choice') {
      const optionOrder = Object.keys(first.probabilities);
      const choice = Object.entries(probabilities).sort(([ka, a], [kb, b]) => b - a || optionOrder.indexOf(ka) - optionOrder.indexOf(kb))[0]![0];
      return { answer: { type: 'choice', choice, probabilities, confidence } as Answer, weight };
    }
    const score = group.reduce((sum, vote) => sum + (vote.answers[questionId] as Extract<Answer, { type: 'score' }>).score * vote.weight, 0) / weight;
    const legend = first.legend;
    return { answer: { type: 'score', score, probabilities, confidence, legend } as Answer, weight };
  });
}

function drawOutcome(question: Question, answer: Answer, random: () => number): string {
  if (question.type === 'noul' && answer.type === 'noul') return random() < answer.noul ? '1' : '0';
  if (question.type === 'choice' && answer.type === 'choice') return categorical(answer.probabilities, random);
  if (question.type === 'score' && answer.type === 'score') return categorical(answer.probabilities, random);
  throw new Error('vote answer type does not match its question');
}

function categorical(probabilities: Record<string, number>, random: () => number): string {
  const target = random();
  let cumulative = 0;
  for (const [key, probability] of Object.entries(probabilities)) {
    cumulative += probability;
    if (target < cumulative) return key;
  }
  return Object.keys(probabilities).at(-1) ?? '';
}

function interval(values: number[]): SimulationInterval {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const quantile = (probability: number): number => sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)] ?? 0;
  return { mean, lower: quantile(0.025), upper: quantile(0.975) };
}

function answerAsNoul(answer: Answer): number { return answer.type === 'noul' ? answer.noul : 0; }
function answerProbability(answer: Answer, key: string): number { return answer.type === 'noul' ? 0 : answer.probabilities[key] ?? 0; }
function answerConfidence(answer: Answer): number | undefined { return answer.type === 'noul' ? undefined : answer.confidence; }
