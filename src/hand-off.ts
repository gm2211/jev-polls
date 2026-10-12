import type { Cohort, Pipeline, PollStage } from './types.js';
import { estimateStageBudget, sourceAnswerCount } from './request-budget.js';

/** An input the plan split into batches automatically because every answer would not fit in one Jev request. */
export interface HandOff {
  stage: string;
  /** The input name the step reads it as. */
  alias: string;
  from: string;
  /** Answers the earlier step produces. */
  answers: number;
  /** Requests the reading step makes per run, before splitting (respondents times repeats). */
  readers: number;
}

function readers(stage: PollStage, cohorts: Record<string, Cohort>): number {
  const cohort = cohorts[stage.cohort];
  if (!cohort) return 0;
  const positive = new Set(cohort.segments.filter((segment) => segment.weight > 0).map((segment) => segment.id));
  return (stage.size ?? cohort.personas.filter((persona) => positive.has(persona.segment)).length) * (stage.repeats ?? 1);
}

/**
 * When a step reads every individual answer of an earlier step and those answers would not fit in one Jev request
 * (e.g. 8 board members reading 1,000 gamers' answers), splits the largest such input into batches and combines the
 * verdicts (map-reduce), as if it had `batch: 'auto'`, instead of blocking the plan. Inputs that fit, inputs already
 * batched and summaries are unchanged. Plan and run both call it, so the reviewed requests are the ones sent, and the
 * run record shows the binding actually used. Idempotent.
 */
export function resolveHandOffs(pipeline: Pipeline, cohorts: Record<string, Cohort>): { pipeline: Pipeline; handOffs: HandOff[] } {
  const handOffs: HandOff[] = [];
  const stages = pipeline.stages.map((stage) => {
    if (stage.kind !== 'poll' || !stage.inputs) return stage;
    const bindings = Object.entries(stage.inputs);
    if (bindings.some(([, binding]) => binding.batch !== undefined)) return stage;
    const candidates = bindings.filter(([, binding]) => binding.select === 'responses');
    if (!candidates.length || estimateStageBudget(pipeline, cohorts, stage)?.status !== 'blocked') return stage;
    const [alias, binding] = candidates
      .map(([name, item]) => [name, item, sourceAnswerCount(pipeline, cohorts, item.stage)] as const)
      .sort((a, b) => b[2] - a[2])[0]!;
    handOffs.push({ stage: stage.id, alias, from: binding.stage, answers: sourceAnswerCount(pipeline, cohorts, binding.stage), readers: readers(stage, cohorts) });
    return { ...stage, inputs: { ...stage.inputs, [alias]: { ...binding, batch: 'auto' as const } } };
  });
  return { pipeline: handOffs.length ? { ...pipeline, stages } : pipeline, handOffs };
}
