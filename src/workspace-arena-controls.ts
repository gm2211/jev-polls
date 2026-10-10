/**
 * Browser glue for the live voting map. render() may rebuild the page shell, but a poll never does: the map keeps
 * its own tile elements and patches only the tiles whose status or answer changed, plus counters and leaderboard
 * bars in place. Replay reveals saved evaluations only; it never starts or changes inference.
 */
export const ARENA_CONTROLS_CLIENT = String.raw`
const LV=window.liveVoting,lvm=LV.model,lvv=LV.view;
const A={el:null,runId:'',stage:'',byKey:new Map(),sigs:new Map(),members:new Map(),samples:[],samplesFor:'',rows:new Map(),shares:new Map(),refs:{},question:null,ro:null,relayout:0,tabKey:'',scroll:null,tipKey:'',ctx:null};
const R={runId:'',stage:'',cursor:undefined,playing:false,speed:1,timer:0,last:0};
LV.perf=[];
function liveUi(){return S.live??={colorBy:'pick',groupBy:'segment',zoom:'fit',question:''}}
function reducedMotion(){try{return matchMedia('(prefers-reduced-motion: reduce)').matches}catch{return false}}
function liveStudyRun(){if(S.tab!=='studies'||!S.liveInline)return null;const p=pipeline();const run=p&&projectRuns().find(r=>r.id===S.liveRunId&&r.pipelineId===p.id);if(!run&&p)S.liveInline=false;return run||null}
function liveStudyPage(p,run){const live=run.status==='running';return '<header class="study-workspace-header"><div class="study-title"><h1 tabindex="-1">'+esc(studyQuestion(p))+'</h1></div><div class="study-header-actions"><button type="button" class="button" data-act="live-back">Back to study</button>'+(localUrl(run.reportUrl)?'<a class="button primary" href="'+attr(run.reportUrl)+'" target="_blank" rel="noopener noreferrer" aria-label="Open report (new tab)">Open report</a>':'')+'</div></header><section id="view-studies" aria-label="'+(live?'Live voting':'Voting replay')+'">'+liveVotingMarkup(run)+'</section>'}
function liveStudyButton(p){const run=projectRuns().filter(r=>r.pipelineId===p.id&&(r.liveMembers?.length||r.status==='running')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];return run?'<button type="button" class="button" data-act="live-study-open" data-id="'+attr(run.id)+'">'+(run.status==='running'?'Live voting':'Voting replay')+'</button>':''}
function arenaSelectedRun(){return liveStudyRun()||(S.tab==='runs'?projectRuns().find(r=>r.id===S.liveRunId)||(S.liveRunId!=='history'&&projectRuns().find(r=>r.status==='running'))||null:null)}
function arenaStage(run){
  if(S.liveStage)return S.liveStage;const members=run.liveMembers||[],running=members.find(m=>m.status==='running')?.stage;
  if(running||run.status==='running')return running||members.at(-1)?.stage||run.stages?.[0]?.id||'';
  if(A.runId===run.id&&A.stage&&members.some(m=>m.stage===A.stage))return A.stage;
  const counts=new Map();for(const m of members)counts.set(m.stage,(counts.get(m.stage)||0)+1);
  let best='',most=0;for(const stage of (run.stages||[]).map(s=>s.id).concat([...counts.keys()]))if((counts.get(stage)||0)>most){best=stage;most=counts.get(stage)}
  return best||run.stages?.[0]?.id||'';
}
const lvW=()=>typeof innerWidth==='number'?innerWidth:1280,lvH=()=>typeof innerHeight==='number'?innerHeight:800;
const lvNow=()=>typeof performance!=='undefined'?performance.now():Date.now();
function arenaStop(){clearTimeout(R.timer);R.timer=0;R.playing=false}
function arenaReset(){arenaStop();R.runId='';R.stage='';R.cursor=undefined}
function arenaPersonas(cohort){if(!cohort)return null;arenaPersonas.cache??=new WeakMap();let index=arenaPersonas.cache.get(cohort);if(!index){index={byId:new Map(cohort.personas.map(person=>[person.id,person])),segments:Object.fromEntries((cohort.segments||[]).map(segment=>[segment.id,segment.label||segment.id]))};arenaPersonas.cache.set(cohort,index)}return index}
function arenaGroupFields(cohort,members,lookup){if(!cohort)return [];arenaGroupFields.cache??=new WeakMap();const hit=arenaGroupFields.cache.get(cohort);if(hit)return hit;const fields=lvm.groupFields(insights.discoverFields(cohort),members,lookup);arenaGroupFields.cache.set(cohort,fields);return fields}
function arenaMapBox(){const map=A.el?.isConnected?A.el.querySelector('.lv-map'):null;if(map&&map.clientWidth>0)return {width:map.clientWidth-12,top:map.getBoundingClientRect().top,measured:true};const frame=root.querySelector('.shell')?.clientWidth||lvW();return {width:Math.max(280,Math.min(frame,1600)-(lvW()>900?400:56)),top:300,measured:false}}
function arenaReserve(){const map=A.el?.isConnected?A.el.querySelector('.lv-map'):null,stage=A.el?.querySelector('.lv-stage');if(!map||!stage)return 100;return Math.round(stage.getBoundingClientRect().bottom-map.getBoundingClientRect().bottom)+50}
function arenaFitBox(){const box=arenaMapBox(),narrow=lvW()<=760;const available=Math.max(narrow?260:300,lvH()-box.top-(narrow?24:arenaReserve()));return {narrow,width:narrow?Math.max(box.width,900):box.width,height:narrow?Math.min(available,Math.round(lvH()*.62)):available,mapHeight:narrow?null:available}}
function arenaLayoutFor(groups,zoom){const fit=arenaFitBox(),counts=groups.map(group=>group.keys.length),total=counts.reduce((sum,n)=>sum+n,0),cap=lvm.tileCap(total);if(zoom==='fit'){const layout=lvm.fitLayout(counts,fit.width-12,fit.height-16,{max:cap});return {...layout,fit}}return {...lvm.fixedLayout(counts,fit.narrow?Math.max(fit.width,640):fit.width,lvm.tileFor(total,zoom)),fit}}

/** Everything the view needs, derived from the run and the user's choices. Cheap enough to call on every poll. */
function arenaInput(run,withLayout=true){
  const ui=liveUi(),stageId=arenaStage(run),all=(run.liveMembers||[]).filter(m=>m.stage===stageId),stageMeta=(run.stages||[]).find(s=>s.id===stageId);
  const terminal=run.status!=='running',replayOn=terminal&&R.runId===run.id&&R.stage===stageId&&R.cursor!==undefined&&all.length>0;
  const total=lvm.replayOrder(all).length,cursor=replayOn?Math.max(0,Math.min(total,R.cursor)):total;
  const members=replayOn?lvm.replayMembers(all,cursor,stageMeta?.batching):all;
  const study=S.doc.pipelines.find(p=>p.id===run.pipelineId),pstage=study?.stages.find(s=>s.id===stageId);
  const cohort=pstage?.kind==='poll'?S.doc.cohorts.find(c=>c.id===study.cohorts[pstage.cohort]):null,index=arenaPersonas(cohort);
  const lookup=member=>index?.byId.get(member.personaId);
  const questions=lvm.describeQuestions(pstage?.kind==='poll'?pstage.questions:undefined,all);
  const question=questions.find(q=>q.id===ui.question)||questions[0];
  const fields=arenaGroupFields(cohort,all,lookup);
  const groupOptions=[['segment','Segment'],['age','Age'],...fields.map(field=>[field,cohortFieldLabel(field)]),['none','None']];
  const groupBy=groupOptions.some(([value])=>value===ui.groupBy)?ui.groupBy:'segment';
  const segmentLabels=index?.segments||{};
  const groups=lvm.groupMembers(members,groupBy,lookup,segmentLabels);
  const layout=withLayout?arenaLayoutFor(groups,ui.zoom):{tile:18,columns:groups.map(()=>10)};
  const keyed=new Map(members.map(member=>[lvm.memberKey(member),member]));
  const selected=keyed.get(S.liveMemberKey);
  const stats=arenaStats(members);
  const live=run.status==='running';
  return {runId:run.id,status:run.status,message:run.message,reportUrl:run.reportUrl,title:stageMeta?.label||pstage?.label||stageId||'Voting',stageId,stages:(run.stages||[]).map(s=>({id:s.id,label:s.label||s.id,status:s.status||'',kind:s.kind||'',dependsOn:s.dependsOn||[]})),members,groups,layout,segmentLabels,questions,question,colorBy:ui.colorBy,groupBy,groupOptions,zoom:ui.zoom,selectedKey:S.liveMemberKey,selected,selectedHidden:!!(replayOn&&selected&&all.some(m=>lvm.memberKey(m)===S.liveMemberKey&&(m.status==='completed'||m.status==='failed'))&&!revealedKeys(all,cursor).has(S.liveMemberKey)),tabKey:keyed.has(S.liveMemberKey)?S.liveMemberKey:groups[0]?.keys[0]||'',board:lvm.leaderboard(members,question),stats:{...stats,...arenaRateText(run,stageId,stats,live)},replay:replayOn?{cursor,total,playing:R.playing,speed:R.speed,ordered:all.some(m=>m.order!==undefined)}:null,emptyReason:[stageMeta?.kind?stageMeta.kind+' step · ':'',stageMeta?.status||'No member evaluations',stageMeta?.reason?' · '+stageMeta.reason:''].join('')+' · No member evaluations in this step.'};
}
function revealedKeys(all,cursor){return new Set(lvm.replayOrder(all).slice(0,Math.floor(cursor)).map(lvm.memberKey))}
function arenaStats(members){let queued=0,running=0,done=0,failed=0;for(const m of members){if(m.status==='queued')queued++;else if(m.status==='running')running++;else if(m.status==='completed')done++;else failed++}return {queued,running,done,failed,total:members.length}}
function arenaRateText(run,stageId,stats,live){
  if(!live)return {rateText:'',leftText:''};
  const sampleKey=run.id+':'+stageId;if(A.samplesFor!==sampleKey){A.samples=[];A.samplesFor=sampleKey}
  const now=Date.now(),finished=stats.done+stats.failed,last=A.samples.at(-1);
  if(!last||now-last.t>=400||finished!==last.done){A.samples.push({t:now,done:finished});while(A.samples.length>1&&now-A.samples[0].t>25000)A.samples.shift()}
  const rate=lvm.rate(A.samples,now,20000);
  return {rateText:rate===null?'—':(rate<10?rate.toFixed(1):Math.round(rate))+'/s',leftText:stats.running+stats.queued===0?'done':rate?'~'+lvm.duration(lvm.secondsLeft(stats.total-finished,rate)):'—'};
}
function liveVotingMarkup(run){return lvv.html(arenaInput(run))}

// ---- attaching to the rendered markup ----------------------------------------------------------------------
function arenaBeforeRender(){const map=A.el?.isConnected?A.el.querySelector('.lv-map'):null;A.scroll=map?{runId:A.runId,stage:A.stage,left:map.scrollLeft,top:map.scrollTop}:null;const active=document.activeElement;A.focus=active&&active.closest?.('.live-voting')?{act:active.dataset?.act,value:active.dataset?.value,speed:active.dataset?.speed,key:active.dataset?.key,tag:active.tagName,name:active.getAttribute?.('data-lv-group')!=null?'group':active.getAttribute?.('data-lv-question')!=null?'question':active.hasAttribute?.('data-arena-scrub')?'scrub':''}:null}
function arenaAfterRender(){
  const el=root.querySelector('.live-voting');
  if(A.ro){A.ro.disconnect();A.ro=null}
  if(!el){A.el=null;A.byKey.clear();A.sigs.clear();return}
  const run=arenaSelectedRun();if(!run){A.el=null;return}
  A.el=el;A.runId=run.id;A.stage=el.dataset.stage;
  A.byKey=new Map([...el.querySelectorAll('.lv-tile')].map(tile=>[tile.dataset.key,tile]));
  const ctx=arenaInput(run,false);A.ctx=ctx;A.question=ctx.question;
  A.sigs=new Map(ctx.members.map(member=>[lvm.memberKey(member),lvm.signature(member)]));
  A.members=new Map(ctx.members.map(member=>[lvm.memberKey(member),member]));
  A.tabKey=ctx.tabKey;A.shares=new Map(ctx.board.rows.map(row=>[row.id,row.share]));
  A.rows=new Map([...el.querySelectorAll('.lv-row')].map(row=>[row.dataset.opt,row]));
  A.refs={bar:el.querySelector('[data-lv=bar]'),progress:el.querySelector('.lv-progress'),done:el.querySelector('[data-lv=done]'),running:el.querySelector('[data-lv=running]'),failed:el.querySelector('[data-lv=failed]'),rate:el.querySelector('[data-lv=rate]'),left:el.querySelector('[data-lv=left]'),message:el.querySelector('[data-lv=message]'),boardSub:el.querySelector('[data-lv=board-sub]'),detail:el.querySelector('[data-lv=detail]'),legend:el.querySelector('[data-lv=legend]'),map:el.querySelector('.lv-map'),groups:el.querySelector('.lv-groups'),tip:el.querySelector('.lv-tip')};
  const map=A.refs.map;
  if(map){
    if(A.scroll&&A.scroll.runId===A.runId&&A.scroll.stage===A.stage){map.scrollLeft=A.scroll.left;map.scrollTop=A.scroll.top}
    arenaRelayout();
    if(typeof ResizeObserver==='function'){A.ro=new ResizeObserver(()=>{clearTimeout(A.relayout);A.relayout=setTimeout(arenaRelayout,120)});A.ro.observe(map)}
    map.addEventListener('pointerover',event=>{const tile=event.target.closest?.('.lv-tile');if(tile&&event.pointerType!=='touch')arenaTip(tile)});
    map.addEventListener('pointerout',event=>{if(event.target.closest?.('.lv-tile'))arenaTipHide()});
    map.addEventListener('focusin',event=>{const tile=event.target.closest?.('.lv-tile');if(tile){arenaTip(tile);arenaTabStop(tile.dataset.key)}});
    map.addEventListener('focusout',arenaTipHide);
    map.addEventListener('scroll',arenaTipHide,{passive:true});
    map.addEventListener('keydown',arenaKeys);
    map.addEventListener('animationend',event=>{if(event.animationName==='lv-pop')event.target.classList.remove('is-pop')});
  }
  const f=A.focus;A.focus=null;
  if(f){let target=null;if(f.key)target=A.byKey.get(f.key);else if(f.name==='group')target=el.querySelector('[data-lv-group]');else if(f.name==='question')target=el.querySelector('[data-lv-question]');else if(f.name==='scrub')target=el.querySelector('[data-arena-scrub]');else if(f.act)target=[...el.querySelectorAll('[data-act="'+f.act+'"]')].find(node=>(node.dataset.value??null)===(f.value??null)&&(node.dataset.speed??null)===(f.speed??null))||el.querySelector('[data-act="'+f.act+'"]');target?.focus({preventScroll:true})}
}
/** Size the map to the space left in the window and choose a tile size that fits every group. */
function arenaRelayout(){
  const map=A.refs.map;if(!map||!A.el?.isConnected||!A.ctx)return;
  const fit=arenaFitBox();
  map.style.height=fit.mapHeight?fit.mapHeight+'px':'';
  const layout=arenaLayoutFor(A.ctx.groups,liveUi().zoom);
  A.refs.groups.style.setProperty('--tile',layout.tile+'px');A.refs.groups.dataset.big=String(layout.tile>=30);
  A.refs.groups.style.width=fit.narrow&&liveUi().zoom==='fit'?fit.width+'px':'';
  map.toggleAttribute('data-wide',fit.narrow);
  const sections=A.refs.groups.children;for(let i=0;i<sections.length;i++){const tiles=sections[i].querySelector('.lv-tiles');if(tiles&&layout.columns[i])tiles.style.setProperty('--cols',layout.columns[i])}
}

// ---- incremental update ------------------------------------------------------------------------------------
/** Patch the map in place for a new poll or replay position. Returns false when the page must be rebuilt instead. */
function arenaUpdate(run){
  if(!A.el||!A.el.isConnected||A.runId!==run.id)return false;
  const started=lvNow(),ctx=arenaInput(run,false);
  const mode=run.status==='running'?'live':ctx.replay?'replay':'done';
  if(ctx.stageId!==A.stage||mode!==A.el.dataset.mode||ctx.groupBy!==A.ctx.groupBy||ctx.members.length!==A.sigs.size)return false;
  const plan=lvm.patchPlan(A.sigs,ctx.members);
  if(plan.added.length||plan.removed.length)return false;
  const byKey=new Map(ctx.members.map(member=>[lvm.memberKey(member),member]));
  const animate=!reducedMotion()&&plan.changed.length<=80,template=document.createElement('template');
  for(const key of plan.changed){
    const old=A.byKey.get(key),member=byKey.get(key);if(!old||!member)return false;
    const finishing=member.status==='completed'&&A.members.get(key)?.status!=='completed';
    template.innerHTML=lvv.tileHtml(member,{question:ctx.question,colorBy:ctx.colorBy,segmentLabel:ctx.segmentLabels[member.segment]||member.segment,selected:key===S.liveMemberKey,tabbable:key===A.tabKey,pop:finishing&&animate});
    const next=template.content.firstElementChild,focused=document.activeElement===old;
    old.replaceWith(next);A.byKey.set(key,next);A.sigs.set(key,lvm.signature(member));
    if(focused)next.focus({preventScroll:true});
  }
  A.members=byKey;A.ctx={...A.ctx,...ctx,groups:A.ctx.groups,layout:A.ctx.layout};A.question=ctx.question;
  arenaPatchChrome(ctx,run);
  const ms=lvNow()-started;LV.perf.push({ms:Math.round(ms*100)/100,changed:plan.changed.length,tiles:ctx.members.length});if(LV.perf.length>400)LV.perf.shift();
  return true;
}
function arenaPatchChrome(ctx,run){
  const r=A.refs,s=ctx.stats,finished=s.done+s.failed,live=run.status==='running';
  if(r.done)r.done.textContent=finished.toLocaleString('en-US')+' / '+s.total.toLocaleString('en-US');
  if(r.running)r.running.textContent=s.running.toLocaleString('en-US');
  if(r.failed)r.failed.textContent=s.failed.toLocaleString('en-US');
  if(r.rate)r.rate.textContent=s.rateText;
  if(r.left)r.left.textContent=s.leftText;
  if(r.bar)r.bar.style.setProperty('--f',String(s.total?Math.round(finished/s.total*1000)/1000:0));
  if(r.progress)r.progress.setAttribute('aria-valuenow',String(finished));
  if(r.message&&live)r.message.textContent=run.message||'';
  if(r.legend&&ctx.colorBy==='status'){for(const key of ['queued','running','done','failed']){const node=r.legend.querySelector('[data-lv=count-'+key+']');if(node)node.textContent=s[key].toLocaleString('en-US')}}
  const board=ctx.board,rows=board.rows,max=Math.max(0.0001,...rows.map(row=>row.share));
  rows.forEach((row,rank)=>{
    const li=A.rows.get(row.id);if(!li)return;
    li.style.setProperty('--rank',String(Math.min(rank,lvv.BOARD_ROWS)));li.style.setProperty('--w',String(Math.round(row.share/max*1000)/1000));
    li.dataset.leader=String(board.leader===row.id);li.dataset.hidden=String(rank>=lvv.BOARD_ROWS);
    const text=(Math.round(row.share*1000)/10).toFixed(1)+'%',pct=li.querySelector('.lv-pct');
    if(pct&&pct.textContent!==text)pct.textContent=text;
    A.shares.set(row.id,row.share);
  });
  if(r.boardSub)r.boardSub.textContent=ctx.question?.type==='score'&&board.mean!==null?'Mean score '+Math.round(board.mean*100)/100:board.evaluated?(board.weighted?'Weighted share':'Equal-weight share')+' of '+board.evaluated.toLocaleString('en-US')+' evaluated':'Fills in as members vote';
  const scrub=A.el.querySelector('[data-lv=scrub-text]');
  if(scrub&&ctx.replay){scrub.textContent=Math.floor(ctx.replay.cursor).toLocaleString('en-US')+' of '+ctx.replay.total.toLocaleString('en-US')+(ctx.replay.total===1?' member':' members')+' revealed';const range=A.el.querySelector('[data-arena-scrub]');if(range&&document.activeElement!==range)range.value=String(ctx.replay.cursor);const play=A.el.querySelector('[data-act=arena-play]');if(play){play.textContent=ctx.replay.playing?'Pause':'Play';play.setAttribute('aria-pressed',String(ctx.replay.playing))}}
  const selected=ctx.selected;if(selected&&r.detail&&A.detailSig!==lvm.signature(selected)+S.liveMemberKey){A.detailSig=lvm.signature(selected)+S.liveMemberKey;arenaDetail(ctx)}
}
function arenaDetail(ctx){const member=ctx.selected;A.refs.detail.dataset.has=String(!!member);A.refs.detail.innerHTML=lvv.detailHtml(member,{question:ctx.question,questions:ctx.questions,segmentLabel:member?ctx.segmentLabels[member.segment]||member.segment:'',hidden:ctx.selectedHidden})}

// ---- selection, tooltip, keyboard --------------------------------------------------------------------------
function arenaTabStop(key){if(A.tabKey===key)return;A.byKey.get(A.tabKey)?.setAttribute('tabindex','-1');A.tabKey=key;A.byKey.get(key)?.setAttribute('tabindex','0')}
function arenaSelect(key){
  if(!A.el)return;const before=S.liveMemberKey;S.liveMemberKey=key;
  A.byKey.get(before)?.setAttribute('aria-pressed','false');A.byKey.get(key)?.setAttribute('aria-pressed','true');arenaTabStop(key);
  const run=arenaSelectedRun();if(!run)return;const ctx=arenaInput(run,false);A.ctx={...A.ctx,...ctx,groups:A.ctx.groups,layout:A.ctx.layout};A.detailSig=ctx.selected?lvm.signature(ctx.selected)+key:'';arenaDetail(ctx);arenaSyncPlay();
}
function arenaSyncPlay(){const play=A.el?.querySelector?.('[data-act=arena-play]');if(play){play.textContent=R.playing?'Pause':'Play';play.setAttribute('aria-pressed',String(R.playing))}}
function arenaTip(tile){
  const tip=A.refs.tip,member=A.members.get(tile.dataset.key);if(!tip||!member)return;
  tip.innerHTML=lvv.tooltipHtml(member,{question:A.question,segmentLabel:A.ctx.segmentLabels[member.segment]||member.segment});tip.hidden=false;
  const rect=tile.getBoundingClientRect(),box=tip.getBoundingClientRect();
  let top=rect.top-box.height-8;if(top<8)top=rect.bottom+8;
  tip.style.top=Math.round(top)+'px';tip.style.left=Math.round(Math.max(8,Math.min(lvW()-box.width-8,rect.left+rect.width/2-box.width/2)))+'px';
}
function arenaTipHide(){const tip=A.refs?.tip;if(tip)tip.hidden=true}
function arenaKeys(event){
  const tile=event.target.closest?.('.lv-tile');if(!tile||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
  const tiles=[...A.refs.map.querySelectorAll('.lv-tile')],index=tiles.indexOf(tile);let next=null;
  if(event.key==='ArrowRight')next=tiles[index+1];else if(event.key==='ArrowLeft')next=tiles[index-1];else if(event.key==='Home')next=tiles[0];else if(event.key==='End')next=tiles.at(-1);
  else{
    const rect=tile.getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2,down=event.key==='ArrowDown';let best=Infinity;
    for(const other of tiles){if(other===tile)continue;const r=other.getBoundingClientRect(),oy=r.top+r.height/2,dy=down?oy-cy:cy-oy;if(dy<rect.height*.6)continue;const score=dy*4+Math.abs(r.left+r.width/2-cx);if(score<best){best=score;next=other}}
  }
  if(!next)return;event.preventDefault();arenaTabStop(next.dataset.key);next.focus({preventScroll:true});next.scrollIntoView({block:'nearest',inline:'nearest'});
}

// ---- replay ------------------------------------------------------------------------------------------------
function arenaReplayTotal(run){return lvm.replayOrder((run.liveMembers||[]).filter(m=>m.stage===arenaStage(run))).length}
function arenaApply(run){if(!arenaUpdate(run))render()}
function arenaTick(){
  const run=arenaSelectedRun();
  if(!run||document.visibilityState==='hidden'||run.id!==R.runId||arenaStage(run)!==R.stage||run.status==='running'){arenaStop();return}
  const now=lvNow(),total=arenaReplayTotal(run);
  R.cursor=lvm.replayAdvance(R.cursor??0,lvm.replayRate(total,R.speed),now-R.last,total);R.last=now;
  if(R.cursor>=total){R.cursor=total;arenaStop()}
  arenaApply(run);
  if(R.playing)R.timer=setTimeout(arenaTick,80);
}
function arenaAction(action,element){
  if(action==='live-member'){
    if(R.playing)arenaStop();
    if(A.el&&A.byKey.has(element.dataset.key)){arenaSelect(element.dataset.key);return true}
    S.liveMemberKey=element.dataset.key;render();return true;
  }
  if(action==='lv-color'||action==='lv-zoom'){const ui=liveUi();if(action==='lv-color')ui.colorBy=element.dataset.value;else ui.zoom=element.dataset.value;render();return true}
  if(!action.startsWith('arena-'))return false;
  const run=arenaSelectedRun();if(!run||run.status==='running')return true;
  const stage=arenaStage(run);if(R.runId!==run.id||R.stage!==stage){arenaStop();R.runId=run.id;R.stage=stage;R.cursor=undefined}
  const total=arenaReplayTotal(run);if(!total)return true;
  if(action==='arena-replay'){arenaStop();R.cursor=0;S.liveMemberKey='';render();return true}
  if(action==='arena-live'){arenaReset();render();return true}
  if(R.cursor===undefined){R.cursor=total}
  if(action==='arena-reset'){arenaStop();R.cursor=0;S.liveMemberKey=''}
  else if(action==='arena-step'){arenaStop();R.cursor=Math.min(total,Math.floor(R.cursor)+1);const revealed=lvm.replayOrder((run.liveMembers||[]).filter(m=>m.stage===stage))[Math.floor(R.cursor)-1];if(revealed)S.liveMemberKey=lvm.memberKey(revealed)}
  else if(action==='arena-play'){if(R.playing)arenaStop();else{if(R.cursor>=total){R.cursor=0;S.liveMemberKey=''}R.playing=true;R.last=lvNow();R.timer=setTimeout(arenaTick,80)}}
  else if(action==='arena-scrub'){arenaStop();R.cursor=Math.max(0,Math.min(total,Number(element.value)||0))}
  else if(action==='arena-speed'){const speed=Number(element.dataset.speed);if([1,2,4,8].includes(speed)){R.speed=speed;A.el?.querySelectorAll('[data-act=arena-speed]').forEach(node=>node.setAttribute('aria-pressed',String(Number(node.dataset.speed)===speed)))}return true}
  arenaApply(run);return true;
}
document.addEventListener('input',event=>{if(event.target.matches?.('[data-arena-scrub]'))arenaAction('arena-scrub',event.target)});
document.addEventListener('change',event=>{
  const ui=liveUi();
  if(event.target.matches?.('[data-lv-group]')){ui.groupBy=event.target.value;render()}
  else if(event.target.matches?.('[data-lv-question]')){ui.question=event.target.value;render()}
});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')arenaStop()});
`;
