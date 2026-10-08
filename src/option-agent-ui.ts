/** Candidate drafting uses the selected agent; applying a proposal edits one question only. */
export const OPTION_AGENT_DIALOG = `
<dialog id="optionAgentDialog" class="auth-dialog option-agent-dialog" aria-labelledby="optionAgentTitle">
<button type="button" class="close-dialog" data-act="option-agent-close" aria-label="Close option draft">×</button>
<h2 id="optionAgentTitle">Create options with agent</h2>
<p id="optionAgentQuestion" class="subtle"></p>
<div id="optionAgentCompose">
<label class="field" for="optionAgentPrompt">What should the options be?<textarea id="optionAgentPrompt" rows="4" maxlength="10000" placeholder="Extract game names and their descriptions from my file, or suggest 12 names for a space strategy game."></textarea></label>
<button type="button" class="option-agent-drop" data-act="option-agent-file">Drop notes, CSV or JSON here, or choose file<span>TXT, Markdown, CSV or JSON · up to 256 KiB</span></button>
<input id="optionAgentFile" type="file" accept=".txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json" hidden>
<div class="option-agent-file-row"><span id="optionAgentFilename" class="subtle"></span><button type="button" class="button small" data-act="option-agent-remove-file" id="optionAgentRemoveFile" hidden>Remove file</button></div>
<div class="option-agent-file-row"><p id="optionAgentProvider" class="subtle"></p><button type="button" class="button small" data-act="option-agent-settings">AI settings</button></div>
</div>
<div id="optionAgentProgress" role="status" hidden></div>
<div id="optionAgentPreview" class="option-agent-preview" hidden></div>
<p id="optionAgentError" class="warning" role="alert" hidden></p>
<div class="option-agent-actions"><button type="button" class="button" data-act="option-agent-close" id="optionAgentClose">Cancel</button><button type="button" class="button" data-act="option-agent-retry" id="optionAgentRetry" hidden>Retry status</button><button type="button" class="button" data-act="option-agent-cancel" id="optionAgentCancel" hidden>Cancel drafting</button><button type="button" class="button primary" data-act="option-agent-start" id="optionAgentStart">Prepare options</button><button type="button" class="button primary" data-act="option-agent-apply" id="optionAgentApply" hidden>Use these options</button></div>
<p class="option-agent-scope subtle">Only options change after review. Your question, cohort and other steps stay intact. Drafting uses AI selected above; no study runs.</p>
</dialog>`;

