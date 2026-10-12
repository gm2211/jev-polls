import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { COMMAND_CLIENT } from '../src/workspace-command-ui.js';
import { DRAFT_CONTENT_CLIENT } from '../src/draft-content-ui.js';

function harness(overrides: Record<string, unknown> = {}) {
  const listeners = new Map<string, Function>();
  const S: any = { snap: {}, projectId: 'one', tab: 'studies', sections: {}, localPrompt: '', localJob: null, localStart: null, localLoading: false, remoteRevision: null,
    doc: { projects: [{ id: 'one', name: 'Games', pipelineIds: ['names'], cohortIds: ['gamers'] }, { id: 'two', name: 'Food', pipelineIds: ['food'], cohortIds: [] }],
      pipelines: [{ id: 'names', name: 'Naming study', stages: [{ id: 'ask', label: 'Name preference', kind: 'poll' }] }, { id: 'food', name: 'Taste study', stages: [{ id: 'taste', label: 'Taste choice', kind: 'poll' }] }], cohorts: [{ id: 'gamers', name: '<Gamers>' }] } };
  const calls: string[] = [];
  const context: any = { S, TextEncoder, document: { addEventListener(type: string, fn: Function) { listeners.set(type, fn); }, querySelector: () => null, getElementById: () => null, activeElement: { isConnected: false } },
    root: { querySelector: () => null, querySelectorAll: () => [], classList: { toggle() {} } },
    esc: (x: unknown) => String(x).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    attr: (x: unknown) => String(x).replace(/"/g, '&quot;'), icon: () => '',
    project: () => S.doc.projects.find((p: any) => p.id === S.projectId),
    projectPipelines: () => S.doc.pipelines.filter((p: any) => context.project().pipelineIds.includes(p.id)),
    pipeline: () => S.doc.pipelines.find((p: any) => p.id === S.pipelineId),
    flushForms() { calls.push('flush'); if (S.invalid) throw Error('Invalid field'); }, render() { calls.push('render'); },
    selectProject(id: string) { calls.push('project:' + id); S.projectId = id; }, act(_: unknown, el: any) { calls.push('act:' + el.dataset.act); },
    audienceQueued: () => (context.queued ?? []), audienceNext: async () => { calls.push('audience-next'); return true; },
    loadLocalAgents: async () => {}, draftReady: () => true, draftCancelButton: () => '', proposalReview: () => '<p>Review</p>',
    fail(e: Error) { calls.push('error:' + e.message); },
    stepTitle: (p: any, st: any) => (p.stages.findIndex((x: any) => x.id === st.id) + 1) + '. ' + (st.label || Object.values(st.questions || {})[0]?.['label' as never] || 'Untitled question'),
    optionName: (k: string, v: any) => v && typeof v === 'object' ? v.label : v ?? k,
    flowInputs: (_: any, st: any) => Array.isArray(st.inputs) ? st.inputs.map((x: any) => [x.stage, x]) : Object.entries(st.inputs || {}),
    cohort: () => null, retainSelections() {}, say(m: string) { calls.push('say:' + m); }, sayUndo(m: string) { calls.push('undo-toast:' + m); },
    save: async () => { calls.push('save'); S.dirty = false; },
    startDraftJob: async (details: () => any) => { const body = details(); calls.push('draft-job'); context.drafted = body; },
    applyLocalProposal: async () => { S.proposalApplied = true; const p = { id: 'new', name: 'New study', stages: [{ id: 'newstep', kind: 'poll' }] }; S.doc.pipelines.push(p); context.project().pipelineIds.push(p.id); },
  };
  Object.assign(context, overrides);
  new Script(DRAFT_CONTENT_CLIENT + COMMAND_CLIENT + '\nglobalThis.command={commandScope,studyEdits,undoAssistantProposal,draftTarget,commandPalette,draftAttachRead,draftMaterial,commandBeforeRender,commandEntries,commandExecute,commandInput,commandAction,commandOpen,commandApplyProposal,draftSidePanel,commandResults,commandJobVisible,commandAskAI,commandClose,commandChoices,state:commandState};').runInNewContext(context);
  return { ...context.command, S, calls, context, key: listeners.get('keydown')! };
}

test('commands search every project and navigate to an exact step after preserving edits', () => {
  const h = harness(); h.commandInput({ target: { id: 'commandSearch', value: 'Food taste choice' } });
  const matches = h.commandEntries(); assert.equal(matches.length, 1); assert.equal(matches[0].stage, 'taste');
  h.commandExecute(matches[0].id);
  assert.deepEqual(h.calls.slice(0, 2), ['flush', 'project:two']); assert.equal(h.S.pipelineId, 'food'); assert.equal(h.S.stageId, 'taste'); assert.equal(h.S.sections.pipeline, 'flow');
});

test('keyboard shortcut preserves dirty forms and refuses navigation when validation fails', () => {
  const h = harness(); let prevented = false;
  h.S.invalid = true;
  h.key({ metaKey: true, key: 'k', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(h.state.open, false); assert.deepEqual(h.calls, ['flush', 'error:Invalid field']);
  h.S.invalid = false; h.key({ ctrlKey: true, key: 'k', preventDefault() {} }); assert.equal(h.state.open, true);
  h.key({ key: 'Escape', preventDefault() {} }); assert.equal(h.state.open, false);
});

test('command pagination keeps all matches reachable and escapes cohort labels', () => {
  const h = harness(); assert.match(h.commandResults(), /Next destinations/);
  h.commandInput({ target: { id: 'commandSearch', value: 'gamers' } }); assert.match(h.commandResults(), /&lt;Gamers&gt;/);
  h.commandInput({ target: { id: 'commandSearch', value: 'missing' } }); assert.match(h.commandResults(), /Ask AI: missing/);
});

test('draft panel retains prompt and underlying view; applying opens resulting pipeline', async () => {
  const h = harness(); h.S.pipelineId = 'names'; h.S.localPrompt = 'Custom research request';
  h.commandAction('draft-panel-open', { dataset: {} }); assert.equal(h.commandJobVisible(), true); assert.equal(h.S.tab, 'studies');
  assert.match(h.draftSidePanel(), /Custom research request/);
  h.commandAction('draft-panel-close', { dataset: {} }); assert.equal(h.S.localPrompt, 'Custom research request'); assert.equal(h.commandJobVisible(), false);
  h.commandAction('draft-panel-open', { dataset: {} }); await h.commandApplyProposal();
  assert.equal(h.S.pipelineId, 'new'); assert.equal(h.S.stageId, 'newstep'); assert.equal(h.S.sections.pipeline, 'flow'); assert.equal(h.commandJobVisible(), false);
});

test('opening another project never exposes first project drafting inspector', () => {
  const h = harness(); h.commandAction('draft-panel-open', { dataset: {} }); h.S.projectId = 'two'; assert.equal(h.commandJobVisible(), false); assert.equal(h.draftSidePanel(), '');
});


test('command destinations reset stale cohort inspectors and open result connections', async () => {
  const h=harness();h.S.sections['flow-inspector']='cohort';h.S.flowCohortPick=true;
  h.commandExecute('stage:one:names:ask');assert.equal(h.S.sections['flow-inspector'],'question');assert.equal(h.S.flowCohortPick,false);
  h.S.doc.pipelines[0].stages.push({id:'result',label:'Result',kind:'aggregate'});
  h.commandExecute('stage:one:names:result');assert.equal(h.S.sections['flow-inspector'],'connections');
  h.S.sections['flow-inspector']='cohort';h.S.flowCohortPick=true;
  await h.commandApplyProposal();assert.equal(h.S.sections['flow-inspector'],'question');assert.equal(h.S.flowCohortPick,false);
});


test('keyboard moves across pages, supports Home/End and ignores composition', () => {
  const h=harness();h.commandOpen();
  const press=(key:string,extra={})=>h.key({key,target:{id:'commandSearch'},preventDefault(){},...extra});
  for(let i=0;i<6;i++)press('ArrowDown');
  assert.equal(h.state.page,1);assert.equal(h.state.index,0);
  press('ArrowUp');assert.equal(h.state.page,0);assert.equal(h.state.index,5);
  press('End');assert.equal(h.state.page*6+h.state.index,h.commandChoices().length-1);
  press('Home');assert.equal(h.state.index,0);assert.equal(h.state.page,0);
  press('ArrowDown',{isComposing:true});assert.equal(h.state.index,0);
});

test('AI receives unsaved draft, navigates validated destination without saving', async () => {
  const requests:any[]=[];
  const h=harness({api:async(path:string,method:string,body:any)=>{requests.push({path,method,body});return {status:'completed',commandResult:{kind:'navigate',destination:'stage:two:food:taste'}}}});
  h.commandOpen();h.commandInput({target:{id:'commandSearch',value:'open the food preference question'}});
  await h.commandAskAI();
  assert.equal(requests[0].path,'/api/agent/commands');assert.equal(requests[0].body.document,h.S.doc);
  assert.equal(h.S.projectId,'two');assert.equal(h.S.stageId,'taste');assert.equal(h.state.open,false);
});

test('AI failure stays visible and keeps query for retry', async () => {
  const h=harness({api:async()=>{throw Error('Provider unavailable')}});h.commandOpen();
  h.commandInput({target:{id:'commandSearch',value:'create something'}});await h.commandAskAI();
  assert.match(h.state.error,/Provider unavailable/);assert.equal(h.state.query,'create something');assert.equal(h.state.open,true);assert.equal(h.state.busy,false);
});

test('AI result cannot navigate after query changes or workspace draft changes', async () => {
  let resolve!:Function;const h=harness({api:()=>new Promise(r=>{resolve=r})});h.commandOpen();
  h.commandInput({target:{id:'commandSearch',value:'open food'}});const request=h.commandAskAI();
  h.commandInput({target:{id:'commandSearch',value:'stay here'}});resolve({status:'completed',commandResult:{kind:'navigate',destination:'project:two'}});await request;
  assert.equal(h.S.projectId,'one');assert.equal(h.state.query,'stay here');
  const next=h.commandAskAI();h.S.doc.projects[0].name='Unsaved edit';resolve({status:'completed',commandResult:{kind:'navigate',destination:'project:two'}});await next;
  assert.equal(h.S.projectId,'one');assert.match(h.state.error,/workspace changed/);
});

test('AI creation opens prefilled review flow; search only displays validated candidates', async () => {
  let result:any={kind:'draft',target:'study',prompt:'Compare snack names'};
  const h=harness({api:async()=>({status:'completed',commandResult:result})});h.commandOpen();
  h.commandInput({target:{id:'commandSearch',value:'make a snack study'}});await h.commandAskAI();
  assert.equal(h.S.localPrompt,'Compare snack names');assert.equal(h.commandJobVisible(),true);
  result={kind:'search',query:'food preference',destinations:['stage:two:food:taste']};h.commandOpen();h.commandInput({target:{id:'commandSearch',value:'find food questions'}});await h.commandAskAI();
  assert.equal(h.commandEntries().length,1);assert.equal(h.commandEntries()[0].stage,'taste');assert.equal(h.S.projectId,'one');
});


test('manual navigation cancels a pending AI command before reopening the palette',async()=>{
  let resolve!:Function;const h=harness({api:()=>new Promise(r=>{resolve=r})});
  h.commandOpen();h.commandInput({target:{id:'commandSearch',value:'Naming'}});
  const pending=h.commandAskAI();assert.equal(h.state.busy,true);
  h.commandExecute('pipeline:one:names');assert.equal(h.state.busy,false);assert.equal(h.state.open,false);
  h.commandOpen();
  resolve({status:'completed',commandResult:{kind:'navigate',destination:'project:two'}});await pending;
  assert.equal(h.S.projectId,'one');assert.equal(h.S.pipelineId,'names');assert.equal(h.state.open,true);
});

test('AI settings removes palette before opening its native dialog',()=>{
  const h=harness();h.commandOpen();h.calls.length=0;
  h.commandExecute('settings');
  assert.equal(h.state.open,false);assert.equal(h.state.busy,false);
  assert.ok(h.calls.indexOf('render')>=0);
  assert.ok(h.calls.indexOf('render')<h.calls.indexOf('act:ai-open'));
});

const textFile = (text: string, name = 'names.json') => ({ name, size: Buffer.byteLength(text), text: async () => text });

test('attaching a file shows its name, sends it with the request, and removing it clears it', async () => {
  const h = harness(); h.commandAction('draft-panel-open', { dataset: {} });
  assert.match(h.draftSidePanel(), /Drop a file here, or choose file/); assert.deepEqual(JSON.parse(JSON.stringify(h.draftMaterial())), {});
  await h.draftAttachRead(textFile('[["Deterrent","What the arsenal is for."]]', '<names>.json'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.draftMaterial())), { material: '[["Deterrent","What the arsenal is for."]]', materialName: '<names>.json' });
  assert.match(h.draftSidePanel(), /&lt;names&gt;\.json/); assert.match(h.draftSidePanel(), /Remove file/);
  h.commandAction('draft-attach-remove', { dataset: {} }); assert.deepEqual(JSON.parse(JSON.stringify(h.draftMaterial())), {}); assert.match(h.draftSidePanel(), /Drop a file here/);
});

test('a rejected file keeps the previous attachment and explains why', async () => {
  const h = harness(); h.commandAction('draft-panel-open', { dataset: {} });
  await h.draftAttachRead(textFile('good')); await h.draftAttachRead(textFile('x', 'photo.png'));
  assert.equal(h.draftMaterial().material, 'good'); assert.match(h.draftSidePanel(), /Choose a TXT, Markdown, CSV or JSON file/);
});

test('opening the drafting panel closes the step panel, and opening a step closes the drafting panel', () => {
  const h = harness(); h.S.flowPanel = true;
  h.commandAction('draft-panel-open', { dataset: {} }); assert.equal(h.S.flowPanel, false); assert.equal(h.commandJobVisible(), true);
  h.commandBeforeRender(); assert.equal(h.commandJobVisible(), true);
  h.S.flowPanel = true; h.commandBeforeRender(); assert.equal(h.commandJobVisible(), false);
});

test('a recovered job shows the file it was sent with, read-only, until a new file is attached', async () => {
  const h = harness(); h.S.localJob = { id: 'job', status: 'completed', materialName: 'name-picks-for-jev.json' };
  h.commandAction('draft-panel-open', { dataset: {} });
  assert.match(h.draftSidePanel(), /Sent with this request: <strong title="name-picks-for-jev\.json">name-picks-for-jev\.json<\/strong>/);
  assert.doesNotMatch(h.draftSidePanel(), /Remove file/); assert.deepEqual(JSON.parse(JSON.stringify(h.draftMaterial())), {});
  await h.draftAttachRead(textFile('fresh', 'new.json'));
  assert.doesNotMatch(h.draftSidePanel(), /Sent with this request/); assert.match(h.draftSidePanel(), /new\.json/);
});

test('applying a proposal that asks for audiences hands over to the audience queue instead of opening the first step', async () => {
  const withQueue = harness({ queued: [{ cohortId: 'gamers' }] }); withQueue.S.pipelineId = 'names'; withQueue.S.stageId = 'ask';
  withQueue.commandAction('draft-panel-open', { dataset: {} }); await withQueue.commandApplyProposal();
  assert.ok(withQueue.calls.includes('audience-next'));
  assert.equal(withQueue.S.pipelineId, 'names', 'the queue chooses the step to show'); assert.equal(withQueue.commandJobVisible(), false);
});


test('palette shows where it is and a study scope sends the request to the assistant with that study in focus', async () => {
  const requests: any[] = [];
  const h = harness({ api: async (path: string) => { requests.push(path); return {}; } });
  h.S.pipelineId = 'names'; h.S.stageId = 'ask';
  h.commandOpen();
  assert.deepEqual({ kind: h.commandScope().kind, name: h.commandScope().name }, { kind: 'study', name: 'Naming study' });
  assert.match(h.commandPalette(), /class="command-scope"[\s\S]*Study[\s\S]*Naming study/);
  assert.match(h.commandPalette(), /ask AI to change this study/);
  h.S.flowPanel = true; assert.equal(h.commandScope().kind, 'step'); assert.equal(h.commandScope().stageId, 'ask');
  h.commandInput({ target: { id: 'commandSearch', value: 'add a follow-up asking why' } });
  assert.match(h.commandChoices()[0].label, /^Ask AI to change this step: add a follow-up asking why/);
  await h.commandAskAI();
  assert.deepEqual(requests, [], 'a study edit skips the command router');
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.drafted)), { prompt: 'add a follow-up asking why', focus: { pipelineId: 'names', stageId: 'ask' } });
  assert.equal(h.state.open, false); assert.equal(h.commandJobVisible(), true); assert.equal(h.S.flowPanel, false);
  assert.match(h.draftSidePanel(), /Edit with assistant[\s\S]*Changing[\s\S]*Naming study · 1\. Name preference/);
});

