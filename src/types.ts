export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export interface Source { id: string; title: string; url: string; retrievedAt: string; notes: string }
export interface Segment { id: string; label: string; description: string; weight: number; weightBasis: 'sourced' | 'assumed' | 'user'; sourceIds: string[] }
export interface Persona { id: string; label: string; segment: string; age: number; background: string; attributes: Record<string, Json>; sourceIds: string[]; syntheticFields: string[]; weight: number }
export interface Cohort { version: 1; id: string; name: string; description: string; population: string; createdAt: string; sources: Source[]; segments: Segment[]; personas: Persona[]; assumptions: string[] }
export interface ChoiceQuestion { type: 'choice'; label: string; instructions: string; criteria: Record<string, string | null> }
export interface NoulQuestion { type: 'noul'; label: string; instructions: string }
export interface ScoreQuestion { type: 'score'; label: string; instructions: string; criteria: string[] }
export type Question = ChoiceQuestion | NoulQuestion | ScoreQuestion;
export type Condition = { all: Condition[] } | { any: Condition[] } | { not: Condition } | { stage: string; question: string; metric: 'margin' | 'topProbability' | 'mean' | 'winner'; op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne'; value: number | string };
export interface BaseStage { id: string; label: string; dependsOn: string[]; join?: 'all' | 'any'; when?: Condition }
export interface PollStage extends BaseStage { kind: 'poll'; cohort: string; questions: Record<string, Question>; size?: number; repeats?: number; context?: Json }
export interface AggregateStage extends BaseStage { kind: 'aggregate'; inputs: { stage: string; question: string; weight: number }[]; outputQuestion: string }
export interface DecisionStage extends BaseStage { kind: 'decision'; from: { stage: string; question: string }; outputQuestion: string }
export type Stage = PollStage | AggregateStage | DecisionStage;
export interface Pipeline { version: 1; id: string; name: string; description: string; context: Json; cohorts: Record<string, string>; stages: Stage[] }
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface ScoreAnswer { type: 'score'; score: number; probabilities: Record<string, number>; confidence: number; legend: Record<string, string> }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;
export interface Usage { inputTokens: number; outputTokens: number; requests: number; cacheHits: number }
export interface EvaluationRequest { model: string; state: Json; questions: Record<string, Question>; seed: string }
export interface Evaluation { answers: Record<string, Answer>; model: string; usage: { inputTokens: number; outputTokens: number } }
export interface Provider { name: 'typesafe' | 'mock'; evaluate(request: EvaluationRequest): Promise<Evaluation> }
export interface Vote { personaId: string; cohortId?: string; segment: string; repeat: number; weight: number; answers: Record<string, Answer>; cacheHit: boolean; model: string }
export interface SummaryBase { type: Question['type']; label: string; probabilities?: Record<string, number>; mean?: number; winner?: string; margin?: number; topProbability?: number; meanConfidence?: number; respondentCount: number; totalWeight: number }
export interface QuestionSummary extends SummaryBase { bySegment: Record<string, SummaryBase>; byRepeat: Record<string, SummaryBase> }
export interface StageResult { id: string; kind: Stage['kind']; label: string; status: 'completed' | 'skipped' | 'failed'; reason?: string; dependsOn: string[]; votes: Vote[]; summaries: Record<string, QuestionSummary>; startedAt: string; finishedAt: string }
export interface RunRecord { version: 1; id: string; createdAt: string; finishedAt: string; pipeline: Pipeline; pipelineHash: string; provider: Provider['name']; model: string; seed: string; status: 'completed' | 'failed'; cohorts: Record<string, Cohort>; stages: Record<string, StageResult>; warnings: string[]; usage: Usage }
export interface RunOptions { provider: Provider; model: string; seed: string; concurrency: number; cacheDir?: string; refresh?: boolean; size?: number; repeats?: number; maxRequests?: number; onProgress?: (event: { stage: string; completed: number; total: number }) => void }
