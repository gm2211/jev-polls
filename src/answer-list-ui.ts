import { parseAnswerCsv } from './answer-csv.js';

/** Local-only bulk editing; the existing criteria contracts remain unchanged. */
export const ANSWER_LIST_DIALOG = `
<dialog id="answerListDialog" class="auth-dialog answer-list-dialog" aria-labelledby="answerListTitle">
<button type="button" class="close-dialog" data-act="answer-list-close" aria-label="Close answer list">×</button>
<h2 id="answerListTitle">Populate answers</h2><p id="answerListHint" class="subtle"></p>
<div class="field"><label for="answerListText">Comma-separated or one per line</label><textarea id="answerListText" rows="3" maxlength="262144" placeholder='Low, Medium, High' aria-describedby="answerListFormat"></textarea><small id="answerListFormat">Put quotes around labels containing commas: "Fast, reliable", Affordable</small></div>
<div class="row"><button type="button" class="button small" data-act="answer-list-file">Choose CSV file</button><span id="answerListFilename" class="subtle"></span><input id="answerListFile" type="file" accept=".csv,text/csv" hidden></div>
<div id="answerListMapping" class="answer-list-mapping" hidden><div class="field"><label for="answerListColumn">Use values from</label><select id="answerListColumn"></select></div><label class="checkrow"><input id="answerListHeader" type="checkbox">First row is a header</label></div>
<p id="answerListError" class="answer-list-error" role="alert" hidden></p>
<div id="answerListPreview" class="answer-list-preview" aria-live="polite"></div>
<div class="answer-list-actions"><button type="button" class="button" data-act="answer-list-close">Cancel</button><button id="answerListAppend" type="button" class="button" data-act="answer-list-append" disabled>Add to list</button><button id="answerListReplace" type="button" class="button primary" data-act="answer-list-replace" disabled>Replace list</button></div>
</dialog>`;