export const OPTION_AGENT_CLIENT = String.raw`
let optionAgentDraft=null;
const optionAgentEl=id=>document.getElementById('optionAgent'+id);
function optionAgentTarget(d=optionAgentDraft){
  const p=S.doc?.pipelines.find(p=>p.id===d?.pipelineId),s=p?.stages.find(s=>s.id===d?.stageId),q=s?.questions?.[d?.questionId];
  if(!d||S.projectId!==d.projectId||S.pipelineId!==d.pipelineId||S.stageId!==d.stageId||q?.type!=='choice'||JSON.stringify(q)!==d.snapshot)throw Error('This question changed. Close this draft and prepare options again.');
  return q;
}
function optionAgentOpen(){
  if(optionAgentDraft?.starting||optionAgentDraft?.job?.status==='running'){if(!optionAgentEl('Dialog').open)optionAgentEl('Dialog').showModal();optionAgentUpdate();return}
  flushForms();const p=pipeline(),s=selectedStage(),entry=s&&setupQuestion(s);
  if(!p||entry?.[1]?.type!=='choice')return;
  optionAgentDraft={projectId:S.projectId,pipelineId:p.id,stageId:s.id,questionId:entry[0],snapshot:JSON.stringify(entry[1]),page:0,material:'',filename:'',readVersion:0,reading:false,job:null,starting:false,error:null,records:null};
  optionAgentEl('Prompt').value='';optionAgentEl('File').value='';optionAgentEl('Question').textContent=entry[1].label;
  optionAgentEl('Dialog').showModal();optionAgentUpdate();optionAgentEl('Prompt').focus();
}
function optionAgentClose(){if(optionAgentDraft?.starting||optionAgentDraft?.job?.status==='running')return;optionAgentEl('Dialog').close();optionAgentDraft=null}
function optionAgentError(error,d=optionAgentDraft){if(optionAgentDraft!==d)return;d.error=error instanceof Error?error.message:String(error);optionAgentUpdate()}
function optionAgentRecords(job,d){
  const q=job.proposal?.document?.pipelines?.find(p=>p.id===d.pipelineId)?.stages.find(s=>s.id===d.stageId)?.questions?.[d.questionId];
  if(q?.type!=='choice'||!q.criteria||typeof q.criteria!=='object'||Array.isArray(q.criteria))throw Error('Agent returned no options for this question. Try a more specific request.');
  const records=Object.entries(q.criteria).map(([key,value])=>({label:String(optionName(key,value)).trim(),description:String(optionDescription(value))}));
  if(records.length<2||records.length>255||records.some(r=>!r.label)||new Set(records.map(r=>r.label)).size!==records.length)throw Error('Agent options need 2–255 different, nonempty names. Prepare again.');
  return records;
}
function optionAgentUpdate(){
  const d=optionAgentDraft;if(!d)return;const running=d.starting||d.job?.status==='running',ready=!!d.records;
  optionAgentEl('Compose').hidden=running||ready;optionAgentEl('Progress').hidden=!running;optionAgentEl('Preview').hidden=!ready;
  optionAgentEl('Close').hidden=running;optionAgentEl('Cancel').hidden=!running;optionAgentEl('Cancel').disabled=d.starting;
  optionAgentEl('Retry').hidden=!running||!d.error||d.starting;
  optionAgentEl('Dialog').querySelector('.close-dialog').hidden=running;
  optionAgentEl('Start').hidden=running||ready;optionAgentEl('Apply').hidden=!ready;optionAgentEl('Apply').disabled=false;
  optionAgentEl('Start').disabled=d.reading||!draftReady()||S.localLoading||S.localStarting||S.localJob?.status==='running'||S.remoteRevision!==null||(!optionAgentEl('Prompt').value.trim()&&!d.material);
  optionAgentEl('Provider').textContent=draftReady()?'Uses '+(S.localEngine==='chatgpt'?'ChatGPT · '+S.chatgptModel:S.localEngine)+'.':'Choose your drafting AI using the AI button above.';
  optionAgentEl('Filename').textContent=d.filename;optionAgentEl('RemoveFile').hidden=!d.filename;
  if(running){const progress=d.job?.progress,phase=progress?.phase;optionAgentEl('Progress').textContent=d.starting?'Saving current edits and starting draft…':phase==='validating'?'Checking option names and descriptions…':phase==='checking'?'Connecting to your drafting AI…':progress?.activity==='receiving'?'Receiving options'+(progress.outputChars?' · '+progress.outputChars.toLocaleString('en-US')+' characters':'')+'…':'Preparing options…';}
  if(ready){const pages=Math.ceil(d.records.length/5);d.page=Math.max(0,Math.min(d.page,pages-1));const start=d.page*5;optionAgentEl('Preview').innerHTML='<strong>'+d.records.length+' options ready to review</strong><ol start="'+(start+1)+'">'+d.records.slice(start,start+5).map(r=>'<li><strong>'+esc(r.label)+'</strong>'+(r.description?'<p>'+esc(r.description)+'</p>':'')+'</li>').join('')+'</ol>'+(pages>1?'<div class="row"><button type="button" class="button small" data-act="option-agent-prev" '+(!d.page?'disabled':'')+'>Previous</button><span>'+(start+1)+'–'+Math.min(start+5,d.records.length)+' of '+d.records.length+'</span><button type="button" class="button small" data-act="option-agent-next" '+(d.page===pages-1?'disabled':'')+'>Next</button></div>':'');try{optionAgentTarget()}catch(error){d.error=error.message;optionAgentEl('Apply').disabled=true}}
  optionAgentEl('Error').textContent=d.error||'';optionAgentEl('Error').hidden=!d.error;
}
async function optionAgentReadFile(file){
  const d=optionAgentDraft;if(!d||!file||d.starting||d.job?.status==='running')return;const version=++d.readVersion;d.reading=true;optionAgentEl('File').value='';optionAgentUpdate();
  try{
    if(!/\.(txt|md|csv|json)$/i.test(file.name))throw Error('Choose a TXT, Markdown, CSV or JSON file.');
    if(file.size>256*1024)throw Error('File is too large. Maximum size is 256 KiB.');
    const text=await file.text();if(optionAgentDraft!==d||d.readVersion!==version||!optionAgentEl('Dialog').open||d.starting||d.job?.status==='running')return;
    if(new TextEncoder().encode(text).length>256*1024)throw Error('File is too large. Maximum size is 256 KiB.');
    if(text.includes('\u0000')||text.includes('\ufffd'))throw Error('Use a UTF-8 text file. Binary or invalid text cannot be read.');
    if(!text.trim())throw Error('File is empty. Choose a file with your candidate names or notes.');
    d.material=text;d.filename=file.name;d.error=null;optionAgentUpdate();
  }catch(error){if(optionAgentDraft===d&&d.readVersion===version)optionAgentError(error,d)}finally{if(optionAgentDraft===d&&d.readVersion===version){d.reading=false;optionAgentUpdate()}}
}
async function optionAgentStart(){
  const d=optionAgentDraft;if(!d||d.starting||d.job?.status==='running')return;
  if(d.reading){optionAgentError(Error('Wait for your file to finish reading.'),d);return}
  try{
    flushForms();optionAgentTarget(d);if(!draftReady())throw Error('Choose drafting AI using the AI button above.');if(S.localLoading||S.localStarting||S.localJob?.status==='running')throw Error('Another draft is running. Wait or cancel it first.');if(S.remoteRevision!==null)throw Error('Saved workspace changed. Reload it before drafting.');
    const prompt=optionAgentEl('Prompt').value.trim()||'Extract candidate option names and descriptions from the supplied material. Preserve their meaning; do not invent candidates.';
    if(!optionAgentEl('Prompt').value.trim()&&!d.material)throw Error('Describe your options or add a file.');if(prompt.length>10000)throw Error('Keep your request under 10,000 characters.');
    d.starting=true;d.error=null;d.records=null;S.localLoading=true;optionAgentUpdate();
    await save({throwOnError:true});optionAgentTarget(d);
    d.job=await api('/api/agent/jobs','POST',{projectId:d.projectId,engine:S.localEngine,...(S.localEngine==='chatgpt'?{model:S.chatgptModel}:{}),prompt,revision:S.revision,options:{pipelineId:d.pipelineId,stageId:d.stageId,questionId:d.questionId,...(d.material?{material:d.material}:{})}});
    S.localJob=d.job;d.starting=false;S.localLoading=false;optionAgentUpdate();await optionAgentPoll(d);
  }catch(error){optionAgentError(error,d)}finally{d.starting=false;S.localLoading=false;if(optionAgentDraft===d)optionAgentUpdate()}
}
async function optionAgentPoll(d){
  try{while(d.job?.status==='running'){await new Promise(resolve=>setTimeout(resolve,1000));if(optionAgentDraft!==d||d.job.status!=='running')return;const job=await api('/api/agent/jobs/'+encodeURIComponent(d.job.id));if(d.job.status!=='running')return;d.job=job;S.localJob=job;optionAgentUpdate()}
    if(d.job?.status==='completed'){d.records=optionAgentRecords(d.job,d);d.error=null;optionAgentUpdate()}
    else if(d.job?.status==='failed')throw Error(d.job.message||'Draft failed. Try again.');
  }catch(error){optionAgentError(error,d)}
}
async function optionAgentCancel(){const d=optionAgentDraft;if(!d||d.starting||d.job?.status!=='running')return;try{const job=await api('/api/agent/jobs/'+encodeURIComponent(d.job.id)+'/cancel','POST',{});if(optionAgentDraft!==d)return;d.job=job;S.localJob=job;d.error=null;optionAgentUpdate()}catch(error){optionAgentError(error,d)}}
function optionAgentApply(){
  flushForms();const d=optionAgentDraft,q=optionAgentTarget(d);if(!d.records||d.job?.status!=='completed')throw Error('Prepare and review options first.');
  const used=new Set(),criteria={},old=Object.entries(q.criteria);
  for(const record of d.records){let key=old.find(([key,value])=>!used.has(key)&&optionName(key,value)===record.label)?.[0];if(!key){do{key='option_'+id()}while(Object.hasOwn(q.criteria,key)||used.has(key))}used.add(key);const previous=q.criteria[key];criteria[key]={...(previous&&typeof previous==='object'&&!Array.isArray(previous)?previous:{}),label:record.label,description:record.description}}
  q.criteria=criteria;S.dirty=true;S.plan=null;optionAgentClose();render();say('Options added to this question. Review your study before running.');
}
function optionAgentAction(a,el){
  if(!a.startsWith('option-agent-'))return false;
  if(a==='option-agent-open')optionAgentOpen();else if(a==='option-agent-close')optionAgentClose();else if(a==='option-agent-settings')aiSettingsAction('ai-open',el);else if(a==='option-agent-file')optionAgentEl('File').click();else if(a==='option-agent-remove-file'){if(optionAgentDraft){optionAgentDraft.readVersion++;optionAgentDraft.reading=false;optionAgentDraft.material='';optionAgentDraft.filename='';optionAgentDraft.error=null;optionAgentUpdate()}}
  else if(a==='option-agent-retry'&&optionAgentDraft?.job?.status==='running'){optionAgentDraft.error=null;optionAgentUpdate();void optionAgentPoll(optionAgentDraft)}
  else if(a==='option-agent-start')void optionAgentStart();else if(a==='option-agent-cancel')void optionAgentCancel();else if(a==='option-agent-apply'){try{optionAgentApply()}catch(error){optionAgentError(error)}}else if(optionAgentDraft&&(a==='option-agent-prev'||a==='option-agent-next')){optionAgentDraft.page+=a==='option-agent-prev'?-1:1;optionAgentUpdate()}
  return true;
}
document.addEventListener('input',e=>{if(e.target.id==='optionAgentPrompt'&&optionAgentDraft){optionAgentDraft.error=null;optionAgentUpdate()}});
document.addEventListener('change',e=>{if(e.target.id==='optionAgentFile')void optionAgentReadFile(e.target.files?.[0])});
document.addEventListener('dragover',e=>{if(e.target.closest?.('.option-agent-drop'))e.preventDefault()});
document.addEventListener('drop',e=>{if(!e.target.closest?.('.option-agent-drop'))return;e.preventDefault();if(e.dataTransfer?.files?.length!==1){optionAgentError(Error('Drop one file at a time.'));return}void optionAgentReadFile(e.dataTransfer.files[0])});
document.getElementById('optionAgentDialog').addEventListener('cancel',e=>{e.preventDefault();optionAgentClose()});
`;

