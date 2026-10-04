import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startWorkspaceServer } from '../src/workspace.js';
import { agentConnectionConfig } from '../src/agent-config.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'src/cli.ts');

test('an agent connects through the CLI stdio protocol without triggering inference', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-mcp-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = await startWorkspaceServer({ directory,
    getAuthStatus: async () => ({ configured: false, source: 'none' }),
    providerFactory: () => { throw Error('Connecting an agent must not call a model'); },
  });
  t.after(() => workspace.close());
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), cli, 'mcp', '--workspace-url', workspace.url],
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += String(chunk); });
  const client = new Client({ name: 'jev-cli-acceptance', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['get_workspace', 'save_cohort', 'save_pipeline', 'review_study', 'run_study']) assert.ok(names.includes(name), name);
  const result = await client.callTool({ name: 'get_workspace', arguments: {} });
  assert.equal(result.isError, undefined);
  const content = result.content as Array<{ type: string; text: string }>;
  const snapshot = JSON.parse(content.find(item => item.type === 'text')!.text);
  assert.deepEqual(snapshot.document, { version: 1, cohorts: [], pipelines: [] });
  assert.equal(snapshot.activeRun, null);
  assert.equal(snapshot.auth.configured, false);
  assert.equal(stderr, '');
});

test('agent configuration contains no secret and unsafe startup errors stay off stdout', () => {
  const config = agentConnectionConfig('http://127.0.0.1:4180/');
  assert.equal(config.command, process.execPath);
  assert.ok(config.args[0]!.endsWith('/dist/cli.js'));
  assert.deepEqual(config.args.slice(1), ['mcp', '--workspace-url', 'http://127.0.0.1:4180/']);
  assert.doesNotMatch(JSON.stringify(config), /TYPESAFE_API_KEY|Bearer|apiKey/);
  for (const url of ['https://example.com/', 'http://127.0.0.1:4180/path', 'http://user:fake-secret@127.0.0.1:4180/']) {
    assert.throws(() => agentConnectionConfig(url), /local workspace URL/);
  }
  const result = spawnSync(process.execPath, ['--import', 'tsx', cli, 'mcp', '--workspace-url', 'http://user:fake-secret@127.0.0.1:4180/'], { cwd: root, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /MCP_START_FAILED/);
  assert.doesNotMatch(result.stderr, /fake-secret/);
});
