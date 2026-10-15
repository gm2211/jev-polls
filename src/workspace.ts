import { hostedOrigin, hostedPasswordMatches, type HostedOptions } from './hosting.js';
import { MAX_COHORT_PERSONAS, MAX_WORKSPACE_BYTES } from './limits.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { authStatus, setApiKey } from './auth.js';
import { verifyTypeSafeConnection } from './auth-check.js';
import { createProvider, ProviderError } from './provider.js';
import { GLINER_CACHE_IDENTITY, GLINER_MODEL, glinerStatus } from './gliner-provider.js';
import { predictReuse, runPipeline } from './engine.js';
import { costOf } from './request-budget.js';
import { renderReport } from './report.js';
import { loadRun } from './run-record.js';
import { stageOutcome, type StageOutcome } from './stage-outcome.js';
import { writeJson, writeText } from './io.js';
import { WorkspaceStore, workspacePlan, WorkspaceConflictError, validateWorkspaceDocument } from './workspace-store.js';
import { renderWorkspace } from './workspace-ui.js';
import { agentConnectionConfig } from './agent-config.js';
import { buildCommandTargets, cohortInputSchema, materialNameSchema, materialSchema, optionDraftInputSchema, LocalAgentError, LocalAgentService, LOCAL_AGENT_ENGINES } from './local-agent.js';
import { ByosConnectionError, ByosConnections, isByosEngine } from './byos-connections.js';
import { ChatGptConnection, chatGptMessage, createDraftClient, type ChatGptDraftClient } from './chatgpt.js';
import type { Pipeline, Provider } from './types.js';
import type { AuthStatus } from './auth.js';
import type { WorkspaceDocument, WorkspaceRun, WorkspacePlan } from './workspace-types.js';

