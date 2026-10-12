/** The study header always offers the one next thing to do, in words, and the run review opens as a panel on the canvas so a study can go from first question to Run study without leaving it. Nothing here starts inference except the explicit Run study. */
export const STUDY_NEXT_CLIENT = String.raw`
const runSignatures={};
/** Identifies a study's content (not its on-screen layout) so a finished run reads "See results" only until the study changes. */
function studySignature(p){
  const {layout,...rest}=p,text=JSON.stringify(rest);let h=5381;
  for(let i=0;i<text.length;i++)h=((h<<5)+h+text.charCodeAt(i))|0;
  return h+':'+text.length;
}
function rememberRunSignature(runId,p){
  runSignatures[runId]=studySignature(p);
  try{localStorage.setItem('jev-run-study:'+runId,runSignatures[runId])}catch{}
}
function runMatchesStudy(run,p){
  let saved=runSignatures[run.id];
  if(saved===undefined){try{saved=localStorage.getItem('jev-run-study:'+run.id)||undefined}catch{}}
  return saved!==undefined&&saved===studySignature(p);
}
function studyLatestRun(p){
  return projectRuns().filter(r=>r.pipelineId===p.id).reduce((best,r)=>!best||String(r.createdAt)>String(best.createdAt)?r:best,null);
}
function nextTodoText(p,todo){
  const s=p.stages.find(x=>x.id===todo.stageId),suffix=p.stages.length>1?' (step '+(p.stages.indexOf(s)+1)+')':'';
  if(s.kind==='aggregate')return 'choose the answers to combine'+suffix;
  if(s.kind==='decision')return 'choose the answer for the final result'+suffix;
  if(s.kind==='choose'&&todo.tab==='connections')return 'connect what the final choice reads'+suffix;
  if(s.kind==='choose'&&todo.tab==='question')return 'write what the final choice decides'+suffix;
  if(todo.tab==='question')return 'write the question'+suffix;
  if(todo.tab==='answers')return 'add the options'+suffix;
  return (flowSampleShort(p,s)?'lower the sample size':'choose who answers')+suffix;
}
/** A step with no wires in or out, beside other steps, is probably meant to follow the step before it. */
function isolatedStep(p){
  return p.stages.find((s,i)=>i>0&&!s.dependsOn.length&&flowInputs(p,s).length===0&&!p.stages.some(x=>x.dependsOn.includes(s.id)));
}
/** The single next action for a study: first unfinished step (flowTodo order), then wiring, then review, run and results. */
function studyNextAction(p){
  if(!p.stages.length)return {label:'Add your first question',act:'flow-add',kind:'independent'};
  const todo=flowTodo(p)[0];
  if(todo)return {label:'Next: '+nextTodoText(p,todo),act:'flow-fix'};
  const lone=isolatedStep(p);
  if(lone){const n=p.stages.indexOf(lone)+1;return {label:'Next: connect step '+n+' to step '+(n-1),act:'next-connect',id:lone.id,secondary:{label:'Check and run',act:'next-review'}}}
  if(S.plan&&S.reviewPanel&&S.plan.pipelineId===p.id)return {label:'Run study',act:'start-run',disabled:!evaluationReady(S.plan.provider)};
  const run=studyLatestRun(p);
  if(run?.status==='running')return {label:'Watch the run',act:'next-results',id:run.id};
  if(run?.status==='completed'&&runMatchesStudy(run,p))return {label:'See results',act:'next-results',id:run.id};
  return {label:'Check and run',act:'next-review'};
}
function studyNextButtons(p){
  const a=studyNextAction(p);
  return (a.secondary?'<button type="button" class="button" data-act="'+a.secondary.act+'">'+esc(a.secondary.label)+'</button>':'')+
    '<button type="button" class="button primary study-next" data-act="'+a.act+'"'+(a.id?' data-id="'+attr(a.id)+'"':'')+(a.kind?' data-kind="'+a.kind+'"':'')+(a.disabled?' disabled title="Set up the evaluation provider first"':'')+'>'+esc(a.label)+'</button>';
}
/** Steps whose saved answers still match come back from them; Re-run all steps asks every question again. */
function planReusing(plan){return !S.rerunAll&&plan.stages.some(x=>x.reuse&&x.reuse!=='run')}
function planNewRequests(plan){return S.rerunAll||plan.newRequests===undefined?Number(plan.maxRequests||0):plan.newRequests}
function planReusedRequests(plan){return S.rerunAll?0:plan.stages.reduce((n,x)=>n+(x.reuse==='skipped'?0:x.reused||0),0)}
/** The request count a step shows, with what it reuses from earlier runs. */
function stageRequestsText(item,bold=false){
  const count=n=>(bold?'<strong>'+n.toLocaleString('en-US')+'</strong>':n.toLocaleString('en-US'))+(n===1?' request':' requests');
  if(S.rerunAll||!item.reuse||item.reuse==='run')return count(item.requests);
  if(item.reuse==='skipped')return 'Skipped, its condition is false';
  if(item.reuse==='reused')return item.requests?'No new requests':'Same result';
  return (item.requests-item.reused).toLocaleString('en-US')+' new, '+item.reused.toLocaleString('en-US')+' saved';
}
function stageReuseTag(item){
  if(S.rerunAll)return item.reuse&&item.reuse!=='run'?'<span class="reuse-tag reuse-again">Runs again</span>':'';
  if(item.reuse==='reused')return '<span class="reuse-tag reuse-reused">Reused</span>';
  if(item.reuse==='partial')return '<span class="reuse-tag reuse-partial">Partly reused</span>';
  return '';
}
function planRequestsSummary(plan){
  const fresh=planNewRequests(plan),reused=planReusedRequests(plan);
  if(!fresh&&reused)return '<div><strong>No new requests</strong><span>Every step reuses its saved answers</span></div>';
  return '<div><strong>Up to '+fresh.toLocaleString('en-US')+'</strong><span>'+(reused?'new model requests, '+reused.toLocaleString('en-US')+' reused from earlier runs':'model requests')+'</span></div>';
}
/** Offered only when something would be reused, since otherwise every step runs anyway. */
function rerunAllControl(plan){
  if(!plan.stages.some(x=>x.reuse&&x.reuse!=='run'))return '';
  return '<label class="checkrow rerun-all" data-act="rerun-all"><input type="checkbox" '+(S.rerunAll?'checked':'')+'> Re-run all steps</label><p class="subtle rerun-all-help">'+(S.rerunAll?'Every step asks its questions again; saved answers are replaced.':'Steps whose question, audience, inputs and settings are unchanged reuse their saved answers.')+'</p>';
}
/** The run review as a slide-over: what will run, the request bound and the provider, with Run study one click away. The full page keeps run settings. */
function studyReviewPanel(p){
  if(!S.plan||!S.reviewPanel||S.plan.pipelineId!==p.id)return '';
  const plan=S.plan,ready=evaluationReady(plan.provider);
  const rows=plan.stages.map(item=>{const s=p.stages.find(x=>x.id===item.id),title=s?flowNodeTitle(p,s).title:item.label;return '<li class="review-panel-row"><span class="flow-number">'+(p.stages.findIndex(x=>x.id===item.id)+1)+'</span><span class="review-panel-title">'+esc(title)+(item.kind==='choose'&&item.budget?.choose?'<small class="review-panel-reads">'+esc(chooseLead(item.budget.choose))+'</small>':'')+(item.batching?'<small class="review-panel-handoff">'+esc(batchingLead(item)+(handOffLead(item)?' ('+handOffLead(item)+')':''))+'</small>':'')+stageReuseTag(item)+'</span><span class="review-panel-requests">'+esc(stageRequestsText(item))+'</span></li>'}).join('');
  const summary='<div class="run-review-summary'+(plan.cost?' has-cost':'')+' review-panel-summary"><div><strong>'+plural(plan.stages.length,'step')+'</strong><span>in run order</span></div>'+planRequestsSummary(plan)+planCostTile(plan)+'<div><strong>'+esc(evaluationProviderName(plan.provider))+'</strong><span>'+esc(plan.model)+(plan.demo?' · nothing sent or billed':plan.provider==='gliner'?' · runs locally with GLiNER, no billing':' · billed to your TypeSafe account')+'</span></div></div>';
  return '<aside class="flow-inspector round-panel review-panel" aria-label="Before you run" data-inspector-tab="review"><div class="flow-inspector-head"><div class="round-panel-title"><h2 tabindex="-1">Before you run</h2><span class="round-panel-kind">'+esc(studyQuestion(p))+'</span></div><div class="row"><button class="button small icon-button" data-act="flow-panel-close" aria-label="Close" title="Close (Esc)">'+icon('close')+'</button></div></div><div class="flow-inspector-body" role="region" aria-label="Run summary">'+summary+runCaveats(plan)+'<h3>Steps, in run order</h3><ol class="review-panel-steps">'+rows+'</ol>'+rerunAllControl(plan)+'<p class="subtle">Nothing runs until you choose Run study.</p><div class="row"><button type="button" class="button small" data-act="next-review-page">'+icon('list')+' Every detail and run setting</button></div></div><div class="guided-footer"><button type="button" class="button" data-act="next-review-close">Edit study</button><div class="row"><button type="button" class="button" data-act="evaluation-settings" '+(ready?'hidden':'')+'>Set up evaluation provider</button><button type="button" class="button primary" data-act="start-run" '+(ready?'':'disabled')+'>Run study</button></div></div></aside>';
}
function studyNextClick(a,el){
  if(a==='next-review'){reviewPlan(true).catch(fail);return true}
  if(a==='rerun-all'){S.rerunAll=!S.rerunAll;render();return true}
  if(a==='next-review-page'){S.reviewPanel=false;render();return true}
  if(a==='next-review-close'){S.plan=null;S.reviewPanel=false;render();return true}
  if(a==='next-connect'){const p=pipeline();if(!p)return true;S.reviewPanel=false;S.plan=null;S.stageId=el.dataset.id;S.flowPanel=true;S.sections.pipeline='flow';S.sections['flow-inspector']='connections';render();root.querySelector('.flow-inspector h2')?.focus();return true}
  if(a==='next-results'){S.tab='runs';S.plan=null;S.reviewPanel=false;act(null,{dataset:{act:'live-open',id:el.dataset.id}});return true}
  return false;
}
`;

