/** Counts reflect server output. Timers never advance generation. */
export const DRAFT_PROGRESS_CSS = `
.panel.draft-progress{padding:24px 28px;border-top:3px solid var(--blue);border-radius:8px}.draft-progress-heading{display:flex;justify-content:space-between;gap:16px;align-items:start}.draft-progress-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap}.draft-progress h2{font-size:var(--text-lg)}.draft-provider{margin:4px 0 0;color:var(--muted);font-size:var(--text-sm);overflow-wrap:anywhere}.draft-elapsed{color:var(--muted);font-size:var(--text-sm);white-space:nowrap;font-variant-numeric:tabular-nums}
.draft-metrics{display:flex;align-items:end;justify-content:space-between;gap:16px 24px;margin:22px 0 10px}.draft-count{margin:0;color:var(--muted);font-size:var(--text-md)}.draft-count strong{font-size:clamp(32px,4vw,44px);line-height:1.1;font-weight:600;letter-spacing:-.04em;color:var(--ink);font-variant-numeric:tabular-nums;margin-right:8px}.draft-estimate{margin:0;text-align:right;color:var(--ink);font-size:var(--text-md);font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}
.draft-bar{position:relative;height:8px;border-radius:4px;background:var(--line);overflow:hidden}.draft-bar span{position:absolute;inset:0 auto 0 0;border-radius:inherit;transition:width .6s ease}.draft-bar-written{background:var(--teal);opacity:.35}.draft-bar-checked{background:var(--teal)}
.draft-progress-status{margin:16px 0 0;font-size:var(--text-md);color:var(--ink);line-height:1.45;min-height:1.45em}.draft-progress-detail{margin:2px 0 0;font-size:var(--text-sm);color:var(--muted);line-height:1.45;min-height:1.45em;font-variant-numeric:tabular-nums}
.draft-progress-error{margin-top:16px}.draft-progress-error .button{margin-top:8px}
@media(prefers-reduced-motion:reduce){.draft-bar span{transition:none}}
@media(max-width:540px){.panel.draft-progress{padding:18px}.draft-progress-heading{flex-wrap:wrap}.draft-progress-actions{width:100%;justify-content:space-between}.draft-metrics{flex-wrap:wrap;align-items:baseline}.draft-estimate{text-align:left}}
`;

/*
 * One readout that keeps its shape while a job runs: a count of personas
 * written so far, a time estimate, a bar, one plain status line and one muted
 * detail line. Polls patch the [data-slot] nodes in place instead of
 * re-rendering the page, so nothing around the readout redraws or animates.
 */
