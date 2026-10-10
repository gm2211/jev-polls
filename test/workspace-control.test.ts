import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createResearchMcpServer } from '../src/mcp.js';
import { WorkspaceControl } from '../src/workspace-control.js';

const root = fileURLToPath(new URL('..', import.meta.url));
// The test runner's context variable changes how a child node process handles SIGTERM.
const { NODE_TEST_CONTEXT: _context, ...childEnv } = process.env;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise(resolve => server.close(resolve));
  return address.port;
}

test('workspace_server starts, stops and restarts a real workspace without shell access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-control-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/`;
  const children: ChildProcess[] = [];
  t.after(() => { for (const child of children) child.kill('SIGKILL'); });
  let launches = 0;
  const server = createResearchMcpServer(url, { waitMs: 30_000, launch: launchPort => {
    launches++;
    children.push(spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'workspace', '--port', String(launchPort), '--directory', directory], { cwd: root, stdio: 'ignore', env: childEnv }));
  } });
  const client = new Client({ name: 'control-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const act = async (action: string) => {
    const response = await client.callTool({ name: 'workspace_server', arguments: { action } });
    assert.equal(response.isError, undefined, JSON.stringify(response.content));
    return response.structuredContent as { running: boolean; pid?: number; started?: boolean; stopped?: boolean; restarted?: boolean };
  };

  assert.equal((await act('status')).running, false);
  assert.equal((await client.callTool({ name: 'get_workspace', arguments: {} })).isError, true);
  const started = await act('start');
  assert.equal(started.running, true); assert.equal(started.started, true); assert.equal(started.pid, children[0].pid);
  assert.equal((await act('start')).started, false); assert.equal(launches, 1);
  assert.equal((await client.callTool({ name: 'get_workspace', arguments: {} })).isError, undefined);
  const restarted = await act('restart');
  assert.equal(restarted.restarted, true); assert.equal(restarted.running, true); assert.equal(restarted.pid, children[1].pid);
  const stopped = await act('stop');
  assert.equal(stopped.stopped, true); assert.equal((await act('status')).running, false);
});

test('update refuses a dirty checkout before pulling', async () => {
  const calls: string[] = [];
  const run = (command: string, args: string[]) => {
    calls.push([command, ...args].join(' '));
    return { status: 0, stdout: args[0] === 'status' ? ' M src/mcp.ts\n' : '', stderr: '' } as SpawnSyncReturns<string>;
  };
  const control = new WorkspaceControl(new URL(`http://127.0.0.1:${await freePort()}/`), root, { run });
  await assert.rejects(control.update(), /uncommitted changes/);
  assert.deepEqual(calls, ['git status --porcelain --untracked-files=no']);
});
