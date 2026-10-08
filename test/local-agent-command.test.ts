import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCommandTargets, LocalAgentService, type LocalAgentJob } from '../src/local-agent.js';
import type { ChatGptDraftClient } from '../src/chatgpt.js';
import type { WorkspaceDocument } from '../src/workspace-types.js';

const document: WorkspaceDocument = {
  version: 1,
  cohorts: [],
  pipelines: [],
};

async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'jev-command-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function finished(service: LocalAgentService, job: LocalAgentJob) {
  for (let index = 0; index < 100; index++) {
    const current = service.get(job.id)!;
    if (current.status !== 'running') return current;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('Command did not finish');
}

test('AI command searches validated targets, receives search results, then navigates by exact ID', async t => {
  const root = await setup(t);
  const calls: string[] = [];
  const client = {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async ({ input }: { input: string }) => {
      calls.push(input);
      const action = calls.length === 1 ? { kind: 'search', query: 'projects' } : { kind: 'navigate', destination: 'projects' };
      return { text: JSON.stringify({ documentJson: JSON.stringify(action), explanation: 'Opening run history.' }) };
    },
  } as ChatGptDraftClient;
  const service = new LocalAgentService({ chatgpt: client, temporaryRoot: root });
  t.after(() => service.close());
  const job = service.start({ engine: 'chatgpt', model: 'draft-model', prompt: 'Open projects', revision: 4, document, command: true, commandTargets: buildCommandTargets(document, undefined) });
  const result = await finished(service, job);
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /Search tool found these exact workspace targets/);
  assert.match(calls[1]!, /projects/);
  assert.deepEqual(result.commandResult, { kind: 'navigate', destination: 'projects' });
  assert.equal(result.proposal, undefined);
});

test('destination catalog matches global and selected-project availability', () => {
  const globalTargets = buildCommandTargets(document, undefined);
  assert.deepEqual(globalTargets.map(target => target.id), ['projects', 'new-project', 'settings']);
  const current: WorkspaceDocument = {
    version: 1, cohorts: [],
    pipelines: [{ version: 1, id: 'existing-study', name: 'Existing study', description: 'Description', context: {}, cohorts: {}, stages: [] }],
    projects: [{ id: 'research', name: 'Research', description: '', cohortIds: [], pipelineIds: ['existing-study'] }],
  };
  const currentTargets = buildCommandTargets(current, 'research', [{ id: 'run-id', projectId: 'research', pipelineId: 'existing-study', pipelineName: 'Existing study', status: 'completed' }]);
  assert.ok(currentTargets.some(target => target.id === 'draft'));
  assert.ok(currentTargets.some(target => target.id === 'run:research:run-id'));
  assert.ok(!currentTargets.some(target => target.id === 'new-study'));
  assert.ok(!globalTargets.some(target => target.id === 'draft' || target.id === 'new-cohort' || target.id === 'runs'));
});

test('AI command rejects unknown navigation ID and returns bounded local search result', async t => {
  const root = await setup(t);
  const client = {
    status: async () => ({ connected: true, planEnabled: true }),
    generate: async () => ({ text: JSON.stringify({ documentJson: JSON.stringify({ kind: 'navigate', destination: 'secret:elsewhere' }), explanation: 'Go there.' }) }),
  } as unknown as ChatGptDraftClient;
  const service = new LocalAgentService({ chatgpt: client, temporaryRoot: root });
  t.after(() => service.close());
  const job = service.start({ engine: 'chatgpt', model: 'draft-model', prompt: 'Open secret destination', revision: 2, document, command: true, commandTargets: buildCommandTargets(document, undefined) });
  const result = await finished(service, job);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.commandResult, { kind: 'search', query: 'secret:elsewhere', destinations: [] });
});

test('global command prepares a named project without a selected project or saved mutation', async t => {
  const root = await setup(t);
  const current: WorkspaceDocument = { version: 1, projects: [], cohorts: [], pipelines: [] };
  const client = { status: async () => ({ connected: true, planEnabled: true }), generate: async () => ({ text: JSON.stringify({ documentJson: JSON.stringify({ kind: 'draft', target: 'project', name: 'Snack naming', prompt: 'Compare snack names with synthetic adults.' }), explanation: 'Review the project details.' }) }) } as unknown as ChatGptDraftClient;
  const service = new LocalAgentService({ chatgpt: client, temporaryRoot: root });t.after(() => service.close());
  const result = await finished(service, service.start({engine:'chatgpt',model:'draft-model',prompt:'Create Snack naming',revision:0,document:current,command:true,commandTargets:buildCommandTargets(current,undefined)}));
  assert.equal(result.status,'completed');assert.equal(result.commandResult?.kind,'draft');
  assert.equal((result.commandResult as any).name,'Snack naming');assert.equal(result.proposal,undefined);assert.deepEqual(current.projects,[]);
});

test('large command catalog stays searchable with bounded provider context and no repeated search loop', async t => {
  const root=await setup(t);const prompts:string[]=[];
  const client={status:async()=>({connected:true,planEnabled:true}),generate:async({input}:{input:string})=>{prompts.push(input);return {text:JSON.stringify({documentJson:JSON.stringify({kind:'search',query:'Needle'}),explanation:'Find candidates.'})}}} as ChatGptDraftClient;
  const service=new LocalAgentService({chatgpt:client,temporaryRoot:root});t.after(()=>service.close());
  const targets=Array.from({length:20_010},(_,i)=>({id:'persona:'+i,label:i===20_009?'Needle':'Person '+i,detail:'Synthetic person',search:'Profile details '.repeat(50)}));
  const result=await finished(service,service.start({engine:'chatgpt',model:'draft-model',prompt:'Find Needle',revision:1,document,command:true,commandTargets:targets}));
  assert.equal(result.status,'completed');assert.deepEqual(result.commandResult,{kind:'search',query:'Needle',destinations:['persona:20009']});
  assert.equal(prompts.length,2);assert.ok(prompts.every(prompt=>Buffer.byteLength(prompt)<50_000));
});
