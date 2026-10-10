import type { AuthStatus } from './auth.js';
import type { Cohort, Pipeline, Usage } from './types.js';
import type { BatchPlan, StageBudget } from './request-budget.js';

/** Editable drafts use the same shape as runnable artifacts; validation happens at review. */
export interface WorkspaceProject { id: string; name: string; description: string; cohortIds: string[]; pipelineIds: string[] }
export interface WorkspaceDocument { version: 1; cohorts: Cohort[]; pipelines: Pipeline[]; projects?: WorkspaceProject[] }
export interface WorkspaceSaved { revision: number; document: WorkspaceDocument }
export interface WorkspaceRun {
  id: string; projectId: string; pipelineId: string; pipelineName: string; status: 'running' | 'completed' | 'failed';
  provider?: 'typesafe' | 'gliner';
  stages?: { id: string; label: string; kind: 'poll' | 'aggregate' | 'decision'; dependsOn: string[]; status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'; reason?: string; /** Present when a step reads earlier responses in batches: its members finish batches, then combine rounds. */ batching?: { batches: number; reduceRounds: number; layers: number } }[];
  createdAt: string; message: string; progress?: { stage: string; completed: number; total: number };
  liveMembers?: { stage: string; personaId: string; label: string; segment: string; age: number; repeat: number; weight?: number; order?: number; batch?: { phase: 'map' | 'combine'; done: number; total: number }; status: 'queued' | 'running' | 'completed' | 'failed'; answers?: Record<string, unknown>; model?: string; cacheHit?: boolean; reason?: string }[];
  usage?: Usage; reportUrl?: string;
  /** Only on a live poll: the change counter to ask `?since=` with next. `liveDelta` marks a partial members list. */
  liveVersion?: number; liveTotal?: number; liveDelta?: boolean;
}
export interface WorkspaceSnapshot extends WorkspaceSaved { auth: AuthStatus; gliner?: { ready: boolean; model: string; message?: string }; runs: WorkspaceRun[]; activeRun: WorkspaceRun | null }
export interface WorkspacePlan {
  pipelineId: string; projectId?: string; revision: number; planToken: string; model: string; maxRequests: number; warnings: string[];
  provider?: 'typesafe' | 'gliner';
  stages: { id: string; label: string; kind: string; dependsOn: string[]; cohort?: string; profiles?: number; repeats?: number; requests: number; budget?: StageBudget; batching?: BatchPlan }[];
}