export const ANSWER_LIST_CLIENT = parseAnswerCsv.toString() + String.raw`
let answerListDraft=null;
function openAnswerList(importFile=false){
  flushForms();
  const p=pipeline(),s=selectedStage(),entry=s&&setupQuestion(s),q=entry?.[1];
  if(!q||!['choice','score'].includes(q.type))return;
  answerListDraft={projectId:S.projectId,pipelineId:p.id,stageId:s.id,questionId:entry[0],type:q.type,criteria:JSON.stringify(q.criteria),page:0,file:false,column:-1,header:false,readVersion:0};
  document.getElementById('answerListTitle').textContent=q.type==='score'?'Populate ordered levels':'Populate options';
  document.getElementById('answerListHint').textContent=q.type==='score'?'Keep levels in order, from lowest to highest. 2–10 levels.':'Paste a list or choose a CSV, then replace or add to your options. 2–255 options.';
  document.getElementById('answerListText').value='';document.getElementById('answerListFilename').textContent='';document.getElementById('answerListFile').value='';
  document.getElementById('answerListHeader').checked=false;
  document.getElementById('answerListDialog').showModal();updateAnswerList();
  if(importFile)document.getElementById('answerListFile').click();else document.getElementById('answerListText').focus();
}
function closeAnswerList(){document.getElementById('answerListDialog').close();answerListDraft=null}
function answerListTarget(){
  const d=answerListDraft,p=S.doc.pipelines.find(p=>p.id===d?.pipelineId),s=p?.stages.find(s=>s.id===d?.stageId),q=s?.questions?.[d?.questionId];
  if(!d||S.projectId!==d.projectId||S.pipelineId!==d.pipelineId||S.stageId!==d.stageId||!q||q.type!==d.type||JSON.stringify(q.criteria)!==d.criteria)throw Error('This question changed. Close this list and open it again.');
  return q;
}
function answerListValues(){
  const rows=parseAnswerCsv(document.getElementById('answerListText').value),d=answerListDraft;
  const selected=d.header?rows.slice(1):rows;
  return (d.column<0?selected.flat():selected.map(row=>row[d.column]||'')).filter(value=>value.length>0).map(value=>value.replace(/\r?\n/g,' '));
}
function answerListResult(q,values,append){
  if(!values.length)throw Error('Enter at least one option or ordered level.');
  const old=q.type==='choice'?Object.entries(q.criteria).map(([key,value])=>optionName(key,value)):q.criteria;
  const result=append?[...old.filter(value=>value.trim()),...values]:values;
  const max=q.type==='score'?10:255;
  if(result.length<2||result.length>max)throw Error('Use 2–'+max+' '+(q.type==='score'?'ordered levels':'options')+'. This list would have '+result.length+'.');
  if(new Set(result.map(value=>value.trim())).size!==result.length)throw Error('Each option or ordered level needs different text. Remove duplicates.');
  return result;
}
function updateAnswerList(){
  const d=answerListDraft;if(!d)return;
  const error=document.getElementById('answerListError'),preview=document.getElementById('answerListPreview'),replace=document.getElementById('answerListReplace'),append=document.getElementById('answerListAppend');
  replace.disabled=true;append.disabled=true;replace.title='';append.title='';error.hidden=true;error.textContent='';
  try{
    const q=answerListTarget(),rows=parseAnswerCsv(document.getElementById('answerListText').value),width=rows.reduce((max,row)=>Math.max(max,row.length),0);
    if(width>255)throw Error('CSV has too many columns. Use up to 255 columns.');
    const mapping=document.getElementById('answerListMapping');mapping.hidden=!d.file;
    document.getElementById('answerListColumn').innerHTML='<option value="-1" '+(d.column<0?'selected':'')+'>All values, row by row</option>'+Array.from({length:width},(_,i)=>'<option value="'+i+'" '+(d.column===i?'selected':'')+'>Column '+(i+1)+(rows[0]?.[i]?' · '+esc(rows[0][i].slice(0,60)):'')+'</option>').join('');
    const values=answerListValues(),pages=Math.max(1,Math.ceil(values.length/4));d.page=Math.max(0,Math.min(d.page,pages-1));
    const start=d.page*4;
    preview.innerHTML=values.length?'<strong>'+values.length+' '+(q.type==='score'?'levels':'options')+' in this list</strong><ol start="'+(start+1)+'">'+values.slice(start,start+4).map(value=>'<li>'+esc(value)+'</li>').join('')+'</ol>'+(pages>1?'<div class="row"><button type="button" class="button small" data-act="answer-list-prev" '+(!d.page?'disabled':'')+'>Previous</button><span>'+(start+1)+'–'+Math.min(start+4,values.length)+' of '+values.length+'</span><button type="button" class="button small" data-act="answer-list-next" '+(d.page===pages-1?'disabled':'')+'>Next</button></div>':''):'<p class="subtle">Your list will appear here.</p>';
    if(!values.length)return;
    let replaceError;try{answerListResult(q,values,false);replace.disabled=false}catch(e){replaceError=e.message;replace.title=e.message}
    try{answerListResult(q,values,true);append.disabled=false}catch(e){append.title=e.message}
    if(replace.disabled&&append.disabled)throw Error(replaceError);
  }catch(e){error.textContent=e.message;error.hidden=false;preview.innerHTML=''}
}
async function readAnswerListFile(file){
  const draft=answerListDraft;if(!draft||!file)return;const readVersion=++draft.readVersion;
  const field=document.getElementById('answerListFile');field.value='';
  try{
    if(file.size>256*1024)throw Error('CSV is too large. The maximum size is 256 KiB.');
    const text=await file.text();
    if(answerListDraft!==draft||draft.readVersion!==readVersion||!document.getElementById('answerListDialog').open)return;
    const rows=parseAnswerCsv(text);draft.file=true;draft.header=false;draft.column=rows.length>1&&rows.some(row=>row.length>1)?0:-1;draft.page=0;
    document.getElementById('answerListText').value=text;document.getElementById('answerListFilename').textContent=file.name;
    document.getElementById('answerListHeader').checked=false;updateAnswerList();
  }catch(e){if(answerListDraft===draft&&draft.readVersion===readVersion&&document.getElementById('answerListDialog').open){const error=document.getElementById('answerListError');error.textContent=e.message;error.hidden=false}}
}
function applyAnswerList(append){
  const d=answerListDraft,q=answerListTarget(),values=answerListResult(q,answerListValues(),append);
  if(q.type==='score')q.criteria=values;
  else {
    const old=Object.entries(q.criteria),used=new Set(),criteria={};
    for(const label of values){let key=old.find(([key,value])=>!used.has(key)&&optionName(key,value)===label)?.[0];if(!key){do{key='option_'+id()}while(Object.hasOwn(q.criteria,key)||used.has(key))}used.add(key);criteria[key]=Object.hasOwn(q.criteria,key)?q.criteria[key]:label}
    q.criteria=criteria;
  }
  S.listPages[S.projectId+':setup-options-'+d.stageId+'-'+d.questionId]=0;S.dirty=true;S.plan=null;
  closeAnswerList();render();say(values.length+' '+(q.type==='score'?'ordered levels':'options')+' ready to edit.');
}
function answerListAction(a){
  if(!a.startsWith('answer-list-'))return false;
  try{
    if(a==='answer-list-open'||a==='answer-list-import')openAnswerList(a==='answer-list-import');
    else if(a==='answer-list-close')closeAnswerList();
    else if(a==='answer-list-file')document.getElementById('answerListFile').click();
    else if(a==='answer-list-replace'||a==='answer-list-append')applyAnswerList(a==='answer-list-append');
    else if(answerListDraft&&(a==='answer-list-prev'||a==='answer-list-next')){answerListDraft.page+=a==='answer-list-next'?1:-1;updateAnswerList()}
  }catch(e){if(document.getElementById('answerListDialog').open){const error=document.getElementById('answerListError');error.textContent=e.message;error.hidden=false}else fail(e)}
  return true;
}
`;

export const ANSWER_LIST_CSS = `
.answer-list-dialog{width:min(580px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}.answer-list-dialog textarea{min-height:80px;max-height:180px}.answer-list-dialog small,.answer-list-dialog .subtle{overflow-wrap:anywhere}.answer-list-mapping{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;margin-top:14px}.answer-list-mapping .field{margin:0}.answer-list-preview{border-top:1px solid var(--line);margin-top:16px;padding-top:12px;font-size:12px}.answer-list-preview ol{padding-left:22px}.answer-list-preview li{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}.answer-list-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:18px}.answer-list-error{color:var(--red);margin-top:12px!important}.answer-list-dialog #answerListFilename{overflow-wrap:anywhere;min-width:0;flex:1}
@media(max-width:600px){.answer-list-dialog{padding:16px}.answer-list-mapping{grid-template-columns:minmax(0,1fr);gap:8px}}
`;
