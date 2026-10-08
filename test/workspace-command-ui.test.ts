import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { COMMAND_CLIENT } from '../src/workspace-command-ui.js';

function harness() {
  const listeners = new Map<string, Function>();
  const S: any = { snap: {}, projectId: 'one', tab: 'studies', sections: {}, localPrompt: '', localJob: null, localStart: null, localLoading: false, remoteRevision: null,
    doc: { projects: [{ id: 'one', name: 'Games', pipelineIds: ['names'], cohortIds: ['gamers'] }, { id: 'two', name: 'Food', pipelineIds: ['food'], cohortIds: [] }],
      pipelines: [{ id: 'names', name: 'Naming study', stages: [{ id: 'ask', label: 'Name preference', kind: 'poll' }] }, { id: 'food', name: 'Taste study', stages: [{ id: 'taste', label: 'Taste choice', kind: 'poll' }] }], cohorts: [{ id: 'gamers', name: '<Gamers>' }] } };
  const calls: string[] = [];
  const context: any = { S, document: { addEventListener(type: string, fn: Function) { listeners.set(type, fn); }, querySelector: () => null, getElementById: () => null, activeElement: { isConnected: false } },
    root: { querySelector: () => null, querySelectorAll: () => [], classList: { toggle() {} } },
    esc: (x: unknown) => String(x).replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    attr: (x: unknown) => String(x).replace(/"/g, '&quot;'), icon: () => '',
    project: () => S.doc.projects.find((p: any) => p.id === S.projectId),
    projectPipelines: () => S.doc.pipelines.filter((p: any) => context.project().pipelineIds.includes(p.id)),
    pipeline: () => S.doc.pipelines.find((p: any) => p.id === S.pipelineId),
    flushForms() { calls.push('flush'); if (S.invalid) throw Error('Invalid field'); }, render() { calls.push('render'); },
    selectProject(id: string) { calls.push('project:' + id); S.projectId = id; }, act(_: unknown, el: any) { calls.push('act:' + el.dataset.act); },
    loadLocalAgents: async () => {}, draftReady: () => true, draftCancelButton: () => '', proposalReview: () => '<p>Review</p>',
    fail(e: Error) { calls.push('error:' + e.message); },
    applyLocalProposal: async () => { S.proposalApplied = true; const p = { id: 'new', name: 'New study', stages: [{ id: 'newstep', kind: 'poll' }] }; S.doc.pipelines.push(p); context.project().pipelineIds.push(p.id); },
  };
  new Script(COMMAND_CLIENT + '\nglobalThis.command={commandEntries,commandExecute,commandInput,commandAction,commandOpen,commandApplyProposal,draftSidePanel,commandResults,commandJobVisible,state:commandState};').runInNewContext(context);
  return { ...context.command, S, calls, key: listeners.get('keydown')! };
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
  h.commandInput({ target: { id: 'commandSearch', value: 'missing' } }); assert.match(h.commandResults(), /No matching destinations/);
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
