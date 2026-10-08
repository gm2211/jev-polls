import type { AuthStatus } from './auth.js';
import type { Cohort, Pipeline, Usage } from './types.js';

/** Editable drafts use the same shape as runnable artifacts; validation happens at review. */
export interface WorkspaceProject { id: string; name: string; description: string; cohortIds: string[]; pipelineIds: string[] }
export interface WorkspaceDocument { version: 1; cohorts: Cohort[]; pipelines: Pipeline[]; projects?: WorkspaceProject[] }
export interface WorkspaceSaved { revision: number; document: WorkspaceDocument }
export interface WorkspaceRun {
  id: string; projectId: string; pipelineId: string; pipelineName: string; status: 'running' | 'completed' | 'failed';
  provider?: 'typesafe' | 'gliner';
  createdAt: string; message: string; progress?: { stage: string; completed: number; total: number };
  liveMembers?: { stage: string; personaId: string; label: string; segment: string; age: number; repeat: number; status: 'queued' | 'running' | 'completed' | 'failed'; answers?: Record<string, unknown>; model?: string; cacheHit?: boolean; reason?: string }[];
  usage?: Usage; reportUrl?: string;
}
export interface WorkspaceSnapshot extends WorkspaceSaved { auth: AuthStatus; gliner?: { ready: boolean; model: string; message?: string }; runs: WorkspaceRun[]; activeRun: WorkspaceRun | null }
export interface WorkspacePlan {
  pipelineId: string; projectId?: string; revision: number; planToken: string; model: string; maxRequests: number; warnings: string[];
  provider?: 'typesafe' | 'gliner';
  stages: { id: string; label: string; kind: string; dependsOn: string[]; cohort?: string; profiles?: number; repeats?: number; requests: number }[];
}
