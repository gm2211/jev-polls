import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { OPTION_AGENT_CLIENT, OPTION_AGENT_PANEL } from '../src/option-agent-ui.js';
import { DRAFT_CONTENT_CLIENT } from '../src/draft-content-ui.js';

function harness() {
  const listeners = new Map<string, Function[]>();let mounted=true,rebuildOnSave=false;
  const q: any = { type: 'choice', label: 'Which name?', instructions: 'Custom instructions', criteria: {
    stable_a: { label: 'Alpha', description: 'Old', custom: 'preserved' }, stable_b: { label: 'Beta', description: 'Old Beta' },
  }, extra: 'untouched' };
  const stage: any = { id: 'panel', kind: 'poll', cohort: 'audience', questions: { preference: q }, inputs: {}, dependsOn: [] };
  const p = { id: 'study', cohorts: { audience: 'people' }, stages: [stage] };
  const S: any = { projectId: 'project', pipelineId: p.id, stageId: stage.id, doc: { pipelines: [p] }, revision: 3,
    sections: {}, localEngine: 'chatgpt', chatgptModel: 'draft-model', localLoading: false, localStarting: false, localJob: null, remoteRevision: null, dirty: true, plan: { token: 'reviewed' } };
  const nodes = new Map<string, any>();
  function getElement(id: string): any {
    if (!nodes.has(id)) nodes.set(id, { id, value: '', textContent: '', innerHTML: '', open: false, hidden: false, disabled: false,
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, click() {}, addEventListener() {},
      querySelector: () => getElement('close') });
    return nodes.get(id);
  }
  const requests: any[] = [];
  let nextJob: any = null, nextId = 0, ready = true;
  const context: any = { S, TextEncoder, setTimeout, Error, document: { getElementById: (id:string) => mounted?getElement(id):null, addEventListener: (type:string,fn:Function) => listeners.set(type,[...(listeners.get(type)||[]),fn]) },
    pipeline: () => p, selectedStage: () => p.stages.find(s=>s.id===S.stageId), setupQuestion: (s:any) => Object.entries(s.questions)[0], flushForms() {}, render() {}, say() {},
    draftReady: () => ready, id: () => 'generated_' + ++nextId,
    save: async () => { S.dirty = false; S.revision++;if(rebuildOnSave){nodes.clear();context.agent.optionAgentUpdate()} },
    api: async (url: string, method?: string, body?: any) => { requests.push({ url, method, body }); return typeof nextJob === 'function' ? nextJob(url) : nextJob; },
    optionName: (key: string, value: any) => value && typeof value === 'object' ? value.label ?? key : value ?? key,
    optionDescription: (value: any) => value && typeof value === 'object' ? value.description ?? '' : '',
    esc: (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  };
  new Script(DRAFT_CONTENT_CLIENT + OPTION_AGENT_CLIENT + '\nglobalThis.agent={optionAgentInline,optionAgentPoll,optionAgentOpen,optionAgentReadFile,optionAgentStart,optionAgentApply,optionAgentCancel,optionAgentClose,optionAgentUpdate,optionAgentRecords,optionAgentAction,draft:()=>optionAgentDraft};').runInNewContext(context);
  const result = (criteria: any, status = 'completed') => ({ id: 'job', status, revision: S.revision, proposal: { document: { pipelines: [{ id: 'study', stages: [{ id: 'panel', questions: { preference: { type: 'choice', criteria } } }] }] } } });
  return { ...context.agent, S, q, stage, p, requests, el: (suffix: string) => getElement('optionAgent' + suffix), result,
    mount(value:boolean){mounted=value;if(value){nodes.clear();context.agent.optionAgentUpdate()}},rebuildSave(){rebuildOnSave=true},prompt(value:string){const target=getElement('optionAgentPrompt');target.value=value;for(const fn of listeners.get('input')||[])fn({target})},job(value: any) { nextJob = value; }, ready(value: boolean) { ready = value; } };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const file = (text: string, name = 'notes.md') => ({ name, size: Buffer.byteLength(text), text: async () => text });

test('agent draft sends only user material and target, previews escaped names, and applies only options', async () => {
  const h = harness(), before = plain(h.q);
  h.optionAgentOpen();h.prompt('Extract the candidates');
  await h.optionAgentReadFile(file('Alpha: replacement\nGamma: new candidate', '<img>.md'));
  h.job(h.result({ generated_alpha: { label: 'Alpha', description: 'Replacement' }, generated_gamma: { label: '<script>Gamma</script>', description: '<img src=x>' } }));
  await h.optionAgentStart();
  assert.equal(h.requests.length, 1);
  assert.deepEqual(plain(h.requests[0].body), { projectId: 'project', engine: 'chatgpt', model: 'draft-model', prompt: 'Extract the candidates', revision: 4,
    options: { pipelineId: 'study', stageId: 'panel', questionId: 'preference', material: 'Alpha: replacement\nGamma: new candidate' } });
  assert.deepEqual(plain(h.q), before, 'generation never changes criteria');
  assert.match(h.el('Preview').innerHTML, /&lt;script&gt;Gamma&lt;\/script&gt;/);
  assert.doesNotMatch(h.el('Preview').innerHTML, /<script>|<img/);
  assert.equal(h.el('Filename').textContent, '<img>.md');
  h.optionAgentApply();
  assert.equal(h.S.sections['setup-wizard-study-panel-preference'],'options');
  assert.deepEqual(plain(h.q.criteria), { stable_a: { label: 'Alpha', description: 'Replacement', custom: 'preserved' }, option_generated_1: { label: '<script>Gamma</script>', description: '<img src=x>' } });
  assert.equal(h.q.instructions, before.instructions);assert.equal(h.q.extra, before.extra);assert.equal(h.stage.cohort, 'audience');
  assert.equal(h.S.dirty, true);assert.equal(h.S.plan, null);assert.equal(h.draft(), null);
  assert.ok(h.requests.every((request: any) => !request.url.includes('/run') && !request.url.endsWith('/apply')));
});

test('file-only request works, explicit AI action required, and unavailable AI never requests inference', async () => {
  const h = harness();h.optionAgentOpen();await h.optionAgentReadFile(file('["Alpha","Beta"]', 'candidates.json'));
  assert.equal(h.requests.length, 0);
  h.ready(false);await h.optionAgentStart();assert.equal(h.requests.length, 0);assert.match(h.el('Error').textContent, /Choose drafting AI/);
  h.ready(true);h.job(h.result({ a: { label: 'Alpha' }, b: { label: 'Beta' } }));await h.optionAgentStart();
  assert.match(h.requests[0].body.prompt, /Extract candidate option names/);
});

test('stale target prevents overwrite even when proposal completed', async () => {
  const h = harness();h.optionAgentOpen();const d = h.draft();d.job = h.result({ a: { label: 'Alpha' }, c: { label: 'Gamma' } });d.records = h.optionAgentRecords(d.job, d);
  h.q.instructions = 'Changed elsewhere';const current = JSON.stringify(h.q);
  assert.throws(() => h.optionAgentApply(), /question changed/);assert.equal(JSON.stringify(h.q), current);
  h.optionAgentUpdate();assert.equal(h.el('Apply').disabled, true);
});

test('running job cancellation stays with progress and closing cannot orphan active draft', async () => {
  const h = harness();h.optionAgentOpen();const d = h.draft();d.job = { id: 'job', status: 'running', progress: { phase: 'generating', activity: 'receiving', outputChars: 321 } };h.S.localJob = d.job;
  h.optionAgentUpdate();assert.equal(h.el('Cancel').hidden, false);assert.equal(h.el('Close').hidden, true);assert.match(h.el('Progress').textContent, /321 characters/);
  h.optionAgentClose();assert.equal(h.draft(), d);
  h.job({ id: 'job', status: 'cancelled' });await h.optionAgentCancel();assert.equal(h.S.localJob.status, 'cancelled');assert.equal(h.el('Cancel').hidden, true);
  assert.equal(h.requests[0].url, '/api/agent/jobs/job/cancel');h.optionAgentClose();assert.equal(h.draft(), null);
});

test('running draft polls until ready, never applies automatically, and reports validation progress', async () => {
  const h = harness();h.optionAgentOpen();h.prompt('Suggest alternatives');const before = JSON.stringify(h.q);
  const queue = [{ id: 'job', status: 'running', progress: { phase: 'validating' } }, h.result({ a: { label: 'Alpha' }, g: { label: 'Gamma', description: 'New name' } })];
  h.job(() => queue.shift());const pending = h.optionAgentStart();
  await new Promise(resolve => setTimeout(resolve, 10));assert.match(h.el('Progress').textContent, /Checking option names/);assert.equal(h.el('Cancel').hidden, false);
  await pending;assert.equal(h.draft().job.status, 'completed');assert.equal(h.el('Apply').hidden, false);assert.equal(JSON.stringify(h.q), before);
  assert.deepEqual(h.requests.map((request: any) => request.url), ['/api/agent/jobs', '/api/agent/jobs/job']);
});

test('files reject oversized, unsupported, empty or invalid UTF-8 inputs, without overwriting accepted material', async () => {
  const h = harness();h.optionAgentOpen();await h.optionAgentReadFile(file('Accepted text'));
  for (const candidate of [file('binary', 'data.pdf'), { ...file('large'), size: 262145 }, file(''), file('bad\u0000text'), file('bad\ufffdtext')]) {
    await h.optionAgentReadFile(candidate);assert.equal(h.draft().material, 'Accepted text');assert.equal(h.el('Error').hidden, false);
  }
  let complete!: (value: string) => void;
  const late = h.optionAgentReadFile({ name: 'late.txt', size: 10, text: () => new Promise<string>(resolve => { complete = resolve; }) });
  await h.optionAgentReadFile(file('Newest text'));complete('Older text');await late;assert.equal(h.draft().material, 'Newest text');
});

test('agent proposals validate distinct option count and review paginates five records', () => {
  const h = harness();h.optionAgentOpen();const d = h.draft();
  assert.throws(() => h.optionAgentRecords(h.result({ a: { label: 'Only' } }), d), /2–255/);
  assert.throws(() => h.optionAgentRecords(h.result({ a: { label: 'Same' }, b: { label: 'Same' } }), d), /different/);
  assert.throws(() => h.optionAgentRecords(h.result({ a: { label: '' }, b: { label: 'Beta' } }), d), /nonempty/);
  d.job = h.result(Object.fromEntries(Array.from({ length: 6 }, (_, i) => ['option_' + i, { label: 'Name ' + i, description: 'Definition ' + i }])));
  d.records = h.optionAgentRecords(d.job, d);h.optionAgentUpdate();assert.match(h.el('Preview').innerHTML, /1–5 of 6/);
  h.optionAgentAction('option-agent-next');assert.match(h.el('Preview').innerHTML, /6–6 of 6/);assert.doesNotMatch(h.el('Preview').innerHTML, /Name 0/);
  assert.match(OPTION_AGENT_PANEL, /Drop notes, CSV or JSON/);
});

test('Prepare waits for pending file read and sends exactly reviewed material', async () => {
  const h = harness();h.optionAgentOpen();h.prompt('Extract candidates');
  let finish!: (value: string) => void;
  const reading = h.optionAgentReadFile({ name: 'delayed.md', size: 30, text: () => new Promise<string>(resolve => { finish = resolve; }) });
  assert.equal(h.draft().reading, true);assert.equal(h.el('Start').disabled, true);
  await h.optionAgentStart();assert.equal(h.requests.length, 0);assert.match(h.el('Error').textContent, /finish reading/);
  finish('Alpha: first\nBeta: second');await reading;
  assert.equal(h.draft().reading, false);assert.equal(h.el('Start').disabled, false);
  h.job(h.result({ a: { label: 'Alpha' }, b: { label: 'Beta' } }));await h.optionAgentStart();
  assert.equal(h.requests[0].body.options.material, 'Alpha: first\nBeta: second');
});

test('replaced or removed pending reads cannot clear current read gate or attach unsent material', async () => {
  const h = harness();h.optionAgentOpen();h.prompt('Suggest names');
  let first!: (value: string) => void, second!: (value: string) => void;
  const oldRead = h.optionAgentReadFile({ name: 'old.txt', size: 10, text: () => new Promise<string>(resolve => { first = resolve; }) });
  const newRead = h.optionAgentReadFile({ name: 'new.txt', size: 10, text: () => new Promise<string>(resolve => { second = resolve; }) });
  first('Old text');await oldRead;assert.equal(h.draft().reading, true);assert.equal(h.el('Start').disabled, true);
  h.optionAgentAction('option-agent-remove-file');assert.equal(h.draft().reading, false);
  h.job(h.result({ a: { label: 'Alpha' }, b: { label: 'Beta' } }));await h.optionAgentStart();
  second('Late text');await newRead;assert.equal(h.draft().material, '');assert.equal(h.draft().filename, '');
  assert.equal(h.requests[0].body.options.material, undefined);
});


test('inline request survives DOM recreation on save and section navigation',async()=>{
  const h=harness();h.optionAgentOpen();h.prompt('Keep exactly this request');h.rebuildSave();
  h.mount(false);h.mount(true);assert.equal(h.el('Prompt').value,'Keep exactly this request');
  h.job(h.result({a:{label:'Alpha'},b:{label:'Beta'}}));await h.optionAgentStart();
  assert.equal(h.requests[0].body.prompt,'Keep exactly this request');
  assert.equal(h.el('Apply').hidden,false);assert.doesNotMatch(OPTION_AGENT_PANEL,/<dialog|<form/);
});

test('background result and file stay with original question while another panel is mounted',async()=>{
  const h=harness();h.optionAgentOpen();h.prompt('Original request');const first=h.draft();
  let finish!:(text:string)=>void;
  const reading=h.optionAgentReadFile({name:'original.md',size:10,text:()=>new Promise<string>(resolve=>{finish=resolve})});
  const second:any={id:'second',kind:'poll',questions:{next:{type:'choice',label:'Follow-up?',criteria:{a:'A',b:'B'}}}};
  h.p.stages.push(second);h.S.stageId=second.id;h.optionAgentInline(h.p,second,'next',second.questions.next);h.mount(true);
  finish('Original material');await reading;assert.equal(first.material,'Original material');assert.equal(h.draft().material,'');assert.equal(h.el('Filename').textContent,'');
  first.job={id:'job',status:'running'};h.S.localJob=null;h.prompt('Second request');await h.optionAgentStart();
  assert.equal(h.requests.length,0);assert.match(h.draft().error,/Another draft is running/);
  h.job(h.result({a:{label:'Alpha'},b:{label:'Beta'}}));h.mount(false);await h.optionAgentPoll(first);
  assert.equal(first.job.status,'completed');assert.equal(first.records.length,2);
  h.S.stageId=h.stage.id;h.optionAgentInline(h.p,h.stage,'preference',h.q);h.mount(true);
  assert.equal(h.el('Prompt').value,'Original request');assert.equal(h.el('Apply').hidden,false);
  assert.equal(h.q.criteria.stable_b.label,'Beta','completed result remains unapplied');
});


test('failed request releases readiness gate for newly mounted question',async()=>{
  const h=harness();h.optionAgentOpen();h.prompt('First request');let reject!:(error:Error)=>void;
  h.job(()=>new Promise((_,fail)=>{reject=fail}));const pending=h.optionAgentStart();await new Promise(resolve=>setTimeout(resolve,0));
  const second:any={id:'second',kind:'poll',questions:{next:{type:'choice',label:'Next?',criteria:{a:'A',b:'B'}}}};
  h.p.stages.push(second);h.S.stageId=second.id;h.optionAgentInline(h.p,second,'next',second.questions.next);h.mount(true);h.prompt('Second request');
  assert.equal(h.el('Start').disabled,true);reject(Error('Provider unavailable'));await pending;
  assert.equal(h.S.localLoading,false);assert.equal(h.el('Start').disabled,false);assert.equal(h.draft().error,null);
});