export const DRAFT_PROGRESS_CLIENT = String.raw`
function draftCancelButton(job){return job?.id&&job.status==='running'?'<button class="button" type="button" data-act="assistant-cancel">Cancel generation</button>':''}
function draftDuration(ms){const seconds=Math.max(0,Math.floor(ms/1000));if(!Number.isFinite(seconds))return '';const minutes=Math.floor(seconds/60);return (minutes?minutes+'m ':'')+(seconds%60)+'s'}
function draftElapsed(start,end){const duration=draftDuration((end?Date.parse(end):Date.now())-Date.parse(start));return duration?duration+' elapsed':''}
function draftLastEvent(at){const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(at))/1000));if(!Number.isFinite(seconds))return '';return seconds<3?'updated just now':seconds<30?'updated '+seconds+'s ago':'no new output for '+draftDuration(seconds*1000)+', still working'}
function draftRange(lowMs,highMs){
  const unit=highMs<120000?'sec':'min',divisor=unit==='sec'?1000:60000;
  const low=Math.max(1,Math.floor(lowMs/divisor)),high=Math.max(low+1,Math.ceil(highMs/divisor));
  return 'About '+low+'–'+high+' '+unit+' left';
}
function draftEstimate(p){
  if(!Number.isFinite(p.totalPersonas)||!Number.isFinite(p.completedPersonas)||p.totalPersonas-p.completedPersonas<=0)return '';
  // Time left follows what is written (checked or still arriving), so a nearly full count never shows a long wait.
  const written=Math.min(p.totalPersonas,p.completedPersonas+(Number.isFinite(p.inFlightPersonas)?p.inFlightPersonas:0));
  if(written>=p.totalPersonas)return 'Finishing…';
  if(p.estimate&&Number.isFinite(p.estimate.seconds)){
    const left=Math.max(0,p.estimate.seconds-(Date.now()-Date.parse(p.estimate.at))/1000);
    return left<5?'Finishing…':draftRange(left*800,left*1250+2000);
  }
  const durations=p.batchDurationsMs||[],sizes=p.completedBatchSizes||[];
  const rates=durations.map((ms,i)=>Number.isFinite(ms)&&ms>0&&Number.isFinite(sizes[i])&&sizes[i]>0?ms/sizes[i]:0).filter(n=>n>0);
  if(rates.length<2)return p.totalBatches>2?'Estimating time left…':'';
  if(p.batchStartedAt&&Date.now()-Date.parse(p.batchStartedAt)>Math.max(...durations)*1.5)return 'Taking longer than usual';
  const remaining=p.totalPersonas-written;
  const left=Number.isFinite(p.totalBatches)&&Number.isFinite(p.completedBatches)?Math.max(1,p.totalBatches-p.completedBatches):Infinity;
  const parallel=Math.max(1,Math.min(p.maxConcurrentBatches||1,left));
  const average=rates.reduce((a,b)=>a+b,0)/rates.length;
  return draftRange(remaining*Math.min(average*.8,...rates)/parallel,remaining*Math.max(average*1.2,...rates)/parallel);
}
function draftBackoffCause(cause){return cause==='rate-limit'?'a rate limit':cause==='overload'?'the AI being busy':'a connection problem'}
function draftStatus(job){
  const p=job.progress||{},phase=p.phase||'generating';
  const provider=job.engine==='chatgpt'?'ChatGPT':job.engine==='claude'?'Claude Code':'Codex';
  if(phase==='saving')return 'Saving your latest edits first.';
  if(phase==='checking')return 'Connecting to '+provider+'.';
  if(phase==='validating'&&(p.validation?.scope==='final'||!p.totalBatches||p.completedBatches===p.totalBatches))return 'Checking the finished audience.';
  if(!job.cohort)return job.persona?'Writing the replacement persona.':'Writing your proposal.';
  const details=Array.isArray(p.batchDetails)?p.batchDetails:[];
  const waiting=details.find(d=>d.state==='waiting'&&d.wait);
  if(waiting)return 'Paused briefly after '+draftBackoffCause(waiting.wait.cause)+'. It picks up again on its own.';
  if(p.batchLimit?.allowed>0)return 'Writing more slowly for now because of '+draftBackoffCause(p.batchLimit.cause)+'.';
  if(p.retry&&!p.retry.cause)return 'Rewriting a few personas that did not pass the checks.';
  const active=Array.isArray(p.activeBatches)?p.activeBatches.length:0;
  if(!p.completedBatches&&!active&&!details.length){
    if(/waiting/i.test(job.message||''))return 'Planning who is in the audience: paused briefly, it picks up again on its own.';
    const plan=p.plan,groups=Array.isArray(plan?.groups)?plan.groups.length:0,named=plan?.name?' “'+plan.name+'”':'';
    if(plan?.stage==='assumptions')return 'Planned'+named+': '+plural(groups,'group')+'. Personas start arriving next.';
    if(groups)return 'Planning'+named+': '+groups+(groups===1?' group':' groups')+' so far. Personas start arriving after this.';
    if(named)return 'Planning'+named+': choosing the groups in it.';
    return p.activity==='starting'&&!p.outputChars?'Waiting for '+provider+' to start planning the audience.':'Planning who is in the audience. Personas start arriving after this.';
  }
  const written=(p.completedPersonas||0)+(p.inFlightPersonas||0),states=draftGroupStates(p);
  if(!written&&states.writing+states.thinking+states.connecting>0)return states.writing?'Writing the first personas.':states.thinking?provider+' is thinking through the first personas before writing them.':'Waiting for '+provider+' to start writing.';
  return active>1?'Writing personas, '+active+' groups at a time.':'Writing personas.';
}
/* How many groups are waiting for a reply, thinking, or writing right now. */
function draftGroupStates(p){
  const counts={connecting:0,thinking:0,writing:0};
  for(const d of Array.isArray(p.batchDetails)?p.batchDetails:[])if(d.state==='connecting'||d.state==='retrying')counts.connecting++;else if(d.state==='thinking')counts.thinking++;else if(d.state==='writing')counts.writing++;
  return counts;
}
/* The groups the plan has named so far, with each one's share once every weight is known. */
function draftPlanGroups(plan){
  const groups=Array.isArray(plan?.groups)?plan.groups.filter(g=>g&&typeof g.label==='string'):[];if(!groups.length)return '';
  const total=plan.stage==='assumptions'&&groups.every(g=>Number.isFinite(g.weight)&&g.weight>=0)?groups.reduce((sum,g)=>sum+g.weight,0):0;
  const shown=groups.slice(0,5).map(g=>g.label+(total>0?' '+Math.round(g.weight/total*100)+'%':''));
  return shown.join(', ')+(groups.length>5?' and '+(groups.length-5)+' more':'');
}
/* The newest checked persona, so the readout shows who is arriving. */
function draftLatest(p){
  const latest=Array.isArray(p.latestAccepted)?p.latestAccepted.at(-1):null;if(!latest||typeof latest.label!=='string')return '';
  const label=latest.label.length>60?latest.label.slice(0,59)+'…':latest.label;
  return 'latest: '+label+(Number.isFinite(latest.age)?', '+latest.age:'');
}
function draftDetail(job){
  const p=job.progress||{},checked=p.completedPersonas;
  if(!Number.isFinite(checked)||!job.cohort)return '';
  if(checked){const latest=draftLatest(p);return checked.toLocaleString('en-US')+' checked and saved'+(latest?' · '+latest:'')}
  if(!p.completedBatches&&!(Array.isArray(p.activeBatches)&&p.activeBatches.length)&&!(Array.isArray(p.batchDetails)&&p.batchDetails.length)){const groups=draftPlanGroups(p.plan);if(groups)return groups}
  const states=draftGroupStates(p),parts=[];
  if(states.writing)parts.push(states.writing+' writing');
  if(states.thinking)parts.push(states.thinking+' thinking');
  if(states.connecting)parts.push(states.connecting+' waiting to start');
  return parts.length?'Groups: '+parts.join(', '):'None checked yet';
}
function draftSlots(job){
  const p=job.progress||{},total=p.totalPersonas,checked=p.completedPersonas;
  const counted=Number.isFinite(total)&&Number.isFinite(checked);
  const written=counted?Math.min(total,checked+(p.phase==='generating'||p.phase==='validating'?p.inFlightPersonas||0:0)):0;
  const pct=n=>counted&&total>0?Math.min(100,Math.round(n/total*1000)/10):0;
  const detail=draftDetail(job),activity=p.lastActivityAt?draftLastEvent(p.lastActivityAt):'';
  return {
    count:counted?'<strong>'+written.toLocaleString('en-US')+'</strong>of '+total.toLocaleString('en-US')+' personas written':'',
    estimate:counted?esc(draftEstimate(p)):'',
    estimateData:counted?JSON.stringify({totalPersonas:total,completedPersonas:checked,inFlightPersonas:p.phase==='generating'||p.phase==='validating'?p.inFlightPersonas||0:0,totalBatches:p.totalBatches,completedBatches:p.completedBatches,maxConcurrentBatches:p.maxConcurrentBatches,batchDurationsMs:p.batchDurationsMs,completedBatchSizes:p.completedBatchSizes,batchStartedAt:p.batchStartedAt,estimate:p.estimate}):'',
    written:pct(written),checked:pct(checked),
    status:esc(draftStatus(job)),
    detail:esc(detail)+(detail&&activity?' · ':'')+(activity?'<span data-draft-activity="'+attr(p.lastActivityAt)+'">'+esc(activity)+'</span>':''),
  };
}
function draftProgress(job){
  const p=job.progress||{},slots=draftSlots(job);
  const provider=job.engine==='chatgpt'?'ChatGPT':job.engine==='claude'?'Claude Code':'Codex';
  const title=job.cohort?'Generating '+plural(job.cohort.size,'persona'):job.persona?'Generating replacement persona':'Preparing your proposal';
  const counts=slots.count?'<div class="draft-metrics"><p class="draft-count" data-slot="count">'+slots.count+'</p><p class="draft-estimate" data-slot="estimate" data-draft-estimate="'+attr(slots.estimateData)+'">'+slots.estimate+'</p></div><div class="draft-bar" role="progressbar" aria-label="Personas written" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+slots.written+'" data-slot="bar"><span class="draft-bar-written" style="width:'+slots.written+'%"></span><span class="draft-bar-checked" style="width:'+slots.checked+'%"></span></div>':'';
  const shape=(slots.count?'counts':'plain')+(S.localPollError?' error':'')+(job.cohort?' map:'+liveMapSignature(job):'');
  return '<section class="panel draft-progress" aria-label="Generation progress" data-job="'+attr(job.id||'')+'" data-shape="'+shape+'"><div class="draft-progress-heading"><div><h2>'+esc(title)+'</h2><p class="draft-provider">'+esc(provider+(job.model?' · '+job.model:''))+'</p></div><div class="draft-progress-actions">'+(job.startedAt?'<span class="draft-elapsed" data-draft-start="'+attr(job.startedAt)+'">'+esc(draftElapsed(job.startedAt))+'</span>':'')+draftCancelButton(job)+'</div></div>'+counts+'<p class="draft-progress-status" role="status" data-slot="status">'+slots.status+'</p><p class="draft-progress-detail" data-slot="detail">'+slots.detail+'</p>'+liveMap(job)+(S.localPollError?'<p class="warning draft-progress-error" role="alert">Can’t reach the app right now. Checking again every few seconds.</p>':'')+'</section>';
}
/* Updates every visible readout for this job in place. Returns false when a full render is needed. */
function patchDraftProgress(job){
  if(job?.status!=='running'||typeof document.createElement!=='function')return false;
  const nodes=[...root.querySelectorAll('.draft-progress')];
  if(!nodes.length||nodes.some(node=>node.dataset.job!==String(job.id||'')))return false;
  const template=document.createElement('template');template.innerHTML=draftProgress(job);
  const next=template.content.firstElementChild;
  if(!next||nodes.some(node=>node.dataset.shape!==next.dataset.shape))return false;
  for(const node of nodes)next.querySelectorAll('[data-slot]').forEach(slot=>{
    const current=node.querySelector('[data-slot="'+slot.dataset.slot+'"]');if(!current)return;
    if(slot.dataset.slot==='bar'){current.setAttribute('aria-valuenow',slot.getAttribute('aria-valuenow'));[...slot.children].forEach((bar,i)=>{if(current.children[i]&&current.children[i].style.width!==bar.style.width)current.children[i].style.width=bar.style.width});return}
    if(slot.dataset.draftEstimate!==undefined)current.dataset.draftEstimate=slot.dataset.draftEstimate;
    if(current.innerHTML!==slot.innerHTML)current.innerHTML=slot.innerHTML;
  });
  if(job.cohort&&!patchLiveMap(job))return false;
  return true;
}
function updateDraftClocks(){
  const set=(node,text)=>{if(node.textContent!==text)node.textContent=text};
  root.querySelectorAll('[data-draft-estimate]').forEach(node=>{try{set(node,draftEstimate(JSON.parse(node.dataset.draftEstimate)))}catch{}});
  root.querySelectorAll('[data-draft-start]').forEach(node=>set(node,draftElapsed(node.dataset.draftStart)));
  root.querySelectorAll('[data-draft-activity]').forEach(node=>set(node,draftLastEvent(node.dataset.draftActivity)));
}
`;
