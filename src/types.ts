export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Source { id: string; title: string; url: string; retrievedAt: string; notes: string }
export interface Segment { id: string; label: string; description: string; weight: number; weightBasis: 'sourced' | 'assumed' | 'user'; sourceIds: string[] }
export interface Persona { id: string; label: string; segment: string; age: number; background: string; attributes: Record<string, Json>; sourceIds: string[]; syntheticFields: string[]; weight: number }
export interface DistributionTargetBucket { label: string; percent: number; value?: string | number | boolean | null; min?: number; max?: number }
export interface DistributionTarget { field: string; kind: 'numeric' | 'categorical'; buckets: DistributionTargetBucket[] }
export interface Cohort { version: 1; id: string; name: string; description: string; population: string; createdAt: string; sources: Source[]; segments: Segment[]; personas: Persona[]; assumptions: string[]; generationPrompt?: string; distributionTargets?: DistributionTarget[] }
export type ChoiceCriterion = string | null | { label: string; description: string };
export interface ChoiceQuestion { type: 'choice'; label: string; instructions: string; criteria: Record<string, ChoiceCriterion> }
export interface NoulQuestion { type: 'noul'; label: string; instructions: string }
export interface ScoreQuestion { type: 'score'; label: string; instructions: string; criteria: string[] }
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | { stage: string; question: string; metric: 'margin' | 'topProbability' | 'mean' | 'winner'; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; value: number | string };
export interface BaseStage { id: string; label: string; dependsOn: string[]; join?: 'all' | 'any'; when?: Condition }
export type PollInputSelect = 'summary' | 'winner' | 'mean' | 'probabilities' | 'responses';
export interface PollInputBinding { stage: string; question: string; select?: PollInputSelect }
export interface PollStage extends BaseStage { kind: 'poll'; cohort: string; questions: Record<string, Question>; size?: number; repeats?: number; context?: Json; inputs?: Record<string, PollInputBinding> }
export interface AggregateStage extends BaseStage { kind: 'aggregate'; inputs: { stage: string; question: string; weight: number }[]; outputQuestion: string }
export interface DecisionStage extends BaseStage { kind: 'decision'; from: { stage: string; question: string }; outputQuestion: string }
export type Stage = PollStage | AggregateStage | DecisionStage;
export interface Pipeline { version: 1; id: string; name: string; description: string; context: Json; cohorts: Record<string, string>; stages: Stage[] }
/** Native independent sigmoid scores retained before relative normalization. These are not calibrated probabilities. */
export interface LabelScoreEvidence { semantics: 'independent_sigmoid'; rawScores: Record<string, number>; rawLogits: Record<string, number> }
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence?: number; classifier?: LabelScoreEvidence }
export interface ScoreAnswer { type: 'score'; score: number; probabilities: Record<string, number>; confidence?: number; legend: Record<string, string>; classifier?: LabelScoreEvidence }
export interface NoulAnswer { type: 'noul'; noul: number; classifier?: LabelScoreEvidence }
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface Usage { inputTokens: number; outputTokens: number; requests: number; cacheHits: number; tokenUsage?: 'unreported'; measuredInputTokens?: number }
export interface EvaluationRequest { model: string; state: Json; questions: Record<string, Question>; seed: string }
export interface Evaluation { answers: Record<string, Answer>; model: string; usage: { inputTokens: number; outputTokens: number; tokenUsage?: 'unreported'; measuredInputTokens?: number } }
export interface Provider { name: 'typesafe' | 'mock' | 'gliner'; cacheIdentity?: string; evaluate(request: EvaluationRequest): Promise<Evaluation>; close?(): Promise<void> }
export interface Vote { personaId: string; cohortId?: string; segment: string; repeat: number; weight: number; answers: Record<string, Answer>; cacheHit: boolean; model: string }
export interface SummaryBase { type: Question['type']; label: string; probabilities?: Record<string, number>; mean?: number; winner?: string; margin?: number; topProbability?: number; meanConfidence?: number; respondentCount: number; totalWeight: number }
export interface QuestionSummary extends SummaryBase { bySegment: Record<string, SummaryBase>; byRepeat: Record<string, SummaryBase> }
export interface StageResult { id: string; kind: Stage['kind']; label: string; status: 'completed' | 'skipped' | 'failed'; reason?: string; dependsOn: string[]; votes: Vote[]; summaries: Record<string, QuestionSummary>; startedAt: string; finishedAt: string }
export interface RunRecord { version: 1; id: string; createdAt: string; finishedAt: string; pipeline: Pipeline; pipelineHash: string; provider: Provider['name']; model: string; seed: string; status: 'completed' | 'failed'; cohorts: Record<string, Cohort>; stages: Record<string, StageResult>; warnings: string[]; usage: Usage }
export interface RunOptions { provider: Provider; model: string; seed: string; concurrency: number; cacheDir?: string; refresh?: boolean; size?: number; repeats?: number; maxRequests?: number; onProgress?: (event: { stage: string; completed: number; total: number }) => void }