export const OPTION_AGENT_CSS = `
.option-agent-dialog{width:min(620px,calc(100vw - 32px));max-height:calc(100dvh - 32px);overflow:auto}.option-agent-dialog h2{margin:0 32px 8px 0}.option-agent-dialog .field{display:grid;gap:8px}.option-agent-drop{width:100%;padding:18px 12px;text-align:center;background:var(--raised);border:1px dashed var(--control-line);border-radius:var(--radius-control);font:inherit;color:var(--ink);cursor:pointer}.option-agent-drop span{display:block;color:var(--muted);font-size:12px;margin-top:6px}.option-agent-drop:hover{border-color:var(--blue);background:var(--hover)}.option-agent-drop:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.option-agent-file-row,.option-agent-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px}.option-agent-file-row span{overflow-wrap:anywhere;flex:1}.option-agent-actions{justify-content:flex-end;padding-top:12px;border-top:1px solid var(--line)}.option-agent-preview ol{padding-left:22px}.option-agent-preview li{padding:8px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}.option-agent-preview li p{margin:4px 0 0;font-size:12px;color:var(--muted);white-space:pre-wrap}.option-agent-scope{font-size:12px;margin-bottom:0}#optionAgentProgress{padding:20px 0;font-weight:600}#optionAgentProvider{font-size:12px}.option-agent-dialog [hidden]{display:none!important}
`;