test('clearing the scope searches everywhere and asks the router again', async () => {
  const requests: any[] = [];
  const h = harness({ api: async (path: string) => { requests.push(path); return { status: 'completed', commandResult: { kind: 'search', query: 'x', destinations: [] } }; } });
  h.S.pipelineId = 'names'; h.commandOpen();
  h.key({ key: 'Backspace', target: { id: 'commandSearch', value: '' }, preventDefault() {} });
  assert.equal(h.commandScope(), null); assert.doesNotMatch(h.commandPalette(), /command-scope"/);
  h.commandInput({ target: { id: 'commandSearch', value: 'make a snack study' } }); await h.commandAskAI();
  assert.deepEqual(requests, ['/api/agent/commands']);
  h.commandClose(); h.commandOpen(); assert.equal(h.commandScope().kind, 'study', 'reopening starts from the current view again');
  h.S.tab = 'runs'; assert.equal(h.commandScope().kind, 'project');
});

test('a study edit needs a drafting connection and says so in the palette', async () => {
  const h = harness({ draftReady: () => false }); h.S.pipelineId = 'names'; h.commandOpen();
  h.commandInput({ target: { id: 'commandSearch', value: 'rename the first step' } }); await h.commandAskAI();
  assert.match(h.state.error, /Connect a drafting provider/); assert.equal(h.state.open, true); assert.equal(h.context.drafted, undefined);
});

test('study edits read as plain step-by-step changes', () => {
  const h = harness();
  const doc = { cohorts: [{ id: 'gamers', name: 'Gamers' }, { id: 'parents', name: 'Parents' }] };
  const before = { name: 'Naming study', description: '', cohorts: { a: 'gamers', b: 'parents' }, stages: [
    { id: 'ask', label: 'Name vote', kind: 'poll', cohort: 'a', dependsOn: [], questions: { pick: { type: 'choice', label: 'Which name?', instructions: '', criteria: { nova: 'Nova', orbit: 'Orbit' } } } },
    { id: 'old', label: 'Old step', kind: 'poll', cohort: 'a', dependsOn: [], questions: { q: { type: 'noul', label: 'Old?', instructions: '' } } }] };
  const after = { ...before, stages: [
    { ...before.stages[0], label: 'Name pick', cohort: 'b', questions: { pick: { type: 'choice', label: 'Which name fits best?', instructions: '', criteria: { nova: 'Nova', comet: 'Comet' } } } },
    { id: 'why', label: 'Why', kind: 'poll', cohort: 'a', dependsOn: ['ask'], inputs: { winner: { stage: 'ask', question: 'pick' } }, questions: { q: { type: 'noul', label: 'Why?', instructions: '' } } }] };
  assert.deepEqual([...h.studyEdits(before, after, doc, doc)], [
    'Step 1 “Name pick”: renamed “Name vote” → “Name pick”; question “Which name?” → “Which name fits best?”; adds option “Comet”; drops option “Orbit”; asks “Parents” instead of “Gamers”',
    'Added Step 2: “Why”',
    'Removed step “Old step”',
  ]);
});

test('applying an assistant edit can be undone, and only while nothing changed since', async () => {
  const h = harness(); h.S.pipelineId = 'names';
  const original = JSON.stringify(h.S.doc);
  h.commandAction('draft-panel-open', { dataset: {} });
  await h.commandApplyProposal();
  assert.ok(h.calls.some((c: string) => c.startsWith('undo-toast:Applied the assistant’s changes')));
  assert.equal(h.S.stepUndo.at(-1).kind, 'assistant');
  assert.equal(h.undoAssistantProposal(h.S.stepUndo.at(-1)), true);
  assert.equal(JSON.stringify(h.S.doc), original); assert.equal(h.S.pipelineId, 'names'); assert.ok(h.calls.includes('save'));
  h.commandAction('draft-panel-open', { dataset: {} }); h.S.proposalApplied = false;
  await h.commandApplyProposal(); h.S.doc.pipelines[0].name = 'Edited after';
  h.calls.length = 0; h.undoAssistantProposal(h.S.stepUndo.at(-1));
  assert.equal(h.S.doc.pipelines[0].name, 'Edited after'); assert.equal(h.S.stepUndo.length, 0); assert.ok(h.calls.some((c: string) => /can no longer be undone/.test(c)));
});
