import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Thrown with a stable code so the MCP adapter can report it without leaking process details. */
export class WorkspaceControlError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface WorkspaceStatus {
  running: boolean; url: string; pid?: number;
  activeRun?: { id: string; projectId: string; pipelineId: string; status: string } | null;
}

export interface WorkspaceControlDeps {
  /** Starts the workspace server detached from this process. */
  launch: (port: number) => void;
  /** Runs a short command in the repository and returns its result. */
  run: (command: string, args: string[]) => SpawnSyncReturns<string>;
  kill: (pid: number) => void;
  waitMs: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Starts, stops, restarts and updates the loopback workspace so agents need no shell access for it. */
export class WorkspaceControl {
  private readonly port: number;
  private readonly log: string;
  private readonly deps: WorkspaceControlDeps;

  constructor(private readonly url: URL, private readonly root: string, deps: Partial<WorkspaceControlDeps> = {}) {
    this.port = Number(url.port);
    this.log = join(root, '.jev-polls', 'workspace-server.log');
    const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 300_000 });
    this.deps = {
      run,
      kill: pid => process.kill(pid, 'SIGTERM'),
      waitMs: 90_000,
      launch: port => {
        // Same steps as `npm start`, but with the configured port and detached so it outlives this adapter.
        const build = run('npm', ['run', 'build:byos']);
        if (build.status !== 0) throw new WorkspaceControlError('WORKSPACE_START_FAILED', `npm run build:byos failed: ${tail(build.stderr || build.stdout)}`);
        mkdirSync(join(root, '.jev-polls'), { recursive: true });
        const fd = openSync(this.log, 'a');
        try {
          spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'workspace', '--port', String(port)], { cwd: root, detached: true, stdio: ['ignore', fd, fd] }).unref();
        } finally { closeSync(fd); }
      },
      ...deps,
    };
  }

  async status(): Promise<WorkspaceStatus> {
    try {
      const response = await fetch(new URL('/status', this.url), { redirect: 'error', signal: AbortSignal.timeout(3_000) });
      const body = await response.json() as { status?: string; pid?: number; activeRun?: WorkspaceStatus['activeRun'] };
      if (body.status !== 'workspace') throw new WorkspaceControlError('PORT_IN_USE', `Port ${this.port} is held by something other than a Jev Polls workspace.`);
      return { running: true, url: this.url.href, ...(Number.isSafeInteger(body.pid) ? { pid: body.pid } : {}), activeRun: body.activeRun ?? null };
    } catch (error) {
      if (error instanceof WorkspaceControlError) throw error;
      return { running: false, url: this.url.href };
    }
  }

  async start(): Promise<WorkspaceStatus & { started: boolean; log: string }> {
    const current = await this.status();
    if (current.running) return { ...current, started: false, log: this.log };
    this.deps.launch(this.port);
    for (const deadline = Date.now() + this.deps.waitMs; Date.now() < deadline; await sleep(250)) {
      const next = await this.status();
      if (next.running) return { ...next, started: true, log: this.log };
    }
    throw new WorkspaceControlError('WORKSPACE_START_FAILED', `Workspace did not answer on ${this.url.href}. Log tail: ${tail(readLog(this.log))}`);
  }

  async stop(): Promise<WorkspaceStatus & { stopped: boolean }> {
    const current = await this.status();
    if (!current.running) return { ...current, stopped: false };
    if (current.activeRun?.status === 'running') throw new WorkspaceControlError('RUN_IN_PROGRESS', 'A study is running. Wait for it to finish before stopping the workspace.');
    const pid = current.pid ?? this.listeningPid();
    if (!pid) throw new WorkspaceControlError('WORKSPACE_PID_UNKNOWN', `Could not find the process serving port ${this.port}. Stop it manually once, then use start.`);
    this.deps.kill(pid);
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; await sleep(200)) {
      if (!(await this.status()).running) return { running: false, url: this.url.href, stopped: true };
    }
    throw new WorkspaceControlError('WORKSPACE_STOP_FAILED', `Workspace process ${pid} did not stop.`);
  }

  async restart() {
    const stopped = await this.stop();
    return { ...(await this.start()), restarted: stopped.stopped };
  }

  /** Fast-forwards the checkout, reinstalls dependencies when they changed, and restarts. */
  async update() {
    const git = (...args: string[]) => {
      const result = this.deps.run('git', args);
      if (result.status !== 0) throw new WorkspaceControlError('UPDATE_FAILED', `git ${args[0]} failed: ${tail(result.stderr || result.stdout)}`);
      return result.stdout.trim();
    };
    if (git('status', '--porcelain', '--untracked-files=no')) throw new WorkspaceControlError('UPDATE_BLOCKED', 'The checkout has uncommitted changes. Commit or stash them before updating.');
    const before = git('rev-parse', 'HEAD');
    git('pull', '--ff-only');
    const after = git('rev-parse', 'HEAD');
    let installed = false;
    if (before !== after && git('diff', '--name-only', before, after).split('\n').some(file => file === 'package.json' || file === 'package-lock.json')) {
      const install = this.deps.run('npm', ['install']);
      if (install.status !== 0) throw new WorkspaceControlError('UPDATE_FAILED', `npm install failed: ${tail(install.stderr || install.stdout)}`);
      installed = true;
    }
    return { from: before, to: after, changed: before !== after, installed, ...(await this.restart()) };
  }

  private listeningPid(): number | undefined {
    const result = this.deps.run('lsof', ['-t', `-iTCP:${this.port}`, '-sTCP:LISTEN']);
    const pid = Number(result.stdout?.trim().split('\n')[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }
}

function readLog(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function tail(text: string | undefined): string {
  return (text ?? '').trim().split('\n').slice(-8).join('\n').slice(-1500);
}
