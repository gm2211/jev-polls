import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { WORKSPACE_FLOW_CLIENT } from '../src/workspace-flow-ui.js';
import { WORKSPACE_HOST_MAP_CLIENT } from '../src/workspace-host-map-ui.js';

function harness() {
  const escape = (value: unknown) => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context: any = { S: {}, inlineCohortTarget: () => false, poolForPhase: (_p:unknown,s:any) => s.pool, esc: escape, attr: escape, icon: () => '', render() {}, root: { querySelectorAll: () => [], querySelector: () => null } };
  new Script(WORKSPACE_HOST_MAP_CLIENT + WORKSPACE_FLOW_CLIENT + ';globalThis.api={hostMap,hostMapMember,hostMapDetails,hostMapAction,hostMapState,flowCohortMap}').runInNewContext(context);
  return context.api;
}
const cohort = {id:'audience', name:'Audience', segments:[{id:'a',label:'Segment A',weightBasis:'assumed'}], sources:[], personas:Array.from({length:53},(_,i)=>({id:'p'+i,label:'Person '+i,segment:'a',background:'Synthetic <profile>',weight:2,syntheticFields:['background']}))};
test('host map bounds members, groups segments, and paginates without changing selection', () => {
  const api=harness();
  const first=api.hostMap(cohort,{key:'flow'});
  assert.equal((first.match(/class="host-member"/g)||[]).length,48);
  assert.match(first,/Segment A/);
  assert.match(first,/1–48 of 53 synthetic members/);
  api.hostMapAction('host-member',{dataset:{map:'flow',id:'p2'}});
  api.hostMapAction('host-page',{dataset:{map:'flow',page:'1'}});
  assert.equal(api.hostMapMember(cohort,'flow').id,'p2');
  const second=api.hostMap(cohort,{key:'flow'});
  assert.equal((second.match(/class="host-member"/g)||[]).length,5);
  assert.match(second,/49–53 of 53/);
  api.hostMapAction('host-page',{dataset:{map:'flow',page:'900'}});
  assert.match(api.hostMap(cohort,{key:'flow'}),/49–53 of 53/);
});
test('host map uses keyboard buttons, escaped labels, provenance and independent map state', () => {
  const api=harness();
  api.hostMapAction('host-member',{dataset:{map:'one',id:'p2'}});
  assert.equal(api.hostMapMember(cohort,'two'),null);
  assert.match(api.hostMap(cohort,{key:'one',statusFor:()=> 'running'}),/data-status="running"/);
  assert.match(api.hostMap(cohort,{key:'one'}),/aria-pressed="true"/);
  const details=api.hostMapDetails(cohort,cohort.personas[2]);
  assert.match(details,/Synthetic &lt;profile>/);
  assert.match(details,/assumed/);
  assert.match(details,/None recorded/);
});

test('pipeline member selection replaces map with focused detail and returns without changing page',()=>{
  const api=harness(),stage={id:'step',pool:cohort},pipeline={id:'study'},key='flow:study:step:audience';
  api.hostMapAction('host-page',{dataset:{map:key,page:'1'}});
  api.hostMapAction('host-member',{dataset:{map:key,id:'p25'}});
  const focused=api.flowCohortMap(pipeline,stage);
  assert.match(focused,/Selected synthetic member/);assert.match(focused,/Previous member/);assert.match(focused,/Next member/);
  assert.doesNotMatch(focused,/host-map-members/);
  api.hostMapAction('host-member-close',{dataset:{map:key}});
  assert.match(api.flowCohortMap(pipeline,stage),/25–48 of 53/);
});
