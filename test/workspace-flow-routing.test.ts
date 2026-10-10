import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { STUDY_SETUP_CLIENT } from '../src/study-setup-ui.js';
function harness() {
  const S:any={sections:{},stageId:'first'};
  const first:any={id:'first',kind:'poll',questions:{answer:{type:'choice',label:'Which works?',criteria:{a:'A',b:'B'}}}};
  const p={id:'study',stages:[first]};
  const context:any={S,render(){},poolForPhase:()=>context.cohort,root:{querySelector:()=>null},pipeline:()=>p,selectedStage:()=>first};
  new Script(STUDY_SETUP_CLIENT+';globalThis.api={validateSetupAnswers,setupAction,assignSetupCohort}').runInNewContext(context);
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
test('reassigning a step cohort prunes unused aliases that point to missing cohorts and keeps existing ones',()=>{
  const {S,p,first,context}=harness();
  S.doc={cohorts:[{id:'real-a'},{id:'real-b'}]};context.projectCohorts=()=>S.doc.cohorts;
  p.name='My study';p.cohorts={audience:'id-missing',spare:'real-b',blank:''};first.cohort='audience';
  context.api.assignSetupCohort(p,first,'real-a');
  assert.equal(first.cohort,'cohort');
  assert.deepEqual(p.cohorts,{spare:'real-b',cohort:'real-a'});
  assert.equal(S.dirty,true);
});
test('review prunes an unused dangling alias with a notice and names the study for a used one',()=>{
  const {S,p,first,context,validateSetupAnswers}=harness();
  S.doc={cohorts:[{id:'real-a',personas:[{}]}]};const said:string[]=[];context.say=(m:string)=>said.push(m);
  context.poolForPhase=(_p:any,s:any)=>s.cohort==='audience'?{personas:[{}]}:undefined;
  first.questions.answer.criteria={a:'A',b:'B'};first.cohort='audience';
  p.name='Board study';p.cohorts={audience:'real-a',stale:'id-gone'};
  validateSetupAnswers(p);
  assert.deepEqual(p.cohorts,{audience:'real-a'});assert.match(said[0]!,/“stale”.*“Board study”/);
  first.cohort='stale';p.cohorts={stale:'id-gone'};
  assert.throws(()=>validateSetupAnswers(p),/Study “Board study”.*alias “stale” points to a cohort that is missing/);
});
