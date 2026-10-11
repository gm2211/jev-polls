// Times one real cohort generation through LocalAgentService and writes a per-call timeline as JSON.
// Usage: node --import tsx scripts/bench-cohort.ts <size> <out.json> [engine=claude]
import { spawn as spawnProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { LocalAgentService, claudeStreamDelta } from '../src/local-agent.js';

const size = Number(process.argv[2] ?? 100);
const out = process.argv[3] ?? 'bench.json';
const engine = (process.argv[4] ?? 'claude') as 'claude';
const t0 = Date.now();
const rel = () => (Date.now() - t0) / 1000;

interface Call { n: number; args: string; spawnAt: number; firstByteAt?: number; messageStartAt?: number; firstDeltaAt?: number; lastDeltaAt?: number; closeAt?: number; code?: number | null; deltaChars: number; result?: Record<string, unknown>; promptChars: number; kind: string }
const calls: Call[] = [];
const spawn = (command: string, args: string[], options: object): ChildProcessWithoutNullStreams => {
  // BENCH_MODEL pins the Claude model, as a user's own Claude Code default would.
  if (process.env.BENCH_MODEL && args[0] === '--print') args = [...args, '--model', process.env.BENCH_MODEL];
  const child = spawnProcess(command, args, { ...options, stdio: 'pipe' }) as ChildProcessWithoutNullStreams;
  if (args[0] === '--version' || args[0] === 'auth') return child;
  const call: Call = { n: calls.length + 1, args: args.join(' ').slice(0, 80), spawnAt: rel(), deltaChars: 0, promptChars: 0, kind: '?' };
  calls.push(call);
  const write = child.stdin.end.bind(child.stdin);
  (child.stdin as unknown as { end: (chunk: string) => void }).end = (chunk: string) => { call.promptChars = chunk.length; call.kind = /Set up cohort/.test(chunk) ? 'setup' : /Write batch (\d+)/.exec(chunk)?.[0] ?? 'single'; return write(chunk); };
  let buffer = '';
  child.stdout.on('data', (data: Buffer) => {
    call.firstByteAt ??= rel();
    buffer += data.toString('utf8');
    const lines = buffer.split('\n'); buffer = lines.pop()!;
    for (const line of lines) {
      if (line.includes('"message_start"')) call.messageStartAt ??= rel();
      const delta = claudeStreamDelta(line);
      if (delta.text) { call.firstDeltaAt ??= rel(); call.lastDeltaAt = rel(); call.deltaChars += delta.text.length; }
      if (line.includes('"type":"result"')) { try { const r = JSON.parse(line); if (r.type === 'result') call.result = { duration_ms: r.duration_ms, duration_api_ms: r.duration_api_ms, ttft_ms: r.ttft_ms, num_turns: r.num_turns, usage: { input: r.usage?.input_tokens, cacheRead: r.usage?.cache_read_input_tokens, cacheWrite: r.usage?.cache_creation_input_tokens, output: r.usage?.output_tokens, thinking: r.usage?.output_tokens_details?.thinking_tokens }, model: Object.keys(r.modelUsage ?? {})[0], is_error: r.is_error, subtype: r.subtype }; } catch { /* ignore */ } }
    }
  });
  child.once('close', code => { call.closeAt = rel(); call.code = code; });
  return child;
};

const logs: Record<string, unknown>[] = [];
const service = new LocalAgentService({ spawn, log: line => { logs.push({ at: rel(), ...line }); process.stderr.write(JSON.stringify(line).slice(0, 300) + '\n'); } });
const prompt = `Adults in the US, UK and Canada who bought at least one video game in the last year and could buy a $20 indie game. Spread ages 18-65, incomes from under $30k to over $150k, and a mix of platforms. Each persona's background is two sentences about the gaming habits that matter when choosing a new game.

Structured attributes every persona must carry: country, annualIncomeUsd, platform, hoursPlayedLastYear, preferredGenres, favoriteFranchises. Fill each one for every person, and vary them within each segment so people in one segment do not all look alike.

Segments: Casual mobile players (about 35%); Core console players (about 30%); PC enthusiasts (about 20%); Lapsed gamers (about 15%). Give every persona one of these segments.

Personas are independent of the questions asked later: give nobody a preference for or against any option, name or product being compared.`;
const document = { version: 1 as const, cohorts: [], pipelines: [], projects: [{ id: 'bench', name: 'Bench', description: 'Game naming study', cohortIds: [], pipelineIds: [] }] };
const job = service.start({ engine, prompt, revision: 0, document: document as never, projectId: 'bench', cohort: { id: 'gamers', size } });
const samples: Record<string, unknown>[] = [];
let lastMessage = '';
while (true) {
  const state = service.get(job.id)!;
  const p = state.progress ?? {};
  samples.push({ at: rel(), phase: p.phase, completedPersonas: p.completedPersonas, active: p.activeBatches?.length ?? 0, outputTokens: p.outputTokens });
  if (state.message !== lastMessage) { lastMessage = state.message; process.stderr.write(`[${rel().toFixed(1)}s] ${state.message}\n`); }
  if (state.status !== 'running') {
    const personas = state.proposal?.document.cohorts.find(c => c.id === 'gamers')?.personas ?? [];
    writeFileSync(out, JSON.stringify({ size, engine, status: state.status, message: state.message, totalSeconds: rel(), calls, logs, samples, personaBytes: personas.map(p => JSON.stringify(p).length), examplePersona: personas[0] }, null, 1));
    process.stderr.write(`done ${state.status} in ${rel().toFixed(1)}s\n`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}
await service.close();
