/** Global command navigation and an in-context drafting inspector. */
export const COMMAND_CLIENT = String.raw`
const commandState={open:false,query:'',index:0,page:0,returnFocus:null,focus:null,draftProject:null,busy:false,error:'',answer:'',request:0,job:null,resultIds:null,material:'',filename:'',fileError:'',reading:false,readVersion:0,scopeCleared:false,target:null,asked:''};
/** What the palette is looking at: the open step or study, cohort or run of the open project. Asking AI from a study proposes edits to that study. */
function commandScope(){
  const owner=project();if(!owner||commandState.scopeCleared)return null;
  const p=pipeline();
  if(S.tab==='studies'&&p){const s=S.flowPanel===true&&p.stages.find(x=>x.id===S.stageId);return s?{kind:'step',label:'Step',name:stepTitle(p,s),pipelineId:p.id,stageId:s.id}:{kind:'study',label:'Study',name:commandStudyLabel(p),pipelineId:p.id}}
  const c=S.tab==='cohorts'&&cohort();if(c)return {kind:'cohort',label:'Cohort',name:c.name};
  const run=S.tab==='runs'&&(S.snap?.runs||[]).find(r=>r.id===S.liveRunId&&r.projectId===owner.id);if(run){const study=S.doc.pipelines.find(x=>x.id===run.pipelineId);return {kind:'run',label:'Run',name:study?commandStudyLabel(study):(run.pipelineName||run.id)}}
  return {kind:'project',label:'Project',name:owner.name};
}
/** A study with steps is edited in place; an empty one is drafted from scratch as before. */
function commandEditsStudy(scope=commandScope()){return (scope?.kind==='study'||scope?.kind==='step')&&!!projectPipelines().find(p=>p.id===scope.pipelineId)?.stages.length}
function commandScopeChip(){const scope=commandScope();if(!scope)return '';return '<span class="command-scope" title="'+attr(scope.label+': '+scope.name)+'"><span class="command-scope-kind">'+esc(scope.label)+'</span><span class="command-scope-name">'+esc(scope.name)+'</span><button type="button" class="command-scope-clear" data-act="command-scope-clear" aria-label="Search everywhere instead of '+attr(scope.label.toLowerCase()+' '+scope.name)+'">'+icon('close')+'</button></span>'}
/** The study a drafting request changes: the one the user asked from, while it still exists in this project. */
function draftTarget(){const t=commandState.target,p=t&&projectPipelines().find(x=>x.id===t.pipelineId);if(!p)return null;return t.stageId&&p.stages.some(s=>s.id===t.stageId)?{pipelineId:p.id,stageId:t.stageId}:{pipelineId:p.id}}
function draftTargetLabel(){const t=draftTarget(),p=t&&projectPipelines().find(x=>x.id===t.pipelineId);if(!p)return '';const s=t.stageId&&p.stages.find(x=>x.id===t.stageId);return commandStudyLabel(p)+(s?' · '+stepTitle(p,s):'')}
function commandStudyLabel(p){return p.description?.trim()||(typeof p.context?.decisionQuestion==='string'&&p.context.decisionQuestion.trim())||p.name||'Untitled study'}
/** Plain-language changes between two versions of a study, step by step, so a proposal can be checked before it is applied. */
function studyEdits(before,after,beforeDoc=S.doc,afterDoc=beforeDoc){
  const out=[],name=(p,s)=>s.label?.trim()||stepTitle(p,s).replace(/^\d+\. /,''),quote=x=>'“'+String(x??'').replace(/\s+/g,' ').trim()+'”';
  const cohortName=(p,doc,alias)=>{const id=p.cohorts?.[alias]??alias;return (doc.cohorts||[]).find(c=>c.id===id)?.name||id};
  const reads=(p,s)=>new Set([...s.dependsOn||[],...flowInputs(p,s).map(([,input])=>input.stage)].filter(Boolean));
  const options=q=>q?.type==='choice'?Object.entries(q.criteria||{}).map(([k,v])=>optionName(k,v)):q?.type==='score'?(q.criteria||[]).map(String):[];
  if(before.name!==after.name)out.push('Study renamed '+quote(before.name)+' → '+quote(after.name));
  if((before.description||'')!==(after.description||''))out.push('Research question '+(before.description?quote(before.description)+' → ':'set to ')+quote(after.description));
  const old=new Map(before.stages.map(s=>[s.id,s]));
  after.stages.forEach((s,i)=>{
    const was=old.get(s.id),n='Step '+(i+1);
    if(!was){out.push('Added '+n+': '+quote(name(after,s)));return}
    const notes=[];
    if((was.label||'')!==(s.label||'')&&was.label&&s.label)notes.push('renamed '+quote(was.label)+' → '+quote(s.label));
    if(was.kind!==s.kind)notes.push('now a '+(s.kind==='poll'?'question':s.kind==='choose'?'final answer':s.kind)+' step');
    for(const [qid,q] of Object.entries(s.questions||{})){
      const p=was.questions?.[qid];
      if(!p){notes.push('new question '+quote(q.label));continue}
      if(p.label!==q.label)notes.push('question '+quote(p.label)+' → '+quote(q.label));
      if(p.type!==q.type)notes.push('answer type '+p.type+' → '+q.type);
      const a=options(p),b=options(q),added=b.filter(x=>!a.includes(x)),removed=a.filter(x=>!b.includes(x));
      if(added.length)notes.push('adds option'+(added.length>1?'s ':' ')+added.map(quote).join(', '));
      if(removed.length)notes.push('drops option'+(removed.length>1?'s ':' ')+removed.map(quote).join(', '));
      if(!added.length&&!removed.length&&p.type===q.type&&JSON.stringify(a)!==JSON.stringify(b))notes.push('reorders its options');
      if((p.instructions||'')!==(q.instructions||''))notes.push('instructions reworded');
    }
    for(const [qid,p] of Object.entries(was.questions||{}))if(!s.questions?.[qid])notes.push('removes question '+quote(p.label));
    if(was.kind==='poll'&&s.kind==='poll'){
      const a=cohortName(before,beforeDoc,was.cohort),b=cohortName(after,afterDoc,s.cohort);
      if(a!==b)notes.push('asks '+quote(b)+' instead of '+quote(a));
      if((was.size||0)!==(s.size||0))notes.push('sample '+(was.size||'all')+' → '+(s.size||'all'));
    }
    const ra=reads(before,was),rb=reads(after,s),title=id=>{const x=after.stages.find(t=>t.id===id)||before.stages.find(t=>t.id===id);return x?quote(name(after.stages.includes(x)?after:before,x)):id};
    const gained=[...rb].filter(x=>!ra.has(x)),lost=[...ra].filter(x=>!rb.has(x));
    if(gained.length)notes.push('now reads from '+gained.map(title).join(', '));
    if(lost.length)notes.push('stops reading from '+lost.map(title).join(', '));
    if(JSON.stringify(was.when||null)!==JSON.stringify(s.when||null))notes.push(s.when?'branch rule '+(was.when?'changed':'added'):'branch rule removed');
    if(!notes.length&&JSON.stringify({...was,questions:undefined})!==JSON.stringify({...s,questions:undefined}))notes.push('settings changed');
    if(notes.length)out.push(n+' '+quote(name(after,s))+': '+notes.join('; '));
  });
  for(const s of before.stages)if(!after.stages.some(x=>x.id===s.id))out.push('Removed step '+quote(name(before,s)));
  return out;
}
function studyEditList(before,after,beforeDoc,afterDoc){const items=studyEdits(before,after,beforeDoc,afterDoc);return items.length?'<ul class="study-edits">'+items.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':''}
function commandEntries(){
  if(!S.doc)return [];
  const rows=[{id:'projects',label:'All projects',detail:'Workspace',action:'projects'},{id:'new-project',label:'New project',detail:'Create research project',action:'new-project'},{id:'settings',label:'AI settings',detail:'Models and providers',action:'ai-open'}];
  if(project())rows.push({id:'studies',label:'Studies',detail:'Current project',action:'tab',tab:'studies'},{id:'new-cohort',label:'New cohort',detail:'Create a synthetic audience',action:'new-cohort'},{id:'project-settings',label:'Project settings',detail:'Name and research brief',action:'project-settings'},{id:'draft',label:'Describe a study',detail:'Create or change steps with natural language',action:'draft-panel-open'},{id:'cohorts',label:'Cohorts',detail:'Current project',action:'tab',tab:'cohorts'},{id:'runs',label:'Live runs and results',detail:'Current project',action:'tab',tab:'runs'});
  if(project()&&pipeline()?.stages.length)rows.push({id:'review-run',label:'Check and run',detail:'Current study · see what will run, then start it',action:'next-review'});
  if(project()&&!projectPipelines().length)rows.push({id:'new-study',label:'New study',detail:'Create a study',action:'new-study'});
  for(const p of S.doc.projects||[]){
    rows.push({id:'project:'+p.id,label:p.name,detail:'Project',project:p.id});
    for(const pipeline of S.doc.pipelines.filter(x=>p.pipelineIds.includes(x.id))){
      rows.push({id:'pipeline:'+p.id+':'+pipeline.id,label:commandStudyLabel(pipeline),detail:p.name+' · Study',search:pipeline.name,project:p.id,pipeline:pipeline.id});
      for(const stage of pipeline.stages)rows.push({id:'stage:'+p.id+':'+pipeline.id+':'+stage.id,label:stepTitle(pipeline,stage).replace(/^\d+\. /,''),detail:p.name+' · '+commandStudyLabel(pipeline)+' · Step',search:(stage.label||'')+' '+JSON.stringify(stage.questions||{}),project:p.id,pipeline:pipeline.id,stage:stage.id});
    }
    for(const cohort of S.doc.cohorts.filter(x=>p.cohortIds.includes(x.id))){
      rows.push({id:'cohort:'+p.id+':'+cohort.id,label:cohort.name,detail:p.name+' · Cohort',search:cohort.description||'',project:p.id,cohort:cohort.id});
      for(const person of cohort.personas||[])rows.push({id:'persona:'+p.id+':'+cohort.id+':'+person.id,label:person.label,detail:p.name+' · '+cohort.name+' · Persona',search:person.background||'',project:p.id,cohort:cohort.id,persona:person.id});
    }
    for(const run of S.snap?.runs||[])if(run.projectId===p.id)rows.push({id:'run:'+p.id+':'+run.id,label:(()=>{const owner=S.doc.pipelines.find(x=>x.id===run.pipelineId);return owner?commandStudyLabel(owner):(run.pipelineName||run.pipelineId||run.id)})(),detail:p.name+' · Run · '+run.status,search:run.id,project:p.id,run:run.id});
  }
  const terms=commandState.query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if(commandState.resultIds)return rows.filter(row=>commandState.resultIds.includes(row.id));
  const score=row=>terms.reduce((n,term)=>n+(row.label.toLocaleLowerCase().includes(term)?3:row.detail.toLocaleLowerCase().includes(term)?1:0),0);
  return rows.filter(row=>terms.every(term=>(row.label+' '+row.detail+' '+(row.search||'')).toLocaleLowerCase().includes(term))).sort((a,b)=>score(b)-score(a));
}
function commandChoices(){const rows=commandEntries(),edit=commandEditsStudy();if(commandState.query.trim()&&!rows.length)rows.push(edit?{id:'ask-ai',label:'Ask AI to change this '+commandScope().kind+': '+commandState.query.trim(),detail:'Proposes edits to review before anything changes'}:{id:'ask-ai',label:'Ask AI: '+commandState.query.trim(),detail:'Search, navigate, or draft something new'});return rows}
function commandResults(){
  const rows=commandChoices(),size=6,pages=Math.max(1,Math.ceil(rows.length/size));commandState.page=Math.min(commandState.page,pages-1);
  const page=rows.slice(commandState.page*size,(commandState.page+1)*size);commandState.index=Math.max(0,Math.min(commandState.index,page.length-1));
  return '<div id="commandOptions" role="listbox" aria-label="Destinations">'+(page.length?page.map((row,i)=>'<button type="button" role="option" tabindex="-1" id="commandOption'+i+'" aria-selected="'+(i===commandState.index)+'" class="command-option" data-act="command-go" data-command-id="'+attr(row.id)+'" '+(row.id==='ask-ai'&&commandState.busy?'aria-disabled="true"':'')+'><span>'+esc(row.label)+'</span><small>'+esc(row.detail)+'</small></button>').join(''):'<p class="command-empty">No matching destinations. Describe what you need to ask AI.</p>')+'</div>'+commandFeedback()+'<div class="command-footer"><small>'+commandEntries().length+' matches · ↑ ↓ navigate · Enter selects</small>'+(commandState.query.trim()?'<button type="button" class="button small" data-act="command-ask" '+(commandState.busy?'disabled':'')+'>'+(commandEditsStudy()?'Edit with AI':'Ask AI')+' <span aria-hidden="true">⇧ ↵</span></button>':'')+(pages>1?'<div class="row"><button class="button small" data-act="command-page" data-page="'+(commandState.page-1)+'" '+(!commandState.page?'disabled':'')+' aria-label="Previous destinations">←</button><span>'+(commandState.page+1)+' / '+pages+'</span><button class="button small" data-act="command-page" data-page="'+(commandState.page+1)+'" '+(commandState.page===pages-1?'disabled':'')+' aria-label="Next destinations">→</button></div>':'')+'</div>';
}
function commandFeedback(){return (commandState.busy?'<p class="command-status" role="status">Working on your request…</p>':'')+(commandState.error?'<p class="command-status warning" role="alert">'+esc(commandState.error)+'</p>':'')+(commandState.answer?'<p class="command-status" role="status">'+esc(commandState.answer)+'</p>':'')}
function commandPalette(){return commandState.open?'<div class="command-backdrop"><section class="command-palette" role="dialog" aria-modal="true" aria-label="Go anywhere"><div class="command-search">'+commandScopeChip()+'<label class="sr-only" for="commandSearch">'+(commandEditsStudy()?'Search workspace or ask AI to change this '+commandScope().kind:'Search workspace or ask AI')+'</label><input id="commandSearch" role="combobox" aria-expanded="true" aria-controls="commandOptions" aria-autocomplete="list" autocomplete="off" placeholder="'+(commandEditsStudy()?'Search, or ask AI to change this '+commandScope().kind+'…':'Search or ask AI to do something…')+'" value="'+attr(commandState.query)+'"><button class="button small" data-act="command-close" aria-label="Close command navigation">Esc</button></div><div id="commandResults">'+commandResults()+'</div></section></div>':''}
function commandJobVisible(){return !!S.projectId&&commandState.draftProject===S.projectId}
function draftAttach(running){
  const sent=!commandState.filename?(S.localStart||S.localJob)?.materialName:'';
  const input='<input id="assistantFile" type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" hidden>';
  const body=commandState.filename?'<div class="draft-attach-file"><span class="draft-attach-name" title="'+attr(commandState.filename)+'">'+esc(commandState.filename)+'</span><button type="button" class="button small" data-act="draft-attach-remove" '+(running?'disabled':'')+'>Remove file</button></div><p class="subtle">Sent with your request as source material.</p>':'<button type="button" class="draft-drop" data-act="draft-attach-choose" '+(running||commandState.reading?'disabled':'')+'>'+(commandState.reading?'Reading file…':'Drop a file here, or choose file')+'<span>TXT, Markdown, CSV or JSON · up to 256 KiB</span></button>';
  return '<div class="draft-attach">'+input+(sent?'<p class="subtle draft-attach-sent">Sent with this request: <strong title="'+attr(sent)+'">'+esc(sent)+'</strong></p>':'')+body+(commandState.fileError?'<p class="warning" role="alert">'+esc(commandState.fileError)+'</p>':'')+'</div>';
}
async function draftAttachRead(file){
  if(!file||commandState.reading)return;const version=++commandState.readVersion;commandState.reading=true;commandState.fileError='';render();
  try{const text=await materialReadFile(file);if(commandState.readVersion!==version)return;commandState.material=text;commandState.filename=file.name}
  catch(error){if(commandState.readVersion===version)commandState.fileError=error instanceof Error?error.message:String(error)}
  finally{if(commandState.readVersion===version){commandState.reading=false;commandState.focus='#assistantPrompt';render()}}
}
function draftAttachClear(){commandState.readVersion++;commandState.reading=false;commandState.material='';commandState.filename='';commandState.fileError=''}
function draftMaterial(){return commandJobVisible()&&commandState.material?{material:commandState.material,materialName:commandState.filename}:{}}
function draftSidePanel(){
  if(!commandJobVisible())return '';
  const active=S.localStart||S.localJob,running=active?.status==='running',review=!!active,edit=!!draftTarget();
  return '<aside class="draft-side-panel" aria-labelledby="draftPanelTitle"><header><div><span class="section-kicker">'+esc(project()?.name||'Project')+'</span><h2 id="draftPanelTitle">'+(edit?'Edit study with assistant':'Draft with assistant')+'</h2></div><button type="button" class="button small" data-act="draft-panel-close" aria-label="Close drafting panel">'+icon('close')+'</button></header><div class="draft-panel-body">'+(edit?draftEditBody(active,running,review):draftNewBody(active,running,review))+(!draftReady()?'<div class="notice">Connect a drafting provider to create a proposal. <button type="button" class="button small" data-act="ai-open">AI settings</button></div>':'')+(S.localError?'<p class="warning" role="alert">'+esc(S.localError)+'</p>':'')+(edit?'':'<p class="subtle">Cohort members are synthetic. Include source facts and identify assumptions.</p>')+'</div></aside>';
}
function draftGenerateDisabled(running){return !draftReady()||!S.localPrompt.trim()||S.remoteRevision!==null||running||S.localLoading||commandState.reading}
/** Drafting from scratch: the request box, source material and examples. The progress card carries Cancel while it runs. */
function draftNewBody(active,running,review){
  return (review?'<div class="draft-panel-review">'+proposalReview(active)+'</div>':'')+'<form data-form="assistant"><label for="assistantPrompt">'+(review?'Refine your request':'What should this study do?')+'</label><textarea id="assistantPrompt" class="assistant-prompt" name="localPrompt" rows="5" '+(running?'disabled':'')+' placeholder="Ask gamers which name they prefer, then compare responses across age groups.">'+esc(S.localPrompt)+'</textarea><p class="subtle">Describe your audience, questions, and what happens next. Review changes before applying. Nothing runs automatically.</p>'+draftAttach(running)+'<div class="draft-panel-examples" '+(review?'hidden':'')+'><button type="button" class="button small" data-act="draft-example" data-prompt="Compare three product names across two synthetic audience cohorts. Ask for preference, then aggregate results by cohort.">Compare names</button><button type="button" class="button small" data-act="draft-example" data-prompt="Create a synthetic cohort and a study that evaluates a concept, then follows up with people who are interested.">Test a concept</button></div><div class="draft-panel-actions"><button class="button primary" type="button" data-act="assistant-generate" '+(draftGenerateDisabled(running)?'disabled':'')+'>'+(running?'Drafting…':'Draft study')+'</button></div></form>';
}
/** Editing the open study: what is being changed, the request as asked, the proposal, and a box for a further change once it is ready. */
function draftEditBody(active,running,review){
  const asked=review&&commandState.asked,applied=S.proposalApplied&&!running;
  return '<p class="draft-target"><span>Changing</span> <strong title="'+attr(draftTargetLabel())+'">'+esc(draftTargetLabel())+'</strong> <button type="button" class="button small" data-act="draft-target-clear" '+(running?'disabled':'')+'>Draft something new</button></p>'
    +(asked?'<figure class="draft-request"><figcaption>Your request</figcaption><blockquote>'+esc(asked)+'</blockquote></figure>':'')
    +(review?'<div class="draft-panel-review">'+proposalReview(active)+'</div>':'')
    +(running?'':'<form data-form="assistant"><label for="assistantPrompt">'+(review&&!applied?'Ask for a further change':'What should change?')+'</label><textarea id="assistantPrompt" class="assistant-prompt" name="localPrompt" rows="3" placeholder="Add a step that asks the same players whether they would buy it.">'+esc(S.localPrompt)+'</textarea><div class="draft-panel-actions"><button class="button primary" type="button" data-act="assistant-generate" '+(draftGenerateDisabled(false)?'disabled':'')+'>'+(review&&!applied?'Revise proposal':'Propose changes')+'</button></div></form>');
}
/** Starts a focused edit. A further change to a proposal not yet applied is asked together with the original request, since every draft starts from the saved study. */
async function draftEditStart(){
  const extra=S.localPrompt.trim();if(!extra)return;
  const pending=S.localJob&&S.localJob.status==='completed'&&!S.proposalApplied&&commandState.asked;
  const prompt=pending?commandState.asked+'\n\nAlso: '+extra:extra;
  if(!draftReady())throw Error('Choose an available drafting provider and a model in AI settings.');
  commandState.asked=prompt;S.localPrompt='';
  await startDraftJob(()=>({prompt,focus:draftTarget()}));
}
function workspaceCommandUI(){return draftSidePanel()+commandPalette()}
function commandRefreshResults(){const target=document.getElementById('commandResults');if(!target)return;target.innerHTML=commandResults();const input=document.getElementById('commandSearch');if(input){if(commandChoices().length)input.setAttribute('aria-activedescendant','commandOption'+commandState.index);else input.removeAttribute('aria-activedescendant')}}
function commandBeforeRender(){if(commandState.draftProject&&S.flowPanel===true)commandState.draftProject=null;const el=document.activeElement;commandState.searchFocus=el?.id==='commandSearch'?{start:el.selectionStart,end:el.selectionEnd}:null;commandState.draftFocus=el?.id==='assistantPrompt'?{start:el.selectionStart,end:el.selectionEnd,scroll:el.scrollTop}:null}
function commandAfterRender(){root.classList.toggle('has-draft-panel',commandJobVisible());if(commandState.open){commandRefreshResults();const search=document.getElementById('commandSearch');search?.focus();if(search&&commandState.searchFocus)search.setSelectionRange?.(commandState.searchFocus.start,commandState.searchFocus.end)}commandState.searchFocus=null;if(commandState.focus){const selector=commandState.focus;commandState.focus=null;root.querySelector(selector)?.focus()}else if(!commandState.open&&commandState.draftFocus&&commandJobVisible()){const el=document.getElementById('assistantPrompt');if(el&&!el.disabled){el.focus();el.setSelectionRange?.(commandState.draftFocus.start,commandState.draftFocus.end);el.scrollTop=commandState.draftFocus.scroll}}commandState.draftFocus=null}
function commandStop(){commandState.request++;commandState.busy=false;const job=commandState.job;commandState.job=null;if(job)void api('/api/agent/jobs/'+encodeURIComponent(job)+'/cancel','POST',{}).catch(()=>{})}
function commandClose(){commandState.open=false;commandStop();render();const old=commandState.returnFocus;if(old?.isConnected)old.focus();else document.querySelector('[data-act=command-open]')?.focus()}
function commandOpen(){if(!S.snap||S.loading||S.localStarting||document.querySelector('dialog[open]'))return;flushForms();commandState.returnFocus=document.activeElement;commandState.open=true;commandState.scopeCleared=false;commandState.query='';commandState.resultIds=null;commandState.error='';commandState.answer='';commandState.index=0;commandState.page=0;commandState.focus='#commandSearch';render()}
function commandExecute(id){
  if(id==='ask-ai'){void commandAskAI();return}
  const row=commandEntries().find(x=>x.id===id);if(!row)return;
  flushForms();commandState.open=false;commandStop();
  if(row.project&&row.project!==S.projectId)selectProject(row.project);
  if(row.pipeline){S.tab='studies';S.pipelineId=row.pipeline;S.stageId=row.stage||pipeline()?.stages[0]?.id||null;S.sections.pipeline='flow';S.sections['flow-inspector']=pipeline()?.stages.find(s=>s.id===S.stageId)?.kind==='poll'?'question':'connections';S.flowCohortPick=false;S.plan=null;render()}
  else if(row.cohort){act(null,{dataset:{act:'open-cohort',id:row.cohort}});if(row.persona)act(null,{dataset:{act:'open-persona',id:row.persona}})}
  else if(row.run){S.tab='runs';S.liveRunId=row.run;S.liveStage='';S.liveMemberKey='';S.plan=null;render()}
  else if(row.action==='new-project'){selectProject(null);act(null,{dataset:{act:'new-project'}})}
  else if(row.action==='new-study'){act(null,{dataset:{act:'create-study'}})}
  else if(row.action==='ai-open'){render();act(null,{dataset:{act:'ai-open'}})}
  else if(row.action==='next-review'){S.tab='studies';S.sections.pipeline='flow';render();reviewPlan(true).catch(fail);return}
  else if(row.action)act(null,{dataset:{act:row.action,tab:row.tab}});
  else render();
  if(!commandJobVisible())root.querySelector('h1')?.focus();
}
function commandInput(e){if(e.target.id!=='commandSearch')return false;commandStop();commandState.resultIds=null;commandState.error='';commandState.answer='';commandState.query=e.target.value;commandState.page=0;commandState.index=0;commandRefreshResults();return true}
/** From a study or step, the request goes straight to the drafting assistant with that study as its focus; the proposal opens in the side panel for review. */
async function commandEditStudy(scope,prompt=commandState.query.trim()){
  if(S.localLoading||S.chatgptLoading)throw Error('AI connection is still loading. Try again in a moment.');
  if(!draftReady())throw Error('Connect a drafting provider and choose a model in AI settings to edit with AI.');
  if(S.localStarting||S.localJob?.status==='running')throw Error('The assistant is still working on another draft. Wait for it or cancel it first.');
  flushForms();
  commandState.open=false;commandStop();commandState.query='';commandState.resultIds=null;
  commandState.target={pipelineId:scope.pipelineId,...(scope.stageId?{stageId:scope.stageId}:{})};
  commandState.asked=prompt;S.localPrompt='';draftAttachClear();commandState.draftProject=S.projectId;S.flowPanel=false;
  await startDraftJob(()=>({prompt,focus:draftTarget()}));
}
async function commandAskAI(){
  if(commandState.busy||!commandState.query.trim())return;
  const scope=commandScope();
  if(commandEditsStudy(scope)){try{await commandEditStudy(scope)}catch(error){commandState.error=error instanceof Error?error.message:String(error);if(!commandState.open){commandState.open=true;render()}else commandRefreshResults()}return}
  commandStop();const request=commandState.request;commandState.error='';commandState.answer='';commandState.busy=true;commandRefreshResults();document.getElementById('commandSearch')?.focus();
  try{
    flushForms();
    if(S.localLoading||S.chatgptLoading)throw Error('AI connection is still loading. Try again in a moment.');
    if(!draftReady())throw Error('Connect a drafting provider and choose a model in AI settings to use AI commands.');
    const projectId=S.projectId,revision=S.revision,documentVersion=JSON.stringify(S.doc),prompt=commandState.query.trim();
    let job=await api('/api/agent/commands','POST',{...(projectId?{projectId}:{}),engine:S.localEngine,...(S.localEngine==='chatgpt'?{model:S.chatgptModel}:S.byos?.model?.[S.localEngine]?{model:S.byos.model[S.localEngine]}:{}),prompt,revision,document:S.doc});
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
        else{const study=(pipeline()?.stages.length&&pipeline())||projectPipelines().find(p=>p.stages.length);if(study){await commandEditStudy({pipelineId:study.id},prompt);return}S.localPrompt=result.prompt;commandAction('draft-panel-open',{dataset:{}})}
      }
    }
  }catch(error){if(request===commandState.request){commandState.error=error instanceof Error?error.message:String(error);if(!commandState.open){commandState.open=true;render()}}}
  finally{if(request===commandState.request){commandState.busy=false;commandRefreshResults()}}
}
async function commandApplyProposal(){
  const before=new Map(S.doc.pipelines.map(p=>[p.id,JSON.stringify(p)])),projectId=S.projectId,previous=JSON.parse(JSON.stringify(S.doc)),from={pipelineId:S.pipelineId,stageId:S.stageId},focus=draftTarget();
  await applyLocalProposal();
  if(!S.proposalApplied||S.projectId!==projectId)return;
  const candidates=projectPipelines(),focused=focus&&candidates.find(p=>p.id===focus.pipelineId),target=candidates.find(p=>!before.has(p.id))||candidates.find(p=>p===focused&&before.get(p.id)!==JSON.stringify(p))||candidates.find(p=>before.get(p.id)!==JSON.stringify(p))||focused||pipeline()||candidates[0];
  commandState.draftProject=null;commandState.target=null;draftAttachClear();
  if(audienceQueued().length){await audienceNext();return}
  const step=focus?.pipelineId===target?.id&&target.stages.find(s=>s.id===focus.stageId)||target?.stages[0];
  if(target){S.tab='studies';S.pipelineId=target.id;S.stageId=step?.id||null;S.sections.pipeline='flow';S.sections['flow-inspector']=step?.kind==='poll'?'question':'connections';S.flowCohortPick=false;S.plan=null}
  // The applied proposal is saved; Undo saves the workspace as it was, while nothing has changed since.
  S.stepUndo=[...(S.stepUndo||[]).slice(-19),{kind:'assistant',before:previous,after:JSON.stringify(S.doc),pipelineId:target?.id||null,stageId:S.stageId,from}];
  render();root.querySelector('h1')?.focus();
  sayUndo(focused&&target===focused?'Applied the assistant’s changes to this study.':'Applied the assistant’s changes.');
}
/** Puts the workspace back as it was before the assistant's proposal was applied, and saves it. */
function undoAssistantProposal(undo){
  if(JSON.stringify(S.doc)!==undo.after||S.remoteRevision!==null){S.stepUndo=[];say('The workspace changed after those edits, so they can no longer be undone.');return true}
  S.stepUndo.pop();S.doc=undo.before;S.dirty=true;S.plan=null;S.reviewPanel=false;
  // Back to the study the edit changed, or to where the user was if the edit had created it.
  const back=[{pipelineId:undo.pipelineId,stageId:undo.stageId},undo.from].find(x=>x?.pipelineId&&projectPipelines().some(p=>p.id===x.pipelineId));
  if(back){S.tab='studies';S.pipelineId=back.pipelineId;S.stageId=pipeline().stages.some(s=>s.id===back.stageId)?back.stageId:pipeline().stages[0]?.id||null}
  retainSelections();render();
  save({throwOnError:true}).then(()=>say('Assistant changes undone.'),fail);
  return true;
}
function commandAction(a,el){
  if(a==='assistant-apply'&&commandJobVisible()){commandApplyProposal().catch(fail);return true}
  if(a==='assistant-generate'&&commandJobVisible()&&draftTarget()){draftEditStart().catch(fail);return true}
  if(a==='command-ask'){void commandAskAI();return true}
  if(a==='command-open'){commandOpen();return true}
  if(a==='command-close'){commandClose();return true}
  if(a==='command-scope-clear'){commandState.scopeCleared=true;commandState.error='';commandState.focus='#commandSearch';render();return true}
  if(a==='draft-target-clear'){commandState.target=null;commandState.focus='#assistantPrompt';render();return true}
  if(a==='command-page'){commandState.page=Math.max(0,Number(el.dataset.page));commandState.index=0;commandRefreshResults();document.getElementById('commandSearch')?.focus();return true}
  if(a==='command-go'){commandExecute(el.dataset.commandId);return true}
  if(a==='draft-panel-open'){if(!project())throw Error('Open a project first.');const scope=commandScope();if(!commandJobVisible())commandState.target=commandEditsStudy(scope)?{pipelineId:scope.pipelineId,...(scope.stageId?{stageId:scope.stageId}:{})}:null;commandState.draftProject=S.projectId;S.flowPanel=false;if(el.dataset.prompt&&!S.localPrompt)S.localPrompt=el.dataset.prompt;commandState.focus='#assistantPrompt';render();void loadLocalAgents();return true}
  if(a==='draft-panel-close'){commandState.draftProject=null;render();root.querySelector('[data-act=draft-panel-open]')?.focus();return true}
  if(a==='draft-attach-choose'){document.getElementById('assistantFile')?.click();return true}
  if(a==='draft-attach-remove'){draftAttachClear();commandState.focus='[data-act=draft-attach-choose]';render();return true}
  if(a==='draft-example'){S.localPrompt=el.dataset.prompt;commandState.focus='#assistantPrompt';render();return true}
  return false;
}
document.addEventListener('change',e=>{if(e.target.id==='assistantFile')void draftAttachRead(e.target.files?.[0])});
document.addEventListener('dragover',e=>{if(e.target.closest?.('.draft-drop'))e.preventDefault()});
document.addEventListener('drop',e=>{if(!e.target.closest?.('.draft-drop'))return;e.preventDefault();if(e.dataTransfer?.files?.length!==1){commandState.fileError='Drop one file at a time.';render();return}void draftAttachRead(e.dataTransfer.files[0])});
document.addEventListener('keydown',e=>{
  if((e.metaKey||e.ctrlKey)&&!e.altKey&&e.key.toLowerCase()==='s'){e.preventDefault();if(S.dirty)act(null,{dataset:{act:'save'}});return}
  if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();try{if(commandState.open)commandClose();else commandOpen()}catch(error){fail(error)}return}
  if(!commandState.open){if(arenaEscape(e))return;if(e.key==='Escape'&&commandJobVisible()&&!document.querySelector('dialog[open]')){e.preventDefault();try{flushForms();commandAction('draft-panel-close',{dataset:{}})}catch(error){fail(error)}}return}
  if(e.key==='Escape'){e.preventDefault();commandClose();return}
  if(e.isComposing)return;
  if(e.target.id==='commandSearch'&&e.key==='Backspace'&&!e.target.value&&commandScope()){e.preventDefault();commandAction('command-scope-clear',{dataset:{}});return}
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
.command-palette{width:min(620px,100%);background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 24px 80px #0003;overflow:hidden}.command-search{display:flex;gap:12px;padding:14px;border-bottom:1px solid var(--line);align-items:center}.command-search .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}.command-search input{border:0;background:transparent;font:inherit;min-width:0;flex:1;padding:8px}.command-option{display:grid;gap:4px;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);padding:12px 18px;font:inherit;cursor:pointer;overflow-wrap:anywhere}.command-option[aria-selected=true],.command-option:hover{background:var(--blue-soft)}.command-option small,.command-footer{color:var(--muted);font-size:var(--text-xs)}.command-footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px}.command-empty{padding:20px;color:var(--muted)}.command-status{padding:12px 18px;margin:0;font-size:var(--text-md);overflow-wrap:anywhere}.command-palette{max-height:calc(100dvh - 40px);overflow:auto}.command-search{position:sticky;top:0;background:var(--surface);z-index:1}.command-option:focus-visible{outline:2px solid var(--blue);outline-offset:-3px}
.command-scope{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:45%;flex:none;padding:3px 4px 3px 9px;border-radius:999px;background:var(--blue-soft);color:var(--ink);font-size:var(--text-sm)}.command-scope-kind{color:var(--muted);font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.04em;flex:none}.command-scope-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;min-width:0}.command-scope-clear{display:inline-grid;place-items:center;flex:none;width:22px;height:22px;border:0;border-radius:50%;background:transparent;color:var(--muted);cursor:pointer;padding:0}.command-scope-clear svg{width:13px;height:13px}.command-scope-clear:hover,.command-scope-clear:focus-visible{background:var(--surface);color:var(--ink);outline:none}.command-scope-clear:focus-visible{box-shadow:0 0 0 2px var(--blue)}
.study-edits{margin:6px 0 2px;padding-left:18px;display:grid;gap:4px;font-size:var(--text-sm)}.study-edits li{overflow-wrap:anywhere}
.draft-request{margin:0 0 12px}.draft-request figcaption{font-size:var(--text-xs);color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px}.draft-request blockquote{margin:0;padding:8px 12px;border-left:3px solid var(--blue);background:var(--raised);border-radius:0 var(--radius-control) var(--radius-control) 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:var(--text-md)}
.draft-target{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 12px;padding:8px 10px;border-radius:var(--radius-control);background:var(--blue-soft);font-size:var(--text-sm)}.draft-target>span{color:var(--muted)}.draft-target strong{min-width:0;flex:1;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.draft-side-panel{position:fixed;right:0;top:52px;bottom:0;width:390px;max-width:100%;z-index:12;background:var(--surface);border-left:1px solid var(--line);box-shadow:-8px 0 30px #00000008;display:flex;flex-direction:column}.draft-side-panel>header{display:flex;justify-content:space-between;align-items:center;padding:16px 18px;border-bottom:1px solid var(--line);gap:10px}.draft-side-panel h2{font-size:var(--text-lg);margin:5px 0 0}.draft-panel-body{padding:16px 18px;overflow:auto;min-height:0}.draft-panel-body label{font-size:var(--text-sm);font-weight:600;display:block;margin-bottom:8px}.draft-panel-body textarea{width:100%;box-sizing:border-box;min-height:100px;resize:vertical}.draft-panel-body .panel{padding:10px}.draft-panel-body .proposal-diff{gap:8px}.draft-panel-body .proposal-items{max-height:320px;overflow:auto}.draft-panel-actions,.draft-panel-examples{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.draft-panel-actions{position:sticky;bottom:0;background:var(--surface);padding:10px 0}.has-draft-panel .shell{margin-right:390px;max-width:none}.draft-attach{margin:12px 0}.draft-attach .subtle{margin:6px 0 0;font-size:var(--text-sm)}.draft-drop{width:100%;padding:14px 12px;text-align:center;background:var(--raised);border:1px dashed var(--control-line);border-radius:var(--radius-control);font:inherit;color:var(--ink);cursor:pointer}.draft-drop span{display:block;color:var(--muted);font-size:var(--text-sm);margin-top:4px}.draft-drop:hover:not(:disabled){border-color:var(--blue);background:var(--hover)}.draft-drop:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.draft-attach-file{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:8px 10px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--raised)}.draft-attach-name{min-width:0;overflow-wrap:anywhere;font-weight:600;font-size:var(--text-md)}.proposal-explanation p,.proposal-explanation ul{margin:0 0 8px}.proposal-explanation ul{padding-left:20px}.proposal-explanation li{margin:2px 0}.proposal-explanation code{font-size:.92em}.proposal-summary{display:grid;gap:6px;margin:10px 0}.proposal-summary div{display:flex;gap:8px;align-items:baseline}.proposal-summary dt{min-width:64px;color:var(--muted);font-size:var(--text-sm)}.proposal-summary dd{margin:0}.proposal-summary dd small{color:var(--muted)}.draft-panel-review .panelhead p,.draft-panel-body .assistant-scope{font-size:var(--text-xs)}
@media(max-width:1000px){.draft-side-panel{width:340px}.has-draft-panel .shell{margin-right:340px}}
@media(max-width:700px){.command-search:has(.command-scope){flex-wrap:wrap}.command-scope{max-width:100%}.command-search input{min-width:min(200px,100%)}.draft-side-panel{width:min(100%,420px);top:52px}.has-draft-panel .shell{margin-right:0}.command-footer{flex-wrap:wrap}.command-search{gap:6px}.command-option{padding:10px 14px}}
`;
