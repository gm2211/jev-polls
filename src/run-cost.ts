import { JEV_USD_PER_MILLION_TOKENS } from './request-budget.js';
import type { RunRecord, Usage } from './types.js';

/** Who pays for a run: TypeSafe bills tokens; demo (mock) and GLiNER runs bill nothing. */
export type RunBilling = 'typesafe' | 'demo' | 'local';
export interface CostLine { requests: number; reused: number; inputTokens: number; outputTokens: number; usd: number }
export interface StepCost extends CostLine { id: string; label: string; status: string }
export interface RunCost {
  billing: RunBilling;
  usdPerMillionTokens: number;
  total: CostLine;
  /** Per-step spend; absent for runs saved before steps recorded their own usage. */
  steps?: StepCost[];
}

/** Dollars for tokens a run actually spent, at the observed blended Jev rate. */
export function usdForTokens(inputTokens: number, outputTokens: number): number {
  return ((inputTokens + outputTokens) / 1_000_000) * JEV_USD_PER_MILLION_TOKENS;
}

export function billingOf(provider: RunRecord['provider']): RunBilling {
  return provider === 'mock' ? 'demo' : provider === 'gliner' ? 'local' : 'typesafe';
}

function line(usage: Pick<Usage, 'inputTokens' | 'outputTokens' | 'requests' | 'cacheHits'>, billing: RunBilling): CostLine {
  return { requests: usage.requests, reused: usage.cacheHits, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usd: billing === 'typesafe' ? usdForTokens(usage.inputTokens, usage.outputTokens) : 0 };
}

/** What a finished run cost, in total and per step in run order. Saved answers reused from cache cost nothing. */
export function runCost(run: RunRecord): RunCost {
  const billing = billingOf(run.provider);
  const recorded = Object.values(run.stages).some((stage) => stage.usage);
  const empty = { inputTokens: 0, outputTokens: 0, requests: 0, cacheHits: 0 };
  return {
    billing,
    usdPerMillionTokens: JEV_USD_PER_MILLION_TOKENS,
    total: line(run.usage, billing),
    ...(recorded || !run.usage.requests && !run.usage.cacheHits ? { steps: run.pipeline.stages.map((stage) => {
      const result = run.stages[stage.id];
      return { id: stage.id, label: stage.label, status: result?.status ?? 'unknown', ...line(result?.usage ?? empty, billing) };
    }) } : {}),
  };
}
