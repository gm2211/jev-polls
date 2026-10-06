import { MAX_COHORT_PERSONAS } from './limits.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { authStatus, setApiKey } from './auth.js';
import { verifyTypeSafeConnection } from './auth-check.js';
import { createProvider, ProviderError } from './provider.js';
import { runPipeline } from './engine.js';
import { renderReport } from './report.js';
import { loadRun } from './run-record.js';
import { writeJson, writeText } from './io.js';
import { WorkspaceStore, workspacePlan, WorkspaceConflictError, validateWorkspaceDocument } from './workspace-store.js';
import { renderWorkspace } from './workspace-ui.js';
import { agentConnectionConfig } from './agent-config.js';
import { LocalAgentError, LocalAgentService } from './local-agent.js';
import { ChatGptConnection, chatGptMessage, createDraftClient, type ChatGptDraftClient } from './chatgpt.js';
import type { Provider } from './types.js';
import type { AuthStatus } from './auth.js';
import type { WorkspaceRun, WorkspacePlan } from './workspace-types.js';

const MODEL = 'jev-1.13.0';
const WORKSPACE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const safeId = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(160);
const runInput = z.object({ pipelineId: safeId, projectId: safeId.optional(), revision: z.number().int().nonnegative(), planToken: z.string(), seed: z.string().min(1).max(200), concurrency: z.number().int().min(1).max(16), maxRequests: z.number().int().min(1).max(100_000) }).strict();
const savedJobSchema = z.object({
  id: z.string().regex(WORKSPACE_RUN_ID), projectId: safeId.optional(), pipelineId: safeId, pipelineName: z.string().max(100_000),
  status: z.enum(['running', 'completed', 'failed']), createdAt: z.string().max(100), message: z.string().max(100_000),
  progress: z.object({ stage: safeId, completed: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
  usage: z.object({ inputTokens: z.number().finite().nonnegative(), outputTokens: z.number().finite().nonnegative(), requests: z.number().int().nonnegative(), cacheHits: z.number().int().nonnegative() }).strict().optional(),
  reportUrl: z.string().regex(/^\/reports\/[0-9a-f-]{36}$/).optional(),
}).strict();
class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
function validationMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map(issue => `${issue.path.join('.') || 'Study'}: ${issue.message}`).join('\n').slice(0, 3000);
  return error instanceof Error ? error.message.slice(0, 3000) : 'Check study fields and references.';
}

export interface WorkspaceServerOptions {
  directory: string;
  chatgpt?: ChatGptDraftClient;
  port?: number;
  legacyRunsDirectory?: string;
  getAuthStatus?: () => Promise<AuthStatus>;
  connectAccount?: (key: string) => Promise<unknown>;
  providerFactory?: () => Provider;
  emit?: (event: Record<string, unknown>) => void;
  localAgents?: Pick<LocalAgentService, 'availability' | 'start' | 'get' | 'cancel' | 'close'>;
}

/** Account connection and review are separate from explicit study execution. */
export async function startWorkspaceServer(options: WorkspaceServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const directory = resolve(options.directory);
  const store = new WorkspaceStore(directory);
  const chatgpt = new ChatGptConnection(options.chatgpt ?? createDraftClient());
  const localAgents = options.localAgents ?? new LocalAgentService({ chatgpt: chatgpt.client });
  let activeDraftId: string | undefined;
  let changingChatGpt = false;
  const csrf = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  const getAuth = options.getAuthStatus ?? authStatus;
  const connectAccount = options.connectAccount ?? (async (key: string) => { const result = await verifyTypeSafeConnection(key); await setApiKey(key); return result; });
  const jobs = new Map<string, WorkspaceRun>();
  const reports = new Map<string, string>();
  const plans = new Map<string, { pipelineId: string; revision: number; expires: number }>();
  let activeRun: WorkspaceRun | null = null;
  let authenticating = false;
  let origin = '';
  let expectedHost = '';
  let closePromise: Promise<void> | undefined;

  async function discoverRuns(parent: string, workspace: boolean) {
    let entries;
    try { entries = await readdir(parent, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.filter(e => e.isDirectory()).slice(-200)) {
      if (workspace && !WORKSPACE_RUN_ID.test(entry.name)) continue;
      const id = workspace ? entry.name : undefined;
      const path = join(parent, entry.name);
      try {
        const record = await loadRun(join(path, 'run.json'));
        const stableId = id ?? record.id;
        const message = record.status === 'completed' ? 'Study complete.' : 'Study ended with failures. Inspect the report before interpreting results.';
        let persistedProgress: WorkspaceRun['progress'];
        let persistedProjectId: string | undefined;
        if (workspace) {
          try {
            const parsed = savedJobSchema.parse(JSON.parse(await readFile(join(path, 'job.json'), 'utf8')));
            if (parsed.id === stableId && parsed.pipelineId === record.pipeline.id && parsed.status === record.status) {
              persistedProgress = parsed.progress; persistedProjectId = parsed.projectId;
            }
          } catch { /* The run record remains authoritative if optional job metadata is absent or damaged. */ }
          if (!persistedProjectId) {
            try {
              const pending = savedJobSchema.parse(JSON.parse(await readFile(join(path, 'pending.json'), 'utf8')));
              if (pending.id === stableId && pending.pipelineId === record.pipeline.id && pending.status === 'running') persistedProjectId = pending.projectId;
            } catch { /* Legacy records can have no ownership metadata. */ }
          }
        }
        const summary: WorkspaceRun = { ...(persistedProjectId ? { projectId: persistedProjectId } : {}), id: stableId, pipelineId: record.pipeline.id, pipelineName: record.pipeline.name, status: record.status, createdAt: record.createdAt, message, usage: record.usage, reportUrl: `/reports/${stableId}`, ...(persistedProgress ? { progress: persistedProgress } : {}) };
        jobs.set(summary.id, summary); reports.set(summary.id, join(path, 'report.html'));
      } catch {
        if (!workspace) continue;
        try {
          const pending = savedJobSchema.parse(JSON.parse(await readFile(join(path, 'pending.json'), 'utf8')));
          if (pending.id !== id || pending.status !== 'running') continue;
          jobs.set(id!, { ...pending, id: id!, status: 'failed', message: 'Server stopped before this run finished. Review and run again to reuse completed cached responses.', reportUrl: undefined });
        } catch { /* An incomplete/corrupt artifact is not presented as a completed run. */ }
      }
    }
  }
  await discoverRuns(join(directory, 'runs'), true);
  if (options.legacyRunsDirectory) await discoverRuns(resolve(options.legacyRunsDirectory), false);
  const initialDocument = (await store.read()).document;
  for (const job of jobs.values()) {
    if (job.projectId) continue; // Recorded ownership survives later pipeline moves/deletion.
    const owner = initialDocument.projects?.find(project => project.pipelineIds.includes(job.pipelineId));
    if (owner) job.projectId = owner.id;
  }

  function headers(response: ServerResponse, report = false) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', report
      ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      : `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
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
    try {
      await writeJson(join(runDirectory, 'pending.json'), job);
      const record = await runPipeline(project.pipeline, project.cohorts, {
        provider: (options.providerFactory ?? (() => createProvider('typesafe')))(), model: MODEL,
        seed: input.seed, concurrency: input.concurrency, maxRequests: input.maxRequests,
        cacheDir: join(directory, 'cache'),
        onProgress: event => { job.progress = event; job.message = `${event.stage}: ${event.completed} of ${event.total} evaluations processed`; options.emit?.({ event: 'progress', runId: job.id, ...event }); },
      });
      await writeText(join(runDirectory, 'report.html'), renderReport(record));
      await writeJson(join(runDirectory, 'run.json'), record);
      const finished: WorkspaceRun = {
        ...job,
        status: record.status,
        usage: record.usage,
        message: record.status === 'completed' ? 'Study complete.' : 'Study ended with failures. Inspect the report before interpreting results.',
        reportUrl: `/reports/${job.id}`,
      };
      try { await writeJson(join(runDirectory, 'job.json'), finished); } catch { /* run.json and report.html remain the authoritative artifacts */ }
      Object.assign(job, finished);
      reports.set(job.id, join(runDirectory, 'report.html'));
      options.emit?.({ event: 'workspace-run', ...job });
    } catch {
      job.status = 'failed'; job.message = 'Run could not complete. Check study configuration and TypeSafe access, then review and retry.';
      options.emit?.({ event: 'workspace-run', runId: job.id, status: 'failed' });
    } finally { activeRun = null; }
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const remote = request.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(remote) || request.headers.host !== expectedHost || (request.headers.origin !== undefined && request.headers.origin !== origin)) throw new HttpError(403, 'FORBIDDEN', 'Open the local workspace URL directly.');
    const pathname = new URL(request.url ?? '/', origin).pathname;
    const method = request.method;
    if (method !== 'GET') {
      if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use the workspace controls.');
      if (request.headers.origin !== origin || request.headers['x-jev-csrf'] !== csrf) throw new HttpError(403, 'SESSION_EXPIRED', 'This workspace page expired. Reload it before saving.');
    }
    if (method === 'GET' && pathname === '/') { send(response, 200, renderWorkspace(nonce, csrf), true); return; }
    if (method === 'GET' && pathname === '/api/agent-config') { send(response, 200, agentConnectionConfig(origin + '/')); return; }
    if (pathname.startsWith('/api/chatgpt/')) {
      try {
        if (method === 'GET' && pathname === '/api/chatgpt/status') { send(response, 200, await chatgpt.snapshot()); return; }
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
    if (method === 'GET' && pathname === '/api/local-agents') { send(response, 200, await localAgents.availability()); return; }
    if (method === 'POST' && pathname === '/api/agent/jobs') {
      const input = z.object({ engine: z.enum(['codex', 'claude', 'chatgpt']), model: z.string().trim().min(1).max(200).optional(), prompt: z.string().trim().min(1).max(10_000), revision: z.number().int().nonnegative().safe(), projectId: safeId.optional(), cohort: z.object({ id: safeId, size: z.number().int().min(1).max(MAX_COHORT_PERSONAS) }).strict().optional() }).strict().parse(await body(request, 64 * 1024));
      const saved = await store.read();
      if (saved.revision !== input.revision) throw new WorkspaceConflictError(input.revision, saved.revision);
      if (input.engine === 'chatgpt' && (changingChatGpt || (await chatgpt.snapshot()).signingIn || changingChatGpt)) throw new HttpError(409, 'CHATGPT_BUSY', 'Finish or cancel ChatGPT sign-in before drafting.');
      const job = localAgents.start({ ...input, document: saved.document }); activeDraftId = job.id;
      send(response, 202, job); return;
    }
    const agentRoute = /^\/api\/agent\/jobs\/([0-9a-f-]{36})(?:\/(cancel|apply))?$/.exec(pathname);
    if (agentRoute) {
      const job = localAgents.get(agentRoute[1]!);
      if (!job) throw new HttpError(404, 'AGENT_JOB_NOT_FOUND', 'Assistant task was not found. Start a new task.');
      if (method === 'GET' && !agentRoute[2]) { send(response, 200, job); return; }
      if (method === 'POST' && agentRoute[2] === 'cancel') {
        z.object({}).strict().parse(await body(request));
        send(response, 200, localAgents.cancel(job.id)); return;
      }
      if (method === 'POST' && agentRoute[2] === 'apply') {
        const input = z.object({ revision: z.number().int().nonnegative().safe() }).strict().parse(await body(request));
        if (job.status !== 'completed' || !job.proposal) throw new HttpError(409, 'AGENT_PROPOSAL_NOT_READY', 'A completed proposal is required before applying changes.');
        if (input.revision !== job.revision) throw new WorkspaceConflictError(job.revision, input.revision);
        const saved = await store.save(job.proposal.document, input.revision);
        plans.clear(); send(response, 200, saved); return;
      }
    }
    if (method === 'GET' && pathname === '/api/workspace') {
      send(response, 200, { ...await store.read(), auth: await getAuth(), runs: [...jobs.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)), activeRun }); return;
    }
    if (method === 'GET' && pathname === '/status') { send(response, 200, { status: 'workspace', activeRun, configured: (await getAuth()).configured }); return; }
    if (method === 'GET' && pathname.startsWith('/api/run/')) {
      const key = pathname.slice('/api/run/'.length);
      if (key.endsWith('/record')) {
        const id = key.slice(0, -'/record'.length);
        if (!jobs.has(id)) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run was not found.');
        const reportPath = reports.get(id);
        if (!reportPath) throw new HttpError(409, 'RUN_NOT_READY', 'A saved run record is not available yet.');
        send(response, 200, await loadRun(join(dirname(reportPath), 'run.json'))); return;
      }
      const job = jobs.get(key);
      if (!job) throw new HttpError(404, 'RUN_NOT_FOUND', 'Run was not found.');
      send(response, 200, job); return;
    }
    if (method === 'GET' && pathname.startsWith('/reports/')) {
      const path = reports.get(pathname.slice('/reports/'.length));
      if (!path) throw new HttpError(404, 'REPORT_NOT_FOUND', 'Report is not available yet.');
      send(response, 200, await readFile(path, 'utf8'), true, true); return;
    }
    if (method === 'GET' && pathname === '/report') {
      const latest = [...jobs.values()].sort((a,b) => b.createdAt.localeCompare(a.createdAt)).find(job => job.reportUrl);
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
      try { const saved = await store.save(input.document, input.revision); plans.clear(); send(response, 200, saved); }
      catch (error) { if (error instanceof WorkspaceConflictError) throw error; throw new HttpError(400, 'INVALID_DRAFT', validationMessage(error)); }
      return;
    }
    if (method === 'POST' && pathname === '/api/plan') {
      const input = z.object({ pipelineId: safeId, projectId: safeId.optional() }).strict().parse(await body(request));
      const saved = await store.read();
      let project;
      try { project = workspacePlan(saved.document, input.pipelineId); }
      catch (error) { throw new HttpError(400, 'INVALID_STUDY', validationMessage(error)); }
      if (input.projectId && input.projectId !== project.projectId) throw new HttpError(400, 'INVALID_STUDY', 'Pipeline does not belong to the selected project.');
      const planToken = randomBytes(24).toString('hex');
      if (plans.size >= 50) plans.delete(plans.keys().next().value!);
      plans.set(planToken, { pipelineId: input.pipelineId, revision: saved.revision, expires: Date.now() + 15 * 60_000 });
      const plan: WorkspacePlan = { projectId: project.projectId, pipelineId: input.pipelineId, revision: saved.revision, planToken, model: MODEL, maxRequests: project.maxRequests, warnings: project.warnings, stages: project.stages };
      send(response, 200, plan); return;
    }
    if (method === 'POST' && pathname === '/api/run') {
      const input = runInput.parse(await body(request));
      const saved = await store.read();
      const reviewed = plans.get(input.planToken);
      if (!reviewed || reviewed.expires < Date.now() || reviewed.pipelineId !== input.pipelineId || reviewed.revision !== input.revision || saved.revision !== input.revision) throw new HttpError(409, 'REVIEW_REQUIRED', 'Study changed or review expired. Review it again before running.');
      if (!(await getAuth()).configured) throw new HttpError(400, 'CONNECT_REQUIRED', 'Connect your TypeSafe account before running this study.');
      const latest = await store.read();
      const currentReview = plans.get(input.planToken);
      if (!currentReview || currentReview.expires < Date.now() || currentReview.pipelineId !== input.pipelineId || currentReview.revision !== input.revision || latest.revision !== input.revision) {
        throw new HttpError(409, 'REVIEW_REQUIRED', 'Study changed or review expired. Review it again before running.');
      }
      const project = workspacePlan(latest.document, input.pipelineId);
      if (input.projectId && input.projectId !== project.projectId) throw new HttpError(400, 'INVALID_STUDY', 'Pipeline does not belong to the selected project.');
      if (input.maxRequests < project.maxRequests) throw new HttpError(400, 'BUDGET_TOO_SMALL', 'Request budget must cover the reviewed upper bound. Reduce sample sizes or repeats first.');
      if (activeRun) throw new HttpError(409, 'RUN_IN_PROGRESS', 'A study is already running. Wait for it to finish.');
      // No await between consuming the review and taking the execution lock.
      if (!plans.delete(input.planToken)) throw new HttpError(409, 'REVIEW_REQUIRED', 'This review was already used. Review the study again.');
      const job: WorkspaceRun = { projectId: project.projectId, id: randomUUID(), pipelineId: project.pipeline.id, pipelineName: project.pipeline.name, status: 'running', createdAt: new Date().toISOString(), message: 'Starting your reviewed study…' };
      jobs.set(job.id, job); activeRun = job;
      send(response, 202, job); void execute(job, project, input); return;
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
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject); const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Could not bind workspace server')); return; }
      expectedHost = `127.0.0.1:${address.port}`; origin = `http://${expectedHost}`; resolveListening();
    });
  });
  return { url: origin + '/', close: () => closePromise ??= (async () => {
    await localAgents.close();
    await chatgpt.close();
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  })() };
}