const MODEL = 'jev-1.13.0';
const WORKSPACE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeId = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(160);
const evaluationProvider = z.enum(['typesafe', 'gliner']);
const runInput = z.object({ pipelineId: safeId, projectId: safeId.optional(), provider: evaluationProvider.default('typesafe'), revision: z.number().int().nonnegative(), planToken: z.string(), seed: z.string().min(1).max(200).optional(), refresh: z.boolean().optional(), concurrency: z.number().int().min(1).max(16), maxRequests: z.number().int().min(1).max(100_000) }).strict();
const savedJobSchema = z.object({
  id: z.string().regex(WORKSPACE_RUN_ID), projectId: safeId, pipelineId: safeId, pipelineName: z.string().max(100_000),
  status: z.enum(['running', 'completed', 'failed']), createdAt: z.string().max(100), message: z.string().max(100_000),
  provider: evaluationProvider.optional(),
  seed: z.string().min(1).max(200).optional(),
  stages: z.array(z.object({ id: safeId, label: z.string().max(100_000), kind: z.enum(['poll', 'aggregate', 'decision', 'choose']), dependsOn: z.array(safeId), status: z.enum(['pending', 'running', 'completed', 'skipped', 'failed']), reason: z.string().max(100_000).optional(), batching: z.object({ batches: z.number().int().positive(), reduceRounds: z.number().int().positive(), layers: z.number().int().nonnegative() }).strict().optional(), outcome: z.custom<StageOutcome>((value) => typeof value === 'object' && value !== null).optional() }).strict()).optional(),
  progress: z.object({ stage: safeId, completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
  liveMembers: z.array(z.object({ stage: safeId, personaId: safeId, label: z.string().max(100_000), segment: safeId, age: z.number().finite(), repeat: z.number().int().positive(), weight: z.number().finite().nonnegative().optional(), order: z.number().int().nonnegative().optional(), batch: z.object({ phase: z.enum(['map','combine']), done: z.number().int().nonnegative(), total: z.number().int().positive() }).strict().optional(), status: z.enum(['queued','running','completed','failed']), answers: z.record(z.string(), z.unknown()).optional(), model: z.string().optional(), cacheHit: z.boolean().optional(), reason: z.string().max(100_000).optional() }).strict()).optional(),
  usage: z.object({ inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(), requests: z.number().int().nonnegative(), cacheHits: z.number().int().nonnegative(), tokenUsage: z.literal('unreported').optional(), measuredInputTokens: z.number().int().nonnegative().optional() }).strict().optional(),
  reportUrl: z.string().regex(/^\/reports\/[0-9a-f-]{36}$/).optional(),
}).strict();
function initialRunStages(pipeline: Pipeline): NonNullable<WorkspaceRun['stages']> {
  return pipeline.stages.map(stage => ({ id: stage.id, label: stage.label, kind: stage.kind, dependsOn: [...stage.dependsOn], status: 'pending' }));
}
function recordedRunStages(pipeline: Pipeline, record: Awaited<ReturnType<typeof loadRun>>): NonNullable<WorkspaceRun['stages']> {
  return pipeline.stages.map(stage => {
    const result = record.stages[stage.id], outcome = stageOutcome(record.pipeline, result, record.stages);
    return { id: stage.id, label: stage.label, kind: stage.kind, dependsOn: [...stage.dependsOn], status: result?.status ?? 'failed', ...(result?.reason ? { reason: result.reason } : {}), ...(result?.batching && result.batching.batches > 1 ? { batching: { batches: result.batching.batches, reduceRounds: result.batching.reduceRounds, layers: result.layers?.length ?? 0 } } : {}), ...(outcome ? { outcome } : {}) };
  });
}
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function validationMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join('.') || 'Study'}: ${issue.message}`).join('\n').slice(0, 3000);
  return error instanceof Error ? error.message.slice(0, 3000) : 'Check study fields and references.';
}

export interface WorkspaceServerOptions {
  directory: string;
  chatgpt?: ChatGptDraftClient;
  /** BYOS API-key drafting providers; defaults to keys in the macOS Keychain. */
  byos?: ByosConnections;
  port?: number;
  getAuthStatus?: () => Promise<AuthStatus>;
  connectAccount?: (key: string) => Promise<unknown>;
  providerFactory?: (name: 'typesafe' | 'gliner') => Provider;
  /** Demo mode: every run uses locally generated mock answers, so recording or rehearsing a demo sends nothing to TypeSafe and bills nothing. */
  demo?: boolean;
  getGlinerStatus?: () => Promise<{ ready: boolean; model: string; message?: string }>;
  emit?: (event: Record<string, unknown>) => void;
  localAgents?: Pick<LocalAgentService, 'availability' | 'start' | 'get' | 'cancel' | 'close'> & Partial<Pick<LocalAgentService, 'list' | 'settle' | 'disposition' | 'members'>>;
  /** Serve on a public URL behind a shared password instead of loopback only. */
  hosted?: HostedOptions;
}

/** Account connection and review are separate from explicit study execution. */
export async function startWorkspaceServer(options: WorkspaceServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const directory = resolve(options.directory);
  const store = new WorkspaceStore(directory);
  const chatgpt = new ChatGptConnection(options.chatgpt ?? createDraftClient());
  const byos = options.byos ?? new ByosConnections();
  const localAgents = options.localAgents ?? new LocalAgentService({ chatgpt: chatgpt.client, byos, checkpointDirectory: join(directory, 'drafts'), log: line => { try { process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`); } catch { /* A closed stderr never affects drafting. */ } } });
  let activeDraftId: string | undefined;
  let changingChatGpt = false;
  const csrf = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  const getAuth = options.getAuthStatus ?? authStatus;
  const getGliner = options.getGlinerStatus ?? glinerStatus;
  const connectAccount = options.connectAccount ?? (async (key: string) => { const result = await verifyTypeSafeConnection(key); await setApiKey(key); return result; });
  const jobs = new Map<string, WorkspaceRun>();
  const runRecords = new Map<string, string>();
  /** Per live run: a change counter and the counter value at each member's last event, so polls can ask only for what changed. */
  const liveChanges = new WeakMap<WorkspaceRun, { version: number; versions: number[]; finished: number }>();
  const plans = new Map<string, { pipelineId: string; revision: number; provider: 'typesafe' | 'gliner'; expires: number }>();
  let activeRun: WorkspaceRun | null = null;
  let activeProvider: Provider | undefined;
  let execution: Promise<void> | undefined;
  let closing = false;
  let authenticating = false;
  let origin = '';
  let expectedHost = '';
  let closePromise: Promise<void> | undefined;
  let mutationTail = Promise.resolve();

  function withWorkspaceMutation<T>(action: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(action);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }
  function saveWorkspace(document: unknown, revision: number) {
    return withWorkspaceMutation(async () => {
      const validated = validateWorkspaceDocument(document);
      if (activeRun && !validated.projects?.some(project => project.id === activeRun!.projectId)) {
        throw new HttpError(409, 'PROJECT_RUN_IN_PROGRESS', 'Wait for the active study to finish before deleting its project.');
      }
      const activeDraft = activeDraftId ? localAgents.get(activeDraftId) : undefined;
      if (activeDraft?.status === 'running' && activeDraft.projectId && !validated.projects?.some(project => project.id === activeDraft.projectId)) {
        throw new HttpError(409, 'PROJECT_DRAFT_IN_PROGRESS', 'Cancel the active draft before deleting its project.');
      }
      const saved = await store.save(validated, revision);
      plans.clear();
      return saved;
    });
  }

  const initialDocument = (await store.read()).document;
  const existingProjects = new Set(initialDocument.projects?.map(project => project.id));
  async function discoverRuns(parent: string) {
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.filter(e => e.isDirectory()).slice(-200)) {
      if (!WORKSPACE_RUN_ID.test(entry.name)) continue;
      const id = entry.name;
      const path = join(parent, entry.name);
      try {
        const record = await loadRun(join(path, 'run.json'));
        if (record.provider === 'mock' && !options.demo) continue;
        const message = record.status === 'completed' ? 'Study complete.' : 'Study ended with failures. Inspect the report before interpreting results.';
        let persistedProgress: WorkspaceRun['progress'];
        let persistedMembers: WorkspaceRun['liveMembers'];
        let persistedProjectId: string | undefined;
        try {
          const parsed = savedJobSchema.parse(JSON.parse(await readFile(join(path, 'job.json'), 'utf8')));
          if (parsed.id === id && parsed.pipelineId === record.pipeline.id && parsed.status === record.status) {
            persistedProgress = parsed.progress; persistedMembers = parsed.liveMembers; persistedProjectId = parsed.projectId;
          }
        } catch { /* A persisted launch record can recover missing completion metadata. */ }
        if (!persistedProjectId) {
          try {
            const pending = savedJobSchema.parse(JSON.parse(await readFile(join(path, 'pending.json'), 'utf8')));
            if (pending.id === id && pending.pipelineId === record.pipeline.id && pending.status === 'running') persistedProjectId = pending.projectId;
          } catch { /* Ownerless artifacts are not workspace runs. */ }
        }
        if (!persistedProjectId || !existingProjects.has(persistedProjectId)) continue;
        const summary: WorkspaceRun = { provider: record.provider === 'mock' ? 'typesafe' : record.provider, seed: record.seed, projectId: persistedProjectId, id, pipelineId: record.pipeline.id, pipelineName: record.pipeline.name, status: record.status, createdAt: record.createdAt, message, usage: record.usage, reportUrl: `/reports/${id}`, stages: recordedRunStages(record.pipeline, record), ...(persistedProgress ? { progress: persistedProgress } : {}), ...(persistedMembers ? { liveMembers: persistedMembers } : {}) };

        jobs.set(summary.id, summary); runRecords.set(summary.id, join(path, 'run.json'));
      } catch {
        try {
          const pending = savedJobSchema.parse(JSON.parse(await readFile(join(path, 'pending.json'), 'utf8')));
          if (pending.id !== id || pending.status !== 'running' || !existingProjects.has(pending.projectId)) continue;
          jobs.set(id, { ...pending, status: 'failed', message: 'Server stopped before this run finished. Review and run again to reuse completed cached responses.', reportUrl: undefined, stages: pending.stages?.map(stage => stage.status === 'running' ? { ...stage, status: 'failed', reason: 'server stopped before the stage completed' } : stage) });
        } catch { /* An incomplete/corrupt artifact is not presented as a completed run. */ }
      }
    }
  }
  await discoverRuns(join(directory, 'runs'));

  function ownedRuns(document: WorkspaceDocument): WorkspaceRun[] {
    const projectIds = new Set(document.projects?.map(project => project.id));
    return [...jobs.values()].filter(job => projectIds.has(job.projectId));
  }
  async function ownedRun(id: string): Promise<WorkspaceRun> {
    const job = ownedRuns((await store.read()).document).find(item => item.id === id);
    if (!job) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run was not found in an existing project.');
    return job;
  }
  /** A study keeps one seed across runs, so a run after a small edit samples the same personas and reuses every unchanged answer. */
  function studySeed(document: WorkspaceDocument, pipelineId: string): string {
    const latest = ownedRuns(document).filter(job => job.pipelineId === pipelineId && job.seed).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest?.seed ?? pipelineId;
  }
  async function savedRunRecord(job: WorkspaceRun) {
    const path = runRecords.get(job.id);
    if (!path) throw new HttpError(409, 'RUN_NOT_READY', 'A saved run record is not available yet.');
    try {
      const record = await loadRun(path);
      if (record.pipeline.id !== job.pipelineId || (record.provider === 'mock' ? !options.demo : job.provider && record.provider !== job.provider)) throw Error();
      return record;
    } catch { throw new HttpError(404, 'RUN_RECORD_UNAVAILABLE', 'The saved run record is missing or invalid. Run the study again to create a report.'); }
  }

  function headers(response: ServerResponse, report = false) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', report
      ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      : `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src data:; font-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  }
  function send(response: ServerResponse, status: number, value: unknown, html = false, report = false) {
    headers(response, report);
    response.writeHead(status, { 'Content-Type': html ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' });
    response.end(html ? value as string : JSON.stringify(value));
  }
  async function body(request: IncomingMessage, limit = 5 * 1024 * 1024): Promise<unknown> {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'JSON_REQUIRED', 'Send a JSON request.');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
      const data = Buffer.from(chunk); bytes += data.length;
      if (bytes > limit) throw new HttpError(413, 'TOO_LARGE', 'This workspace is too large to save.');
      chunks.push(data);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new HttpError(400, 'INVALID_JSON', 'Could not read JSON. Check the imported file.'); }
  }
  async function execute(job: WorkspaceRun, project: ReturnType<typeof workspacePlan>, input: z.infer<typeof runInput>) {
    const runDirectory = join(directory, 'runs', job.id);
    let provider: Provider | undefined;
    const liveMemberIndexes = new Map<string, number>();
    try {
      await writeJson(join(runDirectory, 'pending.json'), job);
      if (closing) throw new Error('Workspace is closing');
      provider = options.demo ? createProvider('mock') : (options.providerFactory ?? createProvider)(input.provider);
      activeProvider = provider;
      const record = await runPipeline(project.pipeline, project.cohorts, {
        provider, model: input.provider === 'gliner' ? GLINER_MODEL : MODEL,
        seed: job.seed!, refresh: input.refresh, concurrency: input.concurrency, maxRequests: input.maxRequests,
        cacheDir: join(directory, 'cache'),
        onProgress: event => { job.progress = event; job.message = `${event.stage}: ${event.completed} of ${event.total} evaluations processed`; options.emit?.({ event: 'progress', runId: job.id, ...event }); },
        onStageProgress: event => {
          const stage = job.stages?.find(item => item.id === event.stage);
          if (stage) {
            stage.status = event.status;
            if (event.reason) stage.reason = event.reason;
            else delete stage.reason;
          }
        },
        onMemberProgress: event => {
          const members = job.liveMembers ??= [];
          const changes = liveChanges.get(job) ?? { version: 0, versions: [], finished: 0 };
          liveChanges.set(job, changes);
          const key = `${event.stage}:${event.personaId}:${event.repeat}`;
          let index = liveMemberIndexes.get(key);
          // The order members finished in is what a replay reveals them in.
          const order = event.status === 'completed' || event.status === 'failed' ? changes.finished++ : undefined;
          const stored = order === undefined ? event : { ...event, order };
          if (index === undefined) { index = members.length; liveMemberIndexes.set(key, index); members.push(stored); }
          else members[index] = stored;
          changes.versions[index] = ++changes.version;
        },
      });
      await writeJson(join(runDirectory, 'run.json'), record);
      // The validated record is authoritative; HTML is a rebuildable export.
      try { await writeText(join(runDirectory, 'report.html'), renderReport(record)); } catch { /* The report route renders from run.json. */ }
      const finished: WorkspaceRun = {
        ...job,
        status: record.status,
        stages: recordedRunStages(record.pipeline, record),
        usage: record.usage,
        message: record.status === 'completed' ? 'Study complete.' : 'Study ended with failures. Inspect the report before interpreting results.',
        reportUrl: `/reports/${job.id}`,
      };
      try { await writeJson(join(runDirectory, 'job.json'), finished); } catch { /* pending.json retains explicit launch ownership. */ }
      Object.assign(job, finished);
      runRecords.set(job.id, join(runDirectory, 'run.json'));
      const { liveMembers: _liveMembers, ...publicJob } = job;
      // Progress lines stay free of answers; the run view reads each step's outcome from the run itself.
      options.emit?.({ event: 'workspace-run', ...publicJob, ...(publicJob.stages ? { stages: publicJob.stages.map(({ outcome: _outcome, ...stage }) => stage) } : {}) });
    } catch (error) {
      job.status = 'failed'; job.message = error instanceof ProviderError ? error.message : 'Run could not complete. Check study configuration and the selected evaluation provider, then review and retry.';
      job.stages = job.stages?.map(stage => stage.status === 'running' ? { ...stage, status: 'failed', reason: job.message } : stage);
      options.emit?.({ event: 'workspace-run', runId: job.id, status: 'failed' });
    } finally { try { await provider?.close?.(); } finally { activeProvider = undefined; activeRun = null; } }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const remote = request.socket.remoteAddress ?? '';
    const pathname = new URL(request.url ?? '/', origin).pathname;
    if (options.hosted) {
      // The platform's health check reaches the instance directly, with its own Host header.
      if (request.method === 'GET' && pathname === '/healthz') { send(response, 200, { ok: true }); return; }
      if (request.headers.host !== expectedHost || (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new HttpError(403, 'FORBIDDEN', 'Open the workspace URL directly.');
      if (!hostedPasswordMatches(request, options.hosted.password)) {
        response.setHeader('WWW-Authenticate', 'Basic realm="Jev Polls", charset="UTF-8"');
        throw new HttpError(401, 'PASSWORD_REQUIRED', 'Enter the workspace password.');
      }
    } else if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote) || request.headers.host !== expectedHost || (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new HttpError(403, 'FORBIDDEN', 'Open the local workspace URL directly.');
    const method = request.method;
    if (method !== 'GET') {
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use the workspace controls.');
      if (request.headers.origin !== origin || request.headers['x-jev-csrf'] !== csrf) throw new HttpError(403, 'SESSION_EXPIRED', 'This workspace page expired. Reload it before saving.');
    }
    if (method === 'GET' && pathname === '/') { send(response, 200, renderWorkspace(nonce, csrf), true); return; }
    if (method === 'GET' && pathname === '/api/agent-config') { send(response, 200, agentConnectionConfig(origin + '/')); return; }
    if (pathname.startsWith('/api/chatgpt/')) {
      try {
        if (method === 'GET' && pathname === '/api/chatgpt/status') {
          try { send(response, 200, await chatgpt.snapshot()); }
          catch (error) { send(response, 200, { connected: false, planEnabled: false, accounts: [], signingIn: false, unavailable: true, message: chatGptMessage(error) }); }
          return;
        }
        if (method === 'GET' && pathname === '/api/chatgpt/models') {
          const models = await chatgpt.client.listModels();
          send(response, 200, { models: models.map(model => ({ id: model.id, name: model.name })) }); return;
        }
        if (method === 'POST') {
          if (changingChatGpt) throw new HttpError(409, 'CHATGPT_BUSY', 'Another ChatGPT connection change is in progress.');
          changingChatGpt = true;
          try {
          if (activeDraftId && localAgents.get(activeDraftId)?.status === 'running') throw new HttpError(409, 'AGENT_BUSY', 'Wait for the drafting task or cancel it before changing ChatGPT accounts.');
          if (pathname === '/api/chatgpt/connect') {
            const input = z.object({ accountId: z.string().min(1).max(500).optional() }).strict().parse(await body(request));
            chatgpt.start(input.accountId); send(response, 202, { signingIn: true }); return;
          }
          if (pathname === '/api/chatgpt/select') {
            const input = z.object({ accountId: z.string().min(1).max(500) }).strict().parse(await body(request));
            await chatgpt.select(input.accountId); send(response, 200, await chatgpt.snapshot()); return;
          }
          if (pathname === '/api/chatgpt/cancel' || pathname === '/api/chatgpt/disconnect') {
            z.object({}).strict().parse(await body(request));
            if (pathname.endsWith('/cancel')) await chatgpt.cancel(); else await chatgpt.disconnect();
            send(response, 200, await chatgpt.snapshot()); return;
          }
          } finally { changingChatGpt = false; }
        }
      } catch (error) {
        if (error instanceof HttpError || error instanceof z.ZodError) throw error;
        throw new HttpError(400, 'CHATGPT_REQUEST_FAILED', chatGptMessage(error));
      }
    }
    if (pathname.startsWith('/api/byos/')) {
      try {
        if (method === 'GET' && pathname === '/api/byos/models') {
          const engine = new URL(request.url ?? '/', origin).searchParams.get('provider');
          if (!isByosEngine(engine)) throw new HttpError(400, 'INVALID_PROVIDER', 'Choose a drafting provider.');
          send(response, 200, { models: await byos.models(engine) }); return;
        }
        if (method === 'POST' && (pathname === '/api/byos/connect' || pathname === '/api/byos/disconnect')) {
          if (activeDraftId && localAgents.get(activeDraftId)?.status === 'running') throw new HttpError(409, 'AGENT_BUSY', 'Wait for the drafting task or cancel it before changing AI connections.');
          if (pathname.endsWith('/connect')) {
            // The key is checked, saved to the OS credential store and never sent back or logged.
            const input = z.object({ provider: z.string().refine(isByosEngine), key: z.string().min(1).max(1000) }).strict().parse(await body(request));
            send(response, 200, { models: await byos.connect(input.provider as Parameters<typeof byos.connect>[0], input.key) }); return;
          }
          const input = z.object({ provider: z.string().refine(isByosEngine) }).strict().parse(await body(request));
          await byos.disconnect(input.provider as Parameters<typeof byos.disconnect>[0]); send(response, 200, { disconnected: true }); return;
        }
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof z.ZodError) throw new HttpError(400, 'BYOS_REQUEST_FAILED', 'Choose a provider and paste one key.');
        throw new HttpError(400, 'BYOS_REQUEST_FAILED', error instanceof ByosConnectionError ? error.message : 'The AI connection could not be changed. Try again.');
      }
    }
    if (method === 'GET' && pathname === '/api/local-agents') { send(response, 200, await localAgents.availability()); return; }
    if (method === 'POST' && pathname === '/api/agent/jobs') {
      const input = z.object({ projectId: safeId.optional(), engine: z.enum(LOCAL_AGENT_ENGINES), model: z.string().trim().min(1).max(200).optional(), prompt: z.string().trim().min(1).max(10_000), revision: z.number().int().nonnegative().safe(), cohort: cohortInputSchema.optional(), persona: z.object({ cohortId: safeId, personaId: safeId }).strict().optional(), options: optionDraftInputSchema.optional(), material: materialSchema.optional(), materialName: materialNameSchema.optional(), resumeFrom: z.string().uuid().optional(), focus: z.object({ pipelineId: safeId, stageId: safeId.optional() }).strict().optional() }).strict().refine(value => [value.cohort, value.persona, value.options].filter(Boolean).length <= 1, 'Choose one draft target').refine(value => value.resumeFrom === undefined || value.cohort !== undefined, 'Only an audience can continue a stopped run').refine(value => value.material === undefined || !(value.cohort || value.persona || value.options), 'Source material belongs to workspace drafts').refine(value => value.materialName === undefined || value.material !== undefined, 'A material name needs source material').parse(await body(request, 2 * 1024 * 1024));
      const saved = await store.read();
      if (saved.revision !== input.revision) throw new WorkspaceConflictError(input.revision, saved.revision);
      if (input.engine === 'chatgpt' && (changingChatGpt || (await chatgpt.snapshot()).signingIn || changingChatGpt)) throw new HttpError(409, 'CHATGPT_BUSY', 'Finish or cancel ChatGPT sign-in before drafting.');
      const job = await withWorkspaceMutation(async () => {
        const current = await store.read();
        if (current.revision !== input.revision) throw new WorkspaceConflictError(input.revision, current.revision);
        if (input.engine === 'chatgpt' && changingChatGpt) throw new HttpError(409, 'CHATGPT_BUSY', 'Finish or cancel ChatGPT sign-in before drafting.');
        // Project validation, launch and ownership registration must precede any later save.
        const started = localAgents.start({ ...input, document: current.document });
        activeDraftId = started.id;
        return started;
      });
      send(response, 202, job); return;
    }
    if (method === 'POST' && pathname === '/api/agent/commands') {
      const input = z.object({ projectId: safeId.optional(), engine: z.enum(LOCAL_AGENT_ENGINES), model: z.string().trim().min(1).max(200).optional(), prompt: z.string().trim().min(1).max(10_000), revision: z.number().int().nonnegative().safe(), document: z.unknown().optional() }).strict().parse(await body(request, MAX_WORKSPACE_BYTES + 256 * 1024));
      const saved = await store.read();
      if (saved.revision !== input.revision) throw new WorkspaceConflictError(input.revision, saved.revision);
      let commandDocument: WorkspaceDocument;
      try { commandDocument = validateWorkspaceDocument(input.document ?? saved.document); }
      catch (error) { throw new HttpError(400, 'INVALID_COMMAND_CONTEXT', validationMessage(error)); }
      if (input.engine === 'chatgpt' && (changingChatGpt || (await chatgpt.snapshot()).signingIn || changingChatGpt)) throw new HttpError(409, 'CHATGPT_BUSY', 'Finish or cancel ChatGPT sign-in before using AI commands.');
      const job = await withWorkspaceMutation(async () => {
        const current = await store.read();
        if (current.revision !== input.revision) throw new WorkspaceConflictError(input.revision, current.revision);
        if (input.engine === 'chatgpt' && changingChatGpt) throw new HttpError(409, 'CHATGPT_BUSY', 'Finish or cancel ChatGPT sign-in before using AI commands.');
        const targets = buildCommandTargets(commandDocument, input.projectId, ownedRuns(commandDocument));
        const started = localAgents.start({ ...input, command: true, document: commandDocument, commandTargets: targets });
        activeDraftId = started.id;
        return started;
      });
      send(response, 202, job); return;
    }
    if (method === 'GET' && pathname === '/api/agent/jobs') {
      const projectId = safeId.optional().parse(new URL(request.url ?? '/', origin).searchParams.get('projectId') ?? undefined);
      const saved = await store.read();
      // A completed whole-workspace proposal tied to an older revision can no longer be applied, so it is not offered again.
      // A generated audience adds only its own cohort, so later saves never make it unusable and it stays on offer until used or discarded.
      const jobs = (localAgents.list?.(projectId) ?? []).filter(job => job.status !== 'completed' || !!job.cohort || job.revision === saved.revision);
      send(response, 200, { jobs }); return;
    }
    const agentRoute = /^\/api\/agent\/jobs\/([0-9a-f-]{36})(?:\/(cancel|apply|discard|members))?$/.exec(pathname);
    if (agentRoute) {
      const job = localAgents.get(agentRoute[1]!);
      if (!job) throw new HttpError(404, 'AGENT_JOB_NOT_FOUND', 'Assistant task was not found. Start a new task.');
      if (method === 'GET' && !agentRoute[2]) { send(response, 200, job); return; }
      if (method === 'GET' && agentRoute[2] === 'members') {
        const batch = z.coerce.number().int().nonnegative().safe().parse(new URL(request.url ?? '/', origin).searchParams.get('batch'));
        const personas = localAgents.members?.(job.id, batch);
        if (!personas) throw new HttpError(404, 'AGENT_BATCH_NOT_READY', 'Those personas have not been checked yet.');
        send(response, 200, { personas }); return;
      }
      if (method === 'POST' && agentRoute[2] === 'cancel') {
        z.object({}).strict().parse(await body(request));
        send(response, 200, localAgents.cancel(job.id)); return;
      }
      if (method === 'POST' && agentRoute[2] === 'discard') {
        z.object({}).strict().parse(await body(request));
        send(response, 200, localAgents.settle?.(job.id, 'discarded') ?? job); return;
      }
      if (method === 'POST' && agentRoute[2] === 'apply') {
        const input = z.object({ revision: z.number().int().nonnegative().safe() }).strict().parse(await body(request));
        if (localAgents.disposition?.(job.id) === 'applied') throw new HttpError(409, 'AGENT_PROPOSAL_APPLIED', 'This proposal was already applied, possibly in another tab or window. Reload the saved workspace to see it.');
        if (job.status !== 'completed' || !job.proposal) throw new HttpError(409, 'AGENT_PROPOSAL_NOT_READY', 'A completed proposal is required before applying changes.');
        if (input.revision !== job.revision) throw new WorkspaceConflictError(job.revision, input.revision);
        let saved;
        try { saved = await saveWorkspace(job.proposal.document, input.revision); }
        catch (error) {
          if (error instanceof WorkspaceConflictError && localAgents.disposition?.(job.id) === 'applied') throw new HttpError(409, 'AGENT_PROPOSAL_APPLIED', 'This proposal was already applied, possibly in another tab or window. Reload the saved workspace to see it.');
          throw error;
        }
        localAgents.settle?.(job.id, 'applied');
        send(response, 200, saved); return;
      }
    }
    if (method === 'GET' && pathname === '/api/workspace') {
      const saved = await store.read(); const runs = ownedRuns(saved.document);
      const [auth, gliner] = await Promise.all([getAuth(), getGliner()]);
      send(response, 200, { ...saved, auth, ...(options.demo ? { demo: true } : {}), gliner: { ready: gliner.ready, model: gliner.model, message: gliner.message }, runs: runs.sort((a,b) => b.createdAt.localeCompare(a.createdAt)), activeRun: runs.find(job => job.id === activeRun?.id) ?? null }); return;
    }
    if (method === 'GET' && pathname === '/status') { send(response, 200, { status: 'workspace', pid: process.pid, activeRun: ownedRuns((await store.read()).document).find(job => job.id === activeRun?.id) ?? null, configured: (await getAuth()).configured }); return; }
    if (method === 'GET' && pathname.startsWith('/api/run/')) {
      const key = pathname.slice('/api/run/'.length);
      if (key.endsWith('/record')) {
        const id = key.slice(0, -'/record'.length);
        send(response, 200, await savedRunRecord(await ownedRun(id))); return;
      }
      const job = await ownedRun(key);
      // `?since=<liveVersion>` returns only members that changed after that point; without it, everything.
      const changes = liveChanges.get(job);
      const sinceText = new URL(request.url ?? '/', origin).searchParams.get('since');
      if (changes && job.liveMembers) {
        const since = sinceText === null ? -1 : Number(sinceText);
        const delta = Number.isInteger(since) && since >= 0;
        send(response, 200, { ...job, liveMembers: delta ? job.liveMembers.filter((_, index) => (changes.versions[index] ?? 0) > since) : job.liveMembers, liveVersion: changes.version, liveTotal: job.liveMembers.length, ...(delta ? { liveDelta: true } : {}) }); return;
      }
      send(response, 200, job); return;
    }
    if (method === 'GET' && pathname.startsWith('/reports/')) {
      const job = await ownedRun(pathname.slice('/reports/'.length));
      send(response, 200, renderReport(await savedRunRecord(job), { workspace: true, projectId: job.projectId }), true, true); return;
    }
    if (method === 'GET' && pathname === '/report') {
      const latest = ownedRuns((await store.read()).document).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).find(job => job.reportUrl);
      headers(response); response.writeHead(302, { Location: latest?.reportUrl ?? '/' }); response.end(); return;
    }
    if (method === 'POST' && pathname === '/api/auth') {
      const input = z.object({ apiKey: z.string().trim().min(1).max(8192) }).strict().parse(await body(request, 16 * 1024));
      if (authenticating) throw new HttpError(409, 'CONNECTING', 'Account connection is already in progress.');
      authenticating = true;
      try { await connectAccount(input.apiKey); send(response, 200, { verified: true, auth: await getAuth() }); }
      catch (error) { throw new HttpError(400, error instanceof ProviderError ? error.code : 'CONNECTION_FAILED', error instanceof ProviderError ? error.message : 'Account connection failed. Check TypeSafe access and retry.'); }
      finally { input.apiKey = ''; authenticating = false; }
      return;
    }
    if (method === 'POST' && pathname === '/api/validate-draft') {
      const input = z.object({ document: z.unknown() }).strict().parse(await body(request));
      try { send(response, 200, validateWorkspaceDocument(input.document)); }
      catch (error) { throw new HttpError(400, 'INVALID_DRAFT', validationMessage(error)); }
      return;
    }
    if (method === 'POST' && pathname === '/api/workspace') {
      const input = z.object({ document: z.unknown(), revision: z.number().int().nonnegative() }).strict().parse(await body(request));
      try { const saved = await saveWorkspace(input.document, input.revision); send(response, 200, saved); }
      catch (error) { if (error instanceof WorkspaceConflictError || error instanceof HttpError) throw error; throw new HttpError(400, 'INVALID_DRAFT', validationMessage(error)); }
      return;
    }
    if (method === 'POST' && pathname === '/api/plan') {
      const input = z.object({ pipelineId: safeId, projectId: safeId.optional(), provider: evaluationProvider.default('typesafe'), seed: z.string().min(1).max(200).optional() }).strict().parse(await body(request));
      const saved = await store.read();
      let project;
      try { project = workspacePlan(saved.document, input.pipelineId, input.provider); }
      catch (error) { throw new HttpError(400, 'INVALID_STUDY', validationMessage(error)); }
      if (input.projectId && input.projectId !== project.projectId) throw new HttpError(400, 'INVALID_STUDY', 'Pipeline does not belong to the selected project.');
      const planToken = randomBytes(24).toString('hex');
      if (plans.size >= 50) plans.delete(plans.keys().next().value!);
      plans.set(planToken, { pipelineId: input.pipelineId, revision: saved.revision, provider: input.provider, expires: Date.now() + 15 * 60_000 });
      const warnings = [...project.warnings];
      if (options.demo) warnings.unshift('Demo mode: answers are generated locally as mock data. Nothing is sent to TypeSafe or billed, and the results mean nothing.');
      if (input.provider === 'gliner') warnings.push('GLiNER is a local English classifier. Its normalized label scores are not calibrated human response probabilities; persona simulation quality has not been established. Inputs above 512 combined text and question tokens are rejected.');
      const model = input.provider === 'gliner' ? GLINER_MODEL : MODEL, seed = input.seed ?? studySeed(saved.document, input.pipelineId);
      // Reading saved answers never calls the provider; if it cannot finish, every step simply shows as running again.
      const reuse = await predictReuse(project.pipeline, project.cohorts, { provider: { name: options.demo ? 'mock' : input.provider, ...(!options.demo && input.provider === 'gliner' ? { cacheIdentity: GLINER_CACHE_IDENTITY } : {}) }, model, seed, cacheDir: join(directory, 'cache') }).catch(() => []);
      const stages = project.stages.map(stage => {
        const found = reuse.find(item => item.id === stage.id);
        return { ...stage, reused: Math.min(stage.requests, found?.reused ?? 0), reuse: found?.state ?? 'run' as const };
      });
      // Saved answers cost nothing, so a step's estimate shrinks with the share of its requests that are new.
      const newCost = project.cost ? costOf(stages.flatMap(stage => {
        if (!stage.usage || !stage.requests || stage.reuse === 'skipped') return [];
        const share = (stage.requests - stage.reused) / stage.requests;
        return [{ inputTokens: Math.ceil(stage.usage.inputTokens * share), outputTokens: Math.ceil(stage.usage.outputTokens * share) }];
      })) : undefined;
      const newRequests = stages.reduce((sum, stage) => sum + (stage.reuse === 'skipped' ? 0 : stage.requests - stage.reused), 0);
      const plan: WorkspacePlan = { projectId: project.projectId, pipelineId: input.pipelineId, provider: input.provider, revision: saved.revision, planToken, model, seed, maxRequests: project.maxRequests, newRequests, ...(project.cost && !options.demo ? { cost: project.cost, newCost } : {}), ...(options.demo ? { demo: true } : {}), warnings, stages };
      send(response, 200, plan); return;
    }
    if (method === 'POST' && pathname === '/api/run') {
      if (closing) throw new HttpError(503, 'WORKSPACE_CLOSING', 'Workspace is closing. Restart it before running a study.');
      const input = runInput.parse(await body(request));
      const saved = await store.read();
      const reviewed = plans.get(input.planToken);
      if (!reviewed || reviewed.expires < Date.now() || reviewed.pipelineId !== input.pipelineId || reviewed.provider !== input.provider || reviewed.revision !== input.revision || saved.revision !== input.revision) throw new HttpError(409, 'REVIEW_REQUIRED', 'Study or provider changed, or review expired. Review it again before running.');
      if (input.provider === 'typesafe' && !options.demo && !(await getAuth()).configured) throw new HttpError(400, 'CONNECT_REQUIRED', 'Connect your TypeSafe account before running this study.');
      if (input.provider === 'gliner') {
        const status = await getGliner();
        if (!status.ready) throw new HttpError(400, 'GLINER_NOT_READY', status.message ?? 'Set up GLiNER locally before running this study.');
      }
      // Serialize the final revision check and launch with save commits, not slow authentication.
      const { job, project } = await withWorkspaceMutation(async () => {
        const latest = await store.read();
        const currentReview = plans.get(input.planToken);
        if (!currentReview || currentReview.expires < Date.now() || currentReview.pipelineId !== input.pipelineId || currentReview.provider !== input.provider || currentReview.revision !== input.revision || latest.revision !== input.revision) {
          throw new HttpError(409, 'REVIEW_REQUIRED', 'Study changed or review expired. Review it again before running.');
        }
        const project = workspacePlan(latest.document, input.pipelineId, input.provider);
        if (input.projectId && input.projectId !== project.projectId) throw new HttpError(400, 'INVALID_STUDY', 'Pipeline does not belong to the selected project.');
        if (input.maxRequests < project.maxRequests) throw new HttpError(400, 'BUDGET_TOO_SMALL', 'Request budget must cover the reviewed upper bound. Reduce sample sizes or repeats first.');
        if (activeRun) throw new HttpError(409, 'RUN_IN_PROGRESS', 'A study is already running. Wait for it to finish.');
        // No await between consuming the review and taking the execution lock.
        if (!plans.delete(input.planToken)) throw new HttpError(409, 'REVIEW_REQUIRED', 'This review was already used. Review the study again.');
        const job: WorkspaceRun = { projectId: project.projectId, provider: input.provider, seed: input.seed ?? studySeed(latest.document, input.pipelineId), id: randomUUID(), pipelineId: project.pipeline.id, pipelineName: project.pipeline.name, status: 'running', createdAt: new Date().toISOString(), message: input.provider === 'gliner' ? 'Loading local GLiNER model…' : 'Starting your reviewed study…', stages: initialRunStages(project.pipeline) };
        jobs.set(job.id, job); activeRun = job;
        return { job, project };
      });
      send(response, 202, job); execution = execute(job, project, input); void execution.catch(() => undefined); return;
    }
    throw new HttpError(404, 'NOT_FOUND', 'Page was not found.');
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const conflict = error instanceof WorkspaceConflictError;
      const agentError = error instanceof LocalAgentError;
      const status = error instanceof HttpError ? error.status : conflict || (agentError && error.code === 'AGENT_BUSY') ? 409 : error instanceof z.ZodError || agentError ? 400 : 500;
      const code = error instanceof HttpError || agentError ? error.code : conflict ? 'WORKSPACE_CONFLICT' : status === 400 ? 'INVALID_REQUEST' : 'WORKSPACE_ERROR';
      const message = error instanceof HttpError || agentError ? error.message : conflict ? 'Workspace changed in another tab. Reload before saving.' : status === 400 ? validationMessage(error) : 'Workspace could not complete this request. Retry or check the local server.';
      send(response, status, { error: { code, message } });
    });
  });
  await new Promise<void>((resolveListening, reject) => {
    server.once('error', reject);
    const publicOrigin = options.hosted ? hostedOrigin(options.hosted) : undefined;
    server.listen(options.port ?? 0, publicOrigin ? '0.0.0.0' : '127.0.0.1', () => {
      server.removeListener('error', reject); const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Could not bind workspace server')); return; }
      if (publicOrigin) { expectedHost = publicOrigin.host; origin = publicOrigin.origin; }
      else { expectedHost = `127.0.0.1:${address.port}`; origin = `http://${expectedHost}`; }
      resolveListening();
    });
  });
  return { url: origin + '/', close: () => closePromise ??= (async () => {
    closing = true;
    await activeProvider?.close?.();
    await execution?.catch(() => undefined);
    await localAgents.close();
    await chatgpt.close();
    const closed = new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
    // Keep-alive clients (agent polls) would otherwise keep a closing server answering on their socket.
    server.closeAllConnections();
    await closed;
  })() };
}