export const STUDY_NEXT_CSS = String.raw`
.study-next{white-space:nowrap}
.review-panel-summary{margin-bottom:12px}.run-review-summary.review-panel-summary.has-cost{grid-template-columns:1fr 1fr}
.review-panel-steps{display:grid;gap:6px;margin:8px 0 14px;padding:0;list-style:none}
.review-panel-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.review-panel-title{min-width:0;overflow-wrap:anywhere;font-size:var(--text-md);font-weight:600}.review-panel-reads{display:block;font-weight:400;font-size:var(--text-sm);color:var(--muted)}.review-panel-handoff{display:block;margin-top:2px;color:var(--muted);font-size:var(--text-sm);font-weight:400}
.review-panel-requests{color:var(--muted);font-size:var(--text-sm);white-space:nowrap}
.reuse-tag{display:inline-block;margin-left:8px;padding:1px 7px;border-radius:999px;font-size:var(--text-xs);font-weight:600;vertical-align:1px;white-space:nowrap}
.reuse-reused{background:var(--teal-soft);color:var(--teal)}
.reuse-partial{background:var(--blue-soft);color:var(--blue)}
.reuse-again{background:var(--amber-soft);color:var(--ink)}
.rerun-all{margin-top:4px;font-size:var(--text-sm);color:var(--ink);cursor:pointer}
.rerun-all-help{margin:2px 0 10px;font-size:var(--text-xs)}
.review-panel .guided-footer .row{gap:8px;flex-wrap:wrap;justify-content:flex-end}

`;
