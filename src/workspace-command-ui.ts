/** Global command navigation and an in-context drafting inspector. */
export const COMMAND_CLIENT = String.raw`
const commandState={open:false,query:'',index:0,page:0,returnFocus:null,focus:null,draftProject:null,busy:false,error:'',answer:'',request:0,job:null,resultIds:null};
function commandEntries(){
  if(!S.doc)return [];
  const rows=[{id:'projects',label:'All projects',detail:'Workspace',action:'projects'},{id:'new-project',label:'New project',detail:'Create research project',action:'new-project'},{id:'settings',label:'AI settings',detail:'Models and providers',action:'ai-open'}];
  if(project())rows.push({id:'studies',label:'Studies',detail:'Current project',action:'tab',tab:'studies'},{id:'new-cohort',label:'New cohort',detail:'Create a synthetic audience',action:'new-cohort'},{id:'project-settings',label:'Project settings',detail:'Name and research brief',action:'project-settings'},{id:'draft',label:'Describe a pipeline',detail:'Create or change steps with natural language',action:'draft-panel-open'},{id:'cohorts',label:'Cohorts',detail:'Current project',action:'tab',tab:'cohorts'},{id:'runs',label:'Live runs and results',detail:'Current project',action:'tab',tab:'runs'});
  if(project()&&!projectPipelines().length)rows.push({id:'new-study',label:'New study',detail:'Create a study',action:'new-study'});
  for(const p of S.doc.projects||[]){
    rows.push({id:'project:'+p.id,label:p.name,detail:'Project',project:p.id});
    for(const pipeline of S.doc.pipelines.filter(x=>p.pipelineIds.includes(x.id))){
      rows.push({id:'pipeline:'+p.id+':'+pipeline.id,label:pipeline.name,detail:p.name+' · Study',search:pipeline.description||'',project:p.id,pipeline:pipeline.id});
      for(const stage of pipeline.stages)rows.push({id:'stage:'+p.id+':'+pipeline.id+':'+stage.id,label:stage.label||stage.id,detail:p.name+' · '+pipeline.name+' · Step',search:JSON.stringify(stage.questions||{}),project:p.id,pipeline:pipeline.id,stage:stage.id});
    }
    for(const cohort of S.doc.cohorts.filter(x=>p.cohortIds.includes(x.id))){
      rows.push({id:'cohort:'+p.id+':'+cohort.id,label:cohort.name,detail:p.name+' · Cohort',search:cohort.description||'',project:p.id,cohort:cohort.id});
      for(const person of cohort.personas||[])rows.push({id:'persona:'+p.id+':'+cohort.id+':'+person.id,label:person.label,detail:p.name+' · '+cohort.name+' · Persona',search:person.background||'',project:p.id,cohort:cohort.id,persona:person.id});
    }
    for(const run of S.snap?.runs||[])if(run.projectId===p.id)rows.push({id:'run:'+p.id+':'+run.id,label:run.pipelineName||run.pipelineId||run.id,detail:p.name+' · Run · '+run.status,search:run.id,project:p.id,run:run.id});
  }
  const terms=commandState.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if(commandState.resultIds)return rows.filter(row=>commandState.resultIds.includes(row.id));
  const score=row=>terms.reduce((n,term)=>n+(row.label.toLocaleLowerCase().includes(term)?3:row.detail.toLocaleLowerCase().includes(term)?1:0),0);
  return rows.filter(row=>terms.every(term=>(row.label+' '+row.detail+' '+(row.search||'')).toLocaleLowerCase().includes(term))).sort((a,b)=>score(b)-score(a));
}
function commandChoices(){const rows=commandEntries();if(commandState.query.trim()&&!rows.length)rows.push({id:'ask-ai',label:'Ask AI: '+commandState.query.trim(),detail:'Search, navigate, or draft something new'});return rows}
function commandResults(){
  const rows=commandChoices(),size=6,pages=Math.max(1,Math.ceil(rows.length/size));commandState.page=Math.min(commandState.page,pages-1);
  const page=rows.slice(commandState.page*size,(commandState.page+1)*size);commandState.index=Math.max(0,Math.min(commandState.index,page.length-1));
  return '<div id="commandOptions" role="listbox" aria-label="Destinations">'+(page.length?page.map((row,i)=>'<button type="button" role="option" tabindex="-1" id="commandOption'+i+'" aria-selected="'+(i===commandState.index)+'" class="command-option" data-act="command-go" data-command-id="'+attr(row.id)+'" '+(row.id==='ask-ai'&&commandState.busy?'aria-disabled="true"':'')+'><span>'+esc(row.label)+'</span><small>'+esc(row.detail)+'</small></button>').join(''):'<p class="command-empty">No matching destinations. Describe what you need to ask AI.</p>')+'</div>'+commandFeedback()+'<div class="command-footer"><small>'+commandEntries().length+' matches · ↑ ↓ navigate · Enter selects</small>'+(commandState.query.trim()?'<button type="button" class="button small" data-act="command-ask" '+(commandState.busy?'disabled':'')+'>Ask AI <span aria-hidden="true">⇧ ↵</span></button>':'')+(pages>1?'<div class="row"><button class="button small" data-act="command-page" data-page="'+(commandState.page-1)+'" '+(!commandState.page?'disabled':'')+' aria-label="Previous destinations">←</button><span>'+(commandState.page+1)+' / '+pages+'</span><button class="button small" data-act="command-page" data-page="'+(commandState.page+1)+'" '+(commandState.page===pages-1?'disabled':'')+' aria-label="Next destinations">→</button></div>':'')+'</div>';
}
function commandFeedback(){return (commandState.busy?'<p class="command-status" role="status">Working on your request…</p>':'')+(commandState.error?'<p class="command-status warning" role="alert">'+esc(commandState.error)+'</p>':'')+(commandState.answer?'<p class="command-status" role="status">'+esc(commandState.answer)+'</p>':'')}
function commandPalette(){return commandState.open?'<div class="command-backdrop"><section class="command-palette" role="dialog" aria-modal="true" aria-label="Go anywhere"><div class="command-search"><label class="sr-only" for="commandSearch">Search workspace or ask AI</label><input id="commandSearch" role="combobox" aria-expanded="true" aria-controls="commandOptions" aria-autocomplete="list" autocomplete="off" placeholder="Search or ask AI to do something…" value="'+attr(commandState.query)+'"><button class="button small" data-act="command-close" aria-label="Close command navigation">Esc</button></div><div id="commandResults">'+commandResults()+'</div></section></div>':''}
function commandJobVisible(){return !!S.projectId&&commandState.draftProject===S.projectId}
function draftSidePanel(){
  if(!commandJobVisible())return '';
  const active=S.localStart||S.localJob,running=active?.status==='running',review=!!active;
  return '<aside class="draft-side-panel" aria-labelledby="draftPanelTitle"><header><div><span class="section-kicker">'+esc(project()?.name||'Project')+'</span><h2 id="draftPanelTitle">Build with words</h2></div><button type="button" class="button small" data-act="draft-panel-close" aria-label="Close drafting panel">'+icon('close')+'</button></header><div class="draft-panel-body">'+(review?'<div class="draft-panel-review">'+proposalReview(active)+'</div>':'')+'<form data-form="assistant"><label for="assistantPrompt">'+(review?'Refine your request':'What should this pipeline do?')+'</label><textarea id="assistantPrompt" class="assistant-prompt" name="localPrompt" rows="5" '+(running?'disabled':'')+' placeholder="Ask gamers which name they prefer, then compare responses across age groups.">'+esc(S.localPrompt)+'</textarea><p class="subtle">Describe your audience, questions, and what happens next. Review changes before applying. Nothing runs automatically.</p><div class="draft-panel-examples" '+(review?'hidden':'')+'><button type="button" class="button small" data-act="draft-example" data-prompt="Compare three product names across two synthetic audience cohorts. Ask for preference, then aggregate results by cohort.">Compare names</button><button type="button" class="button small" data-act="draft-example" data-prompt="Create a synthetic cohort and a pipeline that evaluates a concept, then follows up with people who are interested.">Test a concept</button></div><div class="draft-panel-actions"><button class="button primary" type="button" data-act="assistant-generate" '+(!draftReady()||!S.localPrompt.trim()||S.remoteRevision!==null||running||S.localLoading?'disabled':'')+'>'+(running?'Drafting…':'Draft pipeline')+'</button>'+draftCancelButton(active)+'</div></form>'+(!draftReady()?'<div class="notice">Connect a drafting provider to create a proposal. <button type="button" class="button small" data-act="ai-open">AI settings</button></div>':'')+(S.localError?'<p class="warning" role="alert">'+esc(S.localError)+'</p>':'')+'<p class="subtle">Cohort members are synthetic. Include source facts and identify assumptions.</p></div></aside>';
}
function workspaceCommandUI(){return draftSidePanel()+commandPalette()}
function commandRefreshResults(){const target=document.getElementById('commandResults');if(!target)return;target.innerHTML=commandResults();const input=document.getElementById('commandSearch');if(input){if(commandChoices().length)input.setAttribute('aria-activedescendant','commandOption'+commandState.index);else input.removeAttribute('aria-activedescendant')}}
function commandBeforeRender(){const el=document.activeElement;commandState.searchFocus=el?.id==='commandSearch'?{start:el.selectionStart,end:el.selectionEnd}:null;commandState.draftFocus=el?.id==='assistantPrompt'?{start:el.selectionStart,end:el.selectionEnd,scroll:el.scrollTop}:null}
function commandAfterRender(){root.classList.toggle('has-draft-panel',commandJobVisible());if(commandState.open){commandRefreshResults();const search=document.getElementById('commandSearch');search?.focus();if(search&&commandState.searchFocus)search.setSelectionRange?.(commandState.searchFocus.start,commandState.searchFocus.end)}commandState.searchFocus=null;if(commandState.focus){const selector=commandState.focus;commandState.focus=null;root.querySelector(selector)?.focus()}else if(!commandState.open&&commandState.draftFocus&&commandJobVisible()){const el=document.getElementById('assistantPrompt');if(el&&!el.disabled){el.focus();el.setSelectionRange?.(commandState.draftFocus.start,commandState.draftFocus.end);el.scrollTop=commandState.draftFocus.scroll}}commandState.draftFocus=null}
function commandStop(){commandState.request++;commandState.busy=false;const job=commandState.job;commandState.job=null;if(job)void api('/api/agent/jobs/'+encodeURIComponent(job)+'/cancel','POST',{}).catch(()=>{})}
function commandClose(){commandState.open=false;commandStop();render();const old=commandState.returnFocus;if(old?.isConnected)old.focus();else document.querySelector('[data-act=command-open]')?.focus()}
function commandOpen(){if(!S.snap||S.loading||S.localStarting||document.querySelector('dialog[open]'))return;flushForms();commandState.returnFocus=document.activeElement;commandState.open=true;commandState.query='';commandState.resultIds=null;commandState.error='';commandState.answer='';commandState.index=0;commandState.page=0;commandState.focus='#commandSearch';render()}
function commandExecute(id){
  if(id==='ask-ai'){void commandAskAI();return}
  const row=commandEntries().find(x=>x.id===id);if(!row)return;
  flushForms();commandState.open=false;commandStop();
  if(row.project&&row.project!==S.projectId)selectProject(row.project);
  if(row.pipeline){S.tab='studies';S.pipelineId=row.pipeline;S.stageId=row.stage||pipeline()?.stages[0]?.id||null;S.sections.pipeline='flow';S.sections['flow-inspector']=pipeline()?.stages.find(s=>s.id===S.stageId)?.kind==='poll'?'question':'connections';S.flowCohortPick=false;S.plan=null;render()}
  else if(row.cohort){act(null,{dataset:{act:'open-cohort',id:row.cohort}});if(row.persona)act(null,{dataset:{act:'open-persona',id:row.persona}})}
  else if(row.run){S.tab='runs';S.liveRunId=row.run;S.liveStage='';S.liveMemberKey='';S.plan=null;render()}
  else if(row.action==='new-project'){selectProject(null);act(null,{dataset:{act:'new-project'}})}
  else if(row.action==='new-study'){S.tab='studies';act(null,{dataset:{act:'new-study'}})}
  else if(row.action==='ai-open'){render();act(null,{dataset:{act:'ai-open'}})}
  else if(row.action)act(null,{dataset:{act:row.action,tab:row.tab}});
  else render();
  if(!commandJobVisible())root.querySelector('h1')?.focus();
}
function commandInput(e){if(e.target.id!=='commandSearch')return false;commandStop();commandState.resultIds=null;commandState.error='';commandState.answer='';commandState.query=e.target.value;commandState.page=0;commandState.index=0;commandRefreshResults();return true}
async function commandAskAI(){
  if(commandState.busy||!commandState.query.trim())return;
  commandStop();const request=commandState.request;commandState.error='';commandState.answer='';commandState.busy=true;commandRefreshResults();document.getElementById('commandSearch')?.focus();
  try{
    flushForms();
    if(S.localLoading||S.chatgptLoading)throw Error('AI connection is still loading. Try again in a moment.');
    if(!draftReady())throw Error('Connect a drafting provider and choose a model in AI settings to use AI commands.');
    const projectId=S.projectId,revision=S.revision,documentVersion=JSON.stringify(S.doc),prompt=commandState.query.trim();
    let job=await api('/api/agent/commands','POST',{...(projectId?{projectId}:{}),engine:S.localEngine,...(S.localEngine==='chatgpt'?{model:S.chatgptModel}:{}),prompt,revision,document:S.doc});
    if(request!==commandState.request){if(job.status==='running')void api('/api/agent/jobs/'+encodeURIComponent(job.id)+'/cancel','POST',{}).catch(()=>{});return}
    commandState.job=job.status==='running'?job.id:null;
    while(job.status==='running'){
      await new Promise(resolve=>setTimeout(resolve,600));
      if(request!==commandState.request)return;
      job=await api('/api/agent/jobs/'+encodeURIComponent(job.id));
    }
    commandState.job=null;
    if(request!==commandState.request||!commandState.open)return;
    if(S.projectId!==projectId||S.revision!==revision||JSON.stringify(S.doc)!==documentVersion)throw Error('Your workspace changed. Ask again using the current view.');
    if(job.status!=='completed'||!job.commandResult)throw Error(job.message||'AI could not complete this request. Try again.');
    const result=job.commandResult;
    if(result.kind==='navigate'){
      commandState.query='';commandState.resultIds=null;
      if(!commandEntries().some(row=>row.id===result.destination))throw Error('That destination is no longer available. Search again.');
      commandExecute(result.destination);
    }else if(result.kind==='search'){
      commandState.resultIds=result.destinations;commandState.page=0;commandState.index=0;commandState.answer=job.message||'Choose a matching destination.';
    }else if(result.kind==='draft'){
      commandState.open=false;
      if(result.destination){commandState.query='';commandState.resultIds=null;const destination=commandEntries().find(row=>row.id===result.destination);if(!destination?.project||!result.destination.startsWith('project:'))throw Error('That project is no longer available.');if(destination.project!==S.projectId)selectProject(destination.project)}
      if(result.target==='project'){selectProject(null);S.projectName=result.name||'';S.projectBrief=result.prompt;act(null,{dataset:{act:'new-project'}})}
      else{
        if(!project())throw Error('Open a project before creating a cohort or study.');
        if(result.target==='cohort'){act(null,{dataset:{act:'new-cohort'}});S.cohortPrompt=result.prompt;render()}
        else{S.localPrompt=result.prompt;commandAction('draft-panel-open',{dataset:{}})}
      }
    }
  }catch(error){if(request===commandState.request){commandState.error=error instanceof Error?error.message:String(error);if(!commandState.open){commandState.open=true;render()}}}
  finally{if(request===commandState.request){commandState.busy=false;commandRefreshResults()}}
}
async function commandApplyProposal(){
  const before=new Map(S.doc.pipelines.map(p=>[p.id,JSON.stringify(p)])),projectId=S.projectId;
  await applyLocalProposal();
  if(!S.proposalApplied||S.projectId!==projectId)return;
  const candidates=projectPipelines(),target=candidates.find(p=>!before.has(p.id))||candidates.find(p=>before.get(p.id)!==JSON.stringify(p))||pipeline()||candidates[0];
  commandState.draftProject=null;
  if(target){S.tab='studies';S.pipelineId=target.id;S.stageId=target.stages[0]?.id||null;S.sections.pipeline='flow';S.sections['flow-inspector']=target.stages[0]?.kind==='poll'?'question':'connections';S.flowCohortPick=false;S.plan=null}
  render();root.querySelector('h1')?.focus();
}
function commandAction(a,el){
  if(a==='assistant-apply'&&commandJobVisible()){commandApplyProposal().catch(fail);return true}
  if(a==='command-ask'){void commandAskAI();return true}
  if(a==='command-open'){commandOpen();return true}
  if(a==='command-close'){commandClose();return true}
  if(a==='command-page'){commandState.page=Math.max(0,Number(el.dataset.page));commandState.index=0;commandRefreshResults();document.getElementById('commandSearch')?.focus();return true}
  if(a==='command-go'){commandExecute(el.dataset.commandId);return true}
  if(a==='draft-panel-open'){if(!project())throw Error('Open a project first.');commandState.draftProject=S.projectId;if(el.dataset.prompt&&!S.localPrompt)S.localPrompt=el.dataset.prompt;commandState.focus='#assistantPrompt';render();void loadLocalAgents();return true}
  if(a==='draft-panel-close'){commandState.draftProject=null;render();root.querySelector('[data-act=draft-panel-open]')?.focus();return true}
  if(a==='draft-example'){S.localPrompt=el.dataset.prompt;commandState.focus='#assistantPrompt';render();return true}
  return false;
}
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();try{if(commandState.open)commandClose();else commandOpen()}catch(error){fail(error)}return}
  if(!commandState.open){if(e.key==='Escape'&&commandJobVisible()&&!document.querySelector('dialog[open]')){e.preventDefault();try{flushForms();commandAction('draft-panel-close',{dataset:{}})}catch(error){fail(error)}}return}
  if(e.key==='Escape'){e.preventDefault();commandClose();return}
  if(e.isComposing)return;
  if(e.target.id==='commandSearch'&&['ArrowDown','ArrowUp','Enter','Home','End'].includes(e.key)){
    e.preventDefault();const rows=commandChoices(),page=rows.slice(commandState.page*6,(commandState.page+1)*6);
    if(e.key==='Enter'){if(e.shiftKey&&commandState.query.trim()){void commandAskAI();return}if(page[commandState.index])try{commandExecute(page[commandState.index].id)}catch(error){fail(error)}return}
    const count=Math.max(1,rows.length),position=e.key==='Home'?0:e.key==='End'?count-1:(commandState.page*6+commandState.index+(e.key==='ArrowDown'?1:-1)+count)%count;commandState.page=Math.floor(position/6);commandState.index=position%6;commandRefreshResults();return;
  }
  if(e.key==='Tab'){const nodes=[...root.querySelectorAll('.command-palette input,.command-palette button:not([disabled]):not([tabindex="-1"])')];const first=nodes[0],last=nodes[nodes.length-1];if(!nodes.includes(document.activeElement)){e.preventDefault();first?.focus()}else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus()}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus()}}
});
`;

