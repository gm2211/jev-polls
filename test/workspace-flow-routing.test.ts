import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { STUDY_SETUP_CLIENT } from '../src/study-setup-ui.js';
function harness() {
  const S:any={sections:{},stageId:'first'};
  const first:any={id:'first',kind:'poll',questions:{answer:{type:'choice',label:'Which works?',criteria:{a:'A',b:'B'}}}};
  const p={id:'study',stages:[first]};
  const context:any={S,render(){},poolForPhase:()=>context.cohort,root:{querySelector:()=>null},pipeline:()=>p,selectedStage:()=>first};
  new Script(STUDY_SETUP_CLIENT+';globalThis.api={validateSetupAnswers,setupAction}').runInNewContext(context);
  return {S,p,first,context,...context.api};
}
test('review directs missing cohort to visible flow cohort picker',()=>{
  const {S,p,validateSetupAnswers}=harness();
  S.sections['flow-inspector']='connections';
  assert.throws(()=>validateSetupAnswers(p),/Choose a cohort/);
  assert.equal(S.sections.pipeline,'flow');assert.equal(S.sections['flow-inspector'],'cohort');assert.equal(S.flowCohortPick,true);
});
test('review directs missing option text to visible question editor',()=>{
  const {S,p,first,validateSetupAnswers}=harness();
  first.questions.answer.criteria.b='';S.sections['flow-inspector']='cohort';
  assert.throws(()=>validateSetupAnswers(p),/text for every answer/);
  assert.equal(S.sections.pipeline,'flow');assert.equal(S.sections['flow-inspector'],'question');
  assert.equal(S.sections['setup-input-study-first-answer'],'manual');
});
test('step list opens appropriate flow editor without stale cohort section',()=>{
  const {S,p,setupAction}=harness();
  S.sections['flow-inspector']='cohort';
  setupAction('setup-edit-step',{dataset:{id:'first'}});
  assert.equal(S.sections.pipeline,'flow');assert.equal(S.sections['flow-inspector'],'question');
  p.stages.push({id:'combined',kind:'aggregate',inputs:[]});
  setupAction('setup-edit-step',{dataset:{id:'combined'}});
  assert.equal(S.sections['flow-inspector'],'connections');
});
