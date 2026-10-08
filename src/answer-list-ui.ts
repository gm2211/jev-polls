import { parseAnswerCsv } from './answer-csv.js';

/** Local-only bulk editing; the existing criteria contracts remain unchanged. */
export const ANSWER_LIST_DIALOG = `
<dialog id="answerListDialog" class="auth-dialog answer-list-dialog" aria-labelledby="answerListTitle">
<button type="button" class="close-dialog" data-act="answer-list-close" aria-label="Close answer list">×</button>
<h2 id="answerListTitle">Populate answers</h2><p id="answerListHint" class="subtle"></p>
<button id="answerListDrop" type="button" class="answer-list-drop" data-act="answer-list-file"><strong>Drop a CSV or JSON file here</strong><span>or choose a file · names and optional descriptions</span></button><span id="answerListFilename" class="subtle"></span><input id="answerListFile" type="file" accept=".csv,.json,text/csv,application/json" hidden>
<nav class="answer-list-views" aria-label="Import sections"><button id="answerListPreviewTab" type="button" class="button small" data-act="answer-list-preview">Preview</button><button id="answerListColumnsTab" type="button" class="button small" data-act="answer-list-columns" hidden>Columns</button><button id="answerListPasteTab" type="button" class="button small" data-act="answer-list-paste">Paste list</button></nav>
<div id="answerListPaste" class="field"><label for="answerListText">Comma-separated or one per line</label><textarea id="answerListText" rows="3" maxlength="262144" placeholder='Low, Medium, High' aria-describedby="answerListFormat"></textarea><small id="answerListFormat">Put quotes around labels containing commas: "Fast, reliable", Affordable</small></div>
<div id="answerListMapping" class="answer-list-mapping" hidden><div class="field"><label for="answerListColumn">Option names</label><select id="answerListColumn"></select></div><div id="answerListDescriptionMapping" class="field"><label for="answerListDescription">Descriptions (optional)</label><select id="answerListDescription"></select></div><label class="checkrow"><input id="answerListHeader" type="checkbox">First row is a header</label></div>
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
  answerListDraft={projectId:S.projectId,pipelineId:p.id,stageId:s.id,questionId:entry[0],type:q.type,criteria:JSON.stringify(q.criteria),page:0,file:false,column:-1,descriptionColumn:-1,header:false,readVersion:0,view:importFile?'preview':'paste',source:importFile?'file':'paste',pasteText:'',fileText:'',jsonRecords:null};
  document.getElementById('answerListTitle').textContent=q.type==='score'?'Populate ordered levels':'Populate options';
  document.getElementById('answerListHint').textContent=q.type==='score'?'Keep levels in order, from lowest to highest. 2–10 levels.':'CSV: name and description columns. JSON: names, [name, description] pairs, or objects. 2–255 options.';
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
function answerListRecords(){
  const d=answerListDraft;if(d.source==='file'&&d.jsonRecords)return d.type==='score'?d.jsonRecords.map(({label})=>({label})):d.jsonRecords;
  const rows=parseAnswerCsv(document.getElementById('answerListText').value),paste=d.source==='paste';
  const selected=d.header&&!paste?rows.slice(1):rows;
  const normalize=value=>value.replace(/\r?\n/g,' ');
  if(d.column<0||paste)return selected.flat().filter(value=>value.length>0).map(value=>({label:normalize(value)}));
  if(selected.some(row=>!row[d.column]?.length))throw Error('Every CSV row needs a name in the selected column.');
  return selected.map(row=>({label:normalize(row[d.column]),...(d.type==='choice'&&d.descriptionColumn>=0?{description:row[d.descriptionColumn]||''}:{})}));
}
function answerListValues(){return answerListRecords().map(record=>record.label)}
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
  document.getElementById('answerListPaste').hidden=d.view!=='paste';
  document.getElementById('answerListMapping').hidden=d.view!=='columns'||!d.file||!!d.jsonRecords;
  document.getElementById('answerListColumnsTab').hidden=!d.file||!!d.jsonRecords;
  for(const [id,view] of [['answerListPreviewTab','preview'],['answerListColumnsTab','columns'],['answerListPasteTab','paste']])document.getElementById(id).setAttribute?.('aria-pressed',String(d.view===view));
  preview.hidden=d.view==='columns';
  try{
    const q=answerListTarget(),rows=d.jsonRecords&&d.source==='file'?[]:parseAnswerCsv(document.getElementById('answerListText').value),width=rows.reduce((max,row)=>Math.max(max,row.length),0);
    if(width>255)throw Error('CSV has too many columns. Use up to 255 columns.');
    document.getElementById('answerListColumn').innerHTML='<option value="-1" '+(d.column<0?'selected':'')+'>All values, row by row</option>'+Array.from({length:width},(_,i)=>'<option value="'+i+'" '+(d.column===i?'selected':'')+'>Column '+(i+1)+(rows[0]?.[i]?' · '+esc(rows[0][i].slice(0,60)):'')+'</option>').join('');
    document.getElementById('answerListDescriptionMapping').hidden=q.type!=='choice'||d.column<0;
    document.getElementById('answerListDescription').innerHTML='<option value="-1" '+(d.descriptionColumn<0?'selected':'')+'>Keep existing descriptions</option>'+Array.from({length:width},(_,i)=>'<option value="'+i+'" '+(d.descriptionColumn===i?'selected':'')+'>Column '+(i+1)+(rows[0]?.[i]?' · '+esc(rows[0][i].slice(0,60)):'')+'</option>').join('');
    const records=answerListRecords(),values=records.map(record=>record.label),pages=Math.max(1,Math.ceil(values.length/4));d.page=Math.max(0,Math.min(d.page,pages-1));
    const start=d.page*4;
    preview.innerHTML=values.length?'<strong>'+values.length+' '+(q.type==='score'?'levels':'options')+' in this list</strong><ol start="'+(start+1)+'">'+records.slice(start,start+4).map(record=>'<li><strong>'+esc(record.label)+'</strong>'+(record.description?'<span class="answer-list-description">'+esc(record.description)+'</span>':'')+'</li>').join('')+'</ol>'+(pages>1?'<div class="row"><button type="button" class="button small" data-act="answer-list-prev" '+(!d.page?'disabled':'')+'>Previous</button><span>'+(start+1)+'–'+Math.min(start+4,values.length)+' of '+values.length+'</span><button type="button" class="button small" data-act="answer-list-next" '+(d.page===pages-1?'disabled':'')+'>Next</button></div>':''):'<p class="subtle">Your list will appear here.</p>';
    if(!values.length)return;
    let replaceError;try{answerListResult(q,values,false);replace.disabled=false}catch(e){replaceError=e.message;replace.title=e.message}
    try{answerListResult(q,values,true);append.disabled=false}catch(e){append.title=e.message}
    if(replace.disabled&&append.disabled)throw Error(replaceError);
  }catch(e){error.textContent=e.message;error.hidden=false;preview.innerHTML=''}
}
function parseAnswerJson(text){
  if(new TextEncoder().encode(text).length>256*1024)throw Error('File is too large. The maximum size is 256 KiB.');
  let values;try{values=JSON.parse(text.charCodeAt(0)===0xfeff?text.slice(1):text)}catch{throw Error('JSON is invalid. Use an array of names, [name, description] pairs, or objects.');}
  if(!Array.isArray(values)||values.length>255)throw Error('JSON must be an array with up to 255 options.');
  return values.map((value,index)=>{
    let label,description;
    if(typeof value==='string')label=value;
    else if(Array.isArray(value)&&value.length===2){[label,description]=value}
    else if(value&&typeof value==='object'&&!Array.isArray(value)){label=value.name??value.label;description=value.description}
    if(typeof label!=='string'||!label.trim()||(description!==undefined&&typeof description!=='string'))throw Error('JSON option '+(index+1)+' needs a name and optional text description.');
    return {label:label.trim().replace(/\r?\n/g,' '),...(description!==undefined?{description}:{})};
  });
}
function answerListView(view){
  const d=answerListDraft;if(!d||!['preview','columns','paste'].includes(view)||view==='columns'&&(!d.file||d.jsonRecords))return;
  const field=document.getElementById('answerListText');
  if(d.source==='paste')d.pasteText=field.value;else if(d.file)d.fileText=field.value;
  if(view==='paste')d.source='paste';else if(view==='columns'||view==='preview'&&d.file)d.source='file';
  d.view=view;field.value=d.source==='paste'?d.pasteText:d.fileText;d.page=0;updateAnswerList();
  if(view==='paste')field.focus();
}
async function readAnswerListFile(file){
  const draft=answerListDraft;if(!draft||!file)return;const readVersion=++draft.readVersion;
  const field=document.getElementById('answerListFile');field.value='';
  try{
    if(file.size>256*1024)throw Error('CSV is too large. The maximum size is 256 KiB.');
    const text=await file.text();
    if(answerListDraft!==draft||draft.readVersion!==readVersion||!document.getElementById('answerListDialog').open)return;
    const isJson=/\.json$/i.test(file.name)||text.replace(/^\uFEFF/,'').trimStart().startsWith('['),records=isJson?parseAnswerJson(text):null,rows=isJson?[]:parseAnswerCsv(text),headers=(rows[0]||[]).map(value=>value.trim().toLowerCase()),nameColumn=headers.findIndex(value=>['name','option','title','label'].includes(value));
    if(draft.source==='paste')draft.pasteText=document.getElementById('answerListText').value;
    draft.file=true;draft.jsonRecords=records;draft.fileText=text;draft.view='preview';draft.source='file';draft.header=rows.length>1&&nameColumn>=0;draft.column=draft.header?nameColumn:rows.length>1&&rows.some(row=>row.length>1)?0:-1;draft.descriptionColumn=draft.header&&draft.type==='choice'?headers.indexOf('description'):-1;draft.page=0;
    document.getElementById('answerListText').value=text;document.getElementById('answerListFilename').textContent=file.name;
    document.getElementById('answerListHeader').checked=draft.header;updateAnswerList();
  }catch(e){if(answerListDraft===draft&&draft.readVersion===readVersion&&document.getElementById('answerListDialog').open){const error=document.getElementById('answerListError');error.textContent=e.message;error.hidden=false}}
}
function applyAnswerList(append){
  const d=answerListDraft,q=answerListTarget(),records=answerListRecords(),values=answerListResult(q,records.map(record=>record.label),append);
  if(q.type==='score')q.criteria=values;
  else {
    const old=Object.entries(q.criteria),used=new Set(),criteria={},descriptions=new Map(records.filter(record=>Object.hasOwn(record,'description')).map(record=>[record.label,record.description]));
    for(const label of values){let key=old.find(([key,value])=>!used.has(key)&&optionName(key,value)===label)?.[0];if(!key){do{key='option_'+id()}while(Object.hasOwn(q.criteria,key)||used.has(key))}used.add(key);const existing=Object.hasOwn(q.criteria,key)?q.criteria[key]:label;criteria[key]=descriptions.has(label)?{...(existing&&typeof existing==='object'?existing:{}),label,description:descriptions.get(label)}:existing}
    q.criteria=criteria;
  }
  S.sections['setup-wizard-'+d.pipelineId+'-'+d.stageId+'-'+d.questionId]='options';S.sections['setup-input-'+d.pipelineId+'-'+d.stageId+'-'+d.questionId]='manual';S.listPages[S.projectId+':setup-options-'+d.stageId+'-'+d.questionId]=0;S.dirty=true;S.plan=null;
  closeAnswerList();render();say(values.length+' '+(q.type==='score'?'ordered levels':'options')+' ready to edit.');
}
function answerListAction(a){
  if(!a.startsWith('answer-list-'))return false;
  try{
    if(a==='answer-list-open'||a==='answer-list-import')openAnswerList(a==='answer-list-import');
    else if(a==='answer-list-close')closeAnswerList();
    else if(a==='answer-list-file')document.getElementById('answerListFile').click();
    else if(['answer-list-preview','answer-list-columns','answer-list-paste'].includes(a))answerListView(a.slice(12));
    else if(a==='answer-list-replace'||a==='answer-list-append')applyAnswerList(a==='answer-list-append');
    else if(answerListDraft&&(a==='answer-list-prev'||a==='answer-list-next')){answerListDraft.page+=a==='answer-list-next'?1:-1;updateAnswerList()}
  }catch(e){if(document.getElementById('answerListDialog').open){const error=document.getElementById('answerListError');error.textContent=e.message;error.hidden=false}else fail(e)}
  return true;
}
const answerListDrop=document.getElementById('answerListDrop');
answerListDrop?.addEventListener?.('dragenter',event=>{event.preventDefault();answerListDrop.classList.add('dragging')});
answerListDrop?.addEventListener?.('dragover',event=>{event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy'});
answerListDrop?.addEventListener?.('dragleave',()=>answerListDrop.classList.remove('dragging'));
answerListDrop?.addEventListener?.('drop',event=>{
  event.preventDefault();answerListDrop.classList.remove('dragging');
  const files=event.dataTransfer?.files;if(!files?.length)return;
  if(files.length!==1){const error=document.getElementById('answerListError');error.textContent='Choose one file at a time.';error.hidden=false;return}
  void readAnswerListFile(files[0]);
});
document.addEventListener('dragover',event=>{const target=event.target.closest?.('[data-answer-drop]');if(!target)return;event.preventDefault();if(event.dataTransfer)event.dataTransfer.dropEffect='copy'});
document.addEventListener('drop',event=>{
  const target=event.target.closest?.('[data-answer-drop]');if(!target)return;event.preventDefault();
  const files=event.dataTransfer?.files;if(!files?.length)return;
  try{openAnswerList(false);if(files.length!==1)throw Error('Choose one file at a time.');void readAnswerListFile(files[0])}catch(error){const box=document.getElementById('answerListError');box.textContent=error.message;box.hidden=false}
});
`;