export const COMMAND_CSS = `
.command-backdrop{position:fixed;inset:0;z-index:90;background:rgba(15,24,32,.3);display:flex;justify-content:center;align-items:flex-start;padding:clamp(20px,12vh,100px) 16px 16px;overflow:auto}
.command-palette{width:min(620px,100%);background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 24px 80px #0003;overflow:hidden}.command-search{display:flex;gap:12px;padding:14px;border-bottom:1px solid var(--line);align-items:center}.command-search .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.command-search input{border:0;background:transparent;font:inherit;min-width:0;flex:1;padding:8px}.command-option{display:grid;gap:4px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);padding:12px 18px;font:inherit;cursor:pointer;overflow-wrap:anywhere}.command-option[aria-selected=true],.command-option:hover{background:var(--blue-soft)}.command-option small,.command-footer{color:var(--muted);font-size:11px}.command-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px}.command-empty{padding:20px;color:var(--muted)}.command-status{padding:12px 18px;margin:0;font-size:13px;overflow-wrap:anywhere}.command-palette{max-height:calc(100dvh - 40px);overflow:auto}.command-search{position:sticky;top:0;background:var(--surface);z-index:1}.command-option:focus-visible{outline:2px solid var(--blue);outline-offset:-3px}
.draft-side-panel{position:fixed;right:0;top:52px;bottom:0;width:390px;max-width:100%;z-index:12;background:var(--surface);border-left:1px solid var(--line);box-shadow:-8px 0 30px #00000008;display:flex;flex-direction:column}.draft-side-panel>header{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line);gap:10px}.draft-side-panel h2{font-size:18px;margin:5px 0 0}.draft-panel-body{padding:16px 18px;overflow:auto;min-height:0}.draft-panel-body label{font-size:12px;font-weight:650;display:block;margin-bottom:8px}.draft-panel-body textarea{width:100%;box-sizing:border-box;min-height:100px;resize:vertical}.draft-panel-body .panel{padding:10px}.draft-panel-body .proposal-diff{gap:8px}.draft-panel-body .proposal-items{max-height:180px;overflow:auto}.draft-panel-actions,.draft-panel-examples{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.draft-panel-actions{position:sticky;bottom:0;background:var(--surface);padding:10px 0}.has-draft-panel .shell{margin-right:390px;max-width:none}.draft-panel-review .panelhead p,.draft-panel-body .assistant-scope{font-size:11px}
@media(max-width:1000px){.draft-side-panel{width:340px}.has-draft-panel .shell{margin-right:340px}}
@media(max-width:700px){.draft-side-panel{width:min(100%,420px);top:52px}.has-draft-panel .shell{margin-right:0}.command-footer{flex-wrap:wrap}.command-search{gap:6px}.command-option{padding:10px 14px}}
`;
