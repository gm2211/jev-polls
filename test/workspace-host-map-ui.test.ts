import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { WORKSPACE_FLOW_CLIENT } from '../src/workspace-flow-ui.js';
import { WORKSPACE_HOST_MAP_CLIENT } from '../src/workspace-host-map-ui.js';
import { NAVIGATION_CLIENT } from '../src/workspace-navigation-ui.js';

function harness() {
  const escape = (value: unknown) => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context: any = { S: { listPages: {} }, window: { innerWidth: 1280 }, inlineCohortTarget: () => false, poolForPhase: (_p:unknown,s:any) => s.pool, esc: escape, attr: escape, icon: () => '', render() {}, root: { querySelectorAll: () => [], querySelector: () => null } };
  new Script(NAVIGATION_CLIENT + WORKSPACE_HOST_MAP_CLIENT + WORKSPACE_FLOW_CLIENT + ';globalThis.S=S;globalThis.api={S,seatFitLines,seatPageSize,hostMapFocus,hostMap,hostMapMember,hostMapDetails,hostMapAction,hostMapState,flowCohortMap}').runInNewContext(context);
  return context.api;
}
const cohort = {id:'audience', name:'Audience', segments:[{id:'a',label:'Segment A',weightBasis:'assumed'}], sources:[], personas:Array.from({length:53},(_,i)=>({id:'p'+i,label:'Person '+i,segment:'a',background:'Synthetic <profile>',weight:2,syntheticFields:['background']}))};
test('host map is the generation seat map: every member, a coloured row per segment, paged with the shared list pager', () => {
  const api=harness();
  const first=api.hostMap(cohort,{key:'flow'});
  assert.equal((first.match(/class="live-seat"/g)||[]).length,53);
  assert.match(first,/class="live-map host-map/);
  assert.match(first,/style="--seg:var\(--seg-0\)"/);
  assert.match(first,/Segment A<span>53<\/span>/);
  assert.match(first,/53 synthetic members/);
  assert.doesNotMatch(first,/class="pagination"/, 'one page needs no pager');
  const big={...cohort,segments:[...cohort.segments,{id:'b',label:'Segment B'}],personas:Array.from({length:300},(_,i)=>({...cohort.personas[0],id:'b'+i,segment:i%3?'a':'b'}))};
  api.hostMapAction('host-member',{dataset:{map:'big',id:'b2'}});
  const one=api.hostMap(big,{key:'big'});
  assert.equal((one.match(/class="live-seat"/g)||[]).length,240);
  assert.match(one,/1–240 of 300/); assert.match(one,/data-act="page-action"/);
  assert.match(one,/Segment A<span>200<\/span>/, 'row counts are whole segments, not the page');
  api.S.listPages['workspace:seats:big']=1;
  assert.equal(api.hostMapMember(big,'big').id,'b2', 'paging keeps the selection');
  const two=api.hostMap(big,{key:'big'});
  assert.equal((two.match(/class="live-seat"/g)||[]).length,60);
  assert.doesNotMatch(two,/Segment A<span>/, 'rows with no seats on this page are left out');
  assert.match(two,/Segment B<span>100<\/span>/);
  assert.match(two,/241–300 of 300/);
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
  assert.match(api.flowCohortMap(pipeline,stage),/53 synthetic members/);
});

test('seat map pages shrink until the pane stops scrolling and grow while a whole line of room is spare, never past a size seen to overflow', () => {
  const api=harness();
  const lines=(...args:any[])=>api.seatFitLines(...args).lines;
  assert.equal(lines(10,45,18,true),7,'45px of overflow drops three 18px lines');
  assert.equal(lines(3,500,18,true),2,'never fewer than two lines');
  assert.equal(lines(4,-40,18,true),6,'40px of room adds two lines');
  assert.equal(lines(4,-40,18,false),4,'a map on one page has nothing to grow into');
  assert.equal(lines(4,-10,18,true),4,'less than a line of room changes nothing');
  assert.equal(lines(4,-90,18,true,{over:6}),5,'never grows back to a size seen to overflow');
  assert.equal(lines(8,100,18,true,{ok:6}),6,'never shrinks below a size seen to fit');
  let fit:any={},n=12;const excessAt=(k:number)=>(k-7)*18+(k>5?20:0);
  for(let pass=0;pass<6;pass++){const next=api.seatFitLines(n,excessAt(n),18,true,fit);fit=next;n=next.lines}
  assert.equal(n,5,'converges on the most lines that fit even when an extra header makes the first guess overshoot');
  assert.equal(api.seatPageSize('host:x'),240,'a screenful before the pane is measured');
  api.S.seatFits={'host:x':{size:96}};
  assert.equal(api.seatPageSize('host:x'),96);
  const html=api.hostMap(cohort,{key:'x'});
  assert.equal((html.match(/class="live-seat"/g)||[]).length,53);
  assert.match(html,/data-fit="host:x"/);
});
test('a selected member replaces the map, with a way back and to the neighbouring members', () => {
  const api=harness();
  const html=api.hostMapFocus(cohort,'proposal:j',cohort.personas[0],'All personas');
  assert.match(html,/data-act="host-member-close" data-map="proposal:j"> All personas/);
  assert.match(html,/aria-label="Previous member"/);
  assert.match(html,/1 \/ 53/);
  assert.match(html,/Synthetic &lt;profile>/);
  assert.match(api.hostMapFocus({...cohort,personas:[{...cohort.personas[0],attributes:{budget:'£800'}}]},'k',{...cohort.personas[0],attributes:{budget:'£800'}},'Back'),/<dt>budget<\/dt><dd>£800<\/dd>/,'generated attributes stay visible');
});