export const ANSWER_LIST_CSS = `
.answer-list-dialog{width:min(580px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}.answer-list-dialog textarea{min-height:80px;max-height:180px}.answer-list-dialog small,.answer-list-dialog .subtle{overflow-wrap:anywhere}.answer-list-drop{display:grid;gap:4px;width:100%;padding:16px;border:1px dashed var(--control-line);border-radius:var(--radius-control);background:var(--raised);color:var(--ink);font:inherit;text-align:center;cursor:pointer}.answer-list-drop span{font-size:12px;color:var(--muted)}.answer-list-drop:hover,.answer-list-drop.dragging{background:var(--selection);border-color:var(--blue)}.answer-list-views{display:flex;gap:6px;margin:14px 0}.answer-list-views [aria-pressed=true]{background:var(--selection);border-color:var(--blue)}.answer-list-mapping{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:center;margin-top:14px}.answer-list-mapping .field{margin:0}.answer-list-mapping>.checkrow{grid-column:1/-1}.answer-list-description{display:block;color:var(--muted);font-weight:400;font-size:11px;margin-top:2px}.answer-list-preview{border-top:1px solid var(--line);margin-top:16px;padding-top:12px;font-size:12px}.answer-list-preview ol{padding-left:22px}.answer-list-preview li{white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0}.answer-list-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:18px}.answer-list-error{color:var(--red);margin-top:12px!important}.answer-list-dialog #answerListFilename{display:block;overflow-wrap:anywhere;min-width:0;margin-top:8px}
@media(max-width:600px){.answer-list-dialog{padding:16px}.answer-list-mapping{grid-template-columns:minmax(0,1fr);gap:8px}}
`;
