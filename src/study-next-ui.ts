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
  if(lone){const n=p.stages.indexOf(lone)+1;return {label:'Next: connect step '+n+' to step '+(n-1),act:'next-connect',id:lone.id,secondary:{label:'Review run',act:'next-review'}}}
  if(S.plan&&S.reviewPanel&&S.plan.pipelineId===p.id)return {label:'Run study',act:'start-run',disabled:!evaluationReady(S.plan.provider)};
  const run=studyLatestRun(p);
  if(run?.status==='running')return {label:'Watch the run',act:'next-results',id:run.id};
  if(run?.status==='completed'&&runMatchesStudy(run,p))return {label:'See results',act:'next-results',id:run.id};
  return {label:'Review run',act:'next-review'};
}
function studyNextButtons(p){
  const a=studyNextAction(p);
  return (a.secondary?'<button type="button" class="button" data-act="'+a.secondary.act+'">'+esc(a.secondary.label)+'</button>':'')+
    '<button type="button" class="button primary study-next" data-act="'+a.act+'"'+(a.id?' data-id="'+attr(a.id)+'"':'')+(a.kind?' data-kind="'+a.kind+'"':'')+(a.disabled?' disabled title="Set up the evaluation provider first"':'')+'>'+esc(a.label)+'</button>';
}
/** The run review as a slide-over: what will run, the request bound and the provider, with Run study one click away. The full page keeps run settings. */
function studyReviewPanel(p){
  if(!S.plan||!S.reviewPanel||S.plan.pipelineId!==p.id)return '';
  const plan=S.plan,ready=evaluationReady(plan.provider);
  const rows=plan.stages.map(item=>{const s=p.stages.find(x=>x.id===item.id),title=s?flowNodeTitle(p,s).title:item.label;return '<li class="review-panel-row"><span class="flow-number">'+(p.stages.findIndex(x=>x.id===item.id)+1)+'</span><span class="review-panel-title">'+esc(title)+'</span><span class="review-panel-requests">'+item.requests.toLocaleString('en-US')+(item.requests===1?' request':' requests')+'</span></li>'}).join('');
  const summary='<div class="run-review-summary review-panel-summary"><div><strong>'+plural(plan.stages.length,'step')+'</strong><span>in run order</span></div><div><strong>Up to '+Number(plan.maxRequests||0).toLocaleString('en-US')+'</strong><span>model requests</span></div><div><strong>'+esc(evaluationProviderName(plan.provider))+'</strong><span>'+esc(plan.model)+(plan.provider==='gliner'?' · runs locally with GLiNER, no billing':' · billed to your TypeSafe account')+'</span></div></div>';
  return '<aside class="flow-inspector round-panel review-panel" aria-label="Review run" data-inspector-tab="review"><div class="flow-inspector-head"><div class="round-panel-title"><h2 tabindex="-1">Review run</h2><span class="round-panel-kind">'+esc(studyQuestion(p))+'</span></div><div class="row"><button class="button small icon-button" data-act="flow-panel-close" aria-label="Close review" title="Close (Esc)">'+icon('close')+'</button></div></div><div class="flow-inspector-body" role="region" aria-label="Run summary">'+summary+runCaveats(plan)+'<h3>Steps, in run order</h3><ol class="review-panel-steps">'+rows+'</ol><p class="subtle">Nothing runs until you choose Run study. <button type="button" class="link-button" data-act="next-review-page">See every detail and run settings</button></p></div><div class="guided-footer"><button type="button" class="button" data-act="next-review-close">Edit study</button><div class="row"><button type="button" class="button" data-act="evaluation-settings" '+(ready?'hidden':'')+'>Set up evaluation provider</button><button type="button" class="button primary" data-act="start-run" '+(ready?'':'disabled')+'>Run study</button></div></div></aside>';
}
function studyNextClick(a,el){
  if(a==='next-review'){reviewPlan(true).catch(fail);return true}
  if(a==='next-review-page'){S.reviewPanel=false;render();return true}
  if(a==='next-review-close'){S.plan=null;S.reviewPanel=false;render();return true}
  if(a==='next-connect'){const p=pipeline();if(!p)return true;S.reviewPanel=false;S.plan=null;S.stageId=el.dataset.id;S.flowPanel=true;S.sections.pipeline='flow';S.sections['flow-inspector']='connections';render();root.querySelector('.flow-inspector h2')?.focus();return true}
  if(a==='next-results'){S.tab='runs';S.plan=null;S.reviewPanel=false;act(null,{dataset:{act:'live-open',id:el.dataset.id}});return true}
  return false;
}
`;

export const STUDY_NEXT_CSS = String.raw`
.study-next{white-space:nowrap}
.review-panel-summary{margin-bottom:12px}
.review-panel-steps{display:grid;gap:6px;margin:8px 0 14px;padding:0;list-style:none}
.review-panel-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
.review-panel-title{min-width:0;overflow-wrap:anywhere;font-size:13px;font-weight:600}
.review-panel-requests{color:var(--muted);font-size:12px;white-space:nowrap}
.review-panel .guided-footer .row{gap:8px;flex-wrap:wrap;justify-content:flex-end}
.link-button{appearance:none;border:0;background:transparent;padding:0;color:var(--blue);font:inherit;text-decoration:underline;cursor:pointer}
`;
