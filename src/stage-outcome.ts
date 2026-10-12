import { resolveQuestion } from './engine-utils.js';
import type { Pipeline, Question, StageResult } from './types.js';

/** What a step with no audience settled on, for views that otherwise show one tile per member evaluation. */
export interface StageOutcome {
  answers: { id: string; label: string; type: Question['type']; winner?: string; mean?: number; likelihood?: number; options: { key: string; label: string; share: number }[] }[];
  /** What the step read, in plain words. */
  reads: string[];
  /** How a Final answer read large inputs, when it split them. */
  note?: string;
}

const SELECT_TEXT: Record<string, string> = { summary: 'summary', responses: 'every answer', winner: 'leading option', mean: 'mean score', probabilities: 'distribution' };

function optionLabel(question: Question | undefined, key: string): string {
  if (question?.type !== 'choice') return question?.type === 'score' ? `Level ${key}` : key;
  const meaning = question.criteria[key];
  if (meaning && typeof meaning === 'object') return meaning.label || key;
  return typeof meaning === 'string' && meaning.trim() && meaning.trim().length <= 48 ? meaning.trim() : key;
}

export function stageOutcome(pipeline: Pipeline, result: StageResult | undefined, results: Record<string, StageResult> = {}): StageOutcome | undefined {
  const stage = pipeline.stages.find((item) => item.id === result?.id);
  if (!stage || !result || stage.kind === 'poll' || result.status !== 'completed') return undefined;
  const sourceText = (stageId: string, questionId: string, select?: string): string => {
    const source = pipeline.stages.find((item) => item.id === stageId);
    const question = resolveQuestion(pipeline.stages, stageId, questionId);
    const name = [source?.label || stageId, question?.label].filter(Boolean).join(' · ');
    return select ? `${name} (${SELECT_TEXT[select] ?? select})` : name;
  };
  const reads = stage.kind === 'choose' ? Object.values(stage.inputs).map((input) => sourceText(input.stage, input.question, input.select ?? 'summary') + (results[input.stage] && results[input.stage]!.status !== 'completed' ? ', skipped so not read' : ''))
    : stage.kind === 'decision' ? [sourceText(stage.from.stage, stage.from.question)]
    : stage.inputs.map((input) => sourceText(input.stage, input.question));
  const answers = Object.entries(result.summaries).map(([id, summary]) => {
    const question = resolveQuestion(pipeline.stages, stage.id, id);
    const options = Object.entries(summary.probabilities ?? {}).map(([key, share]) => ({ key, label: optionLabel(question, key), share })).sort((a, b) => b.share - a.share);
    return {
      id, label: question?.label || summary.label || id, type: summary.type, options,
      ...(summary.winner !== undefined ? { winner: optionLabel(question, summary.winner) } : {}),
      ...(summary.type === 'score' && summary.mean !== undefined ? { mean: summary.mean } : {}),
      ...(summary.type === 'noul' && summary.mean !== undefined ? { likelihood: summary.mean } : {}),
    };
  });
  return { answers, reads, ...(result.batching?.note ? { note: result.batching.note } : {}) };
}
