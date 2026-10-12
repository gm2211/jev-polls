/** The Options stop's one list: a light row per option (name, optional description, remove) and an add row at the bottom. Pasting several lines or dropping a CSV/JSON file adds or replaces rows; importing or drafting with AI is a secondary link. Nothing here calls a model. */
export const OPTIONS_BOX_CLIENT = String.raw`
const optionsBoxErrors={},optionsBoxDrafts={};
const optionsBoxFlat=value=>String(value??'').replace(/\s+/g,' ').trim();
function optionsBoxKey(p,s,qid){return [S.projectId,p.id,s.id,qid].join(':')}
/** The choice question the step panel shows now, or null. */
function optionsBoxCurrent(){
  const p=pipeline(),s=selectedStage(),entry=s?.kind==='poll'||s?.kind==='choose'?setupQuestion(s):null,q=entry?.[1];
  return p&&q&&q.type==='choice'?{p,s,qid:entry[0],q,key:optionsBoxKey(p,s,entry[0])}:null;
}
/** A pasted or typed line is a name, optionally followed by a description after a tab or a colon and a space: "Orbital Empire: an empire, but in orbit". A tab wins, so names that contain a colon stay whole. */
function optionsBoxRecords(text){
  return String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const tab=line.indexOf('\t'),colon=/:(\s|$)/.exec(line),at=tab>=0?tab:colon?colon.index:-1;
    return {label:optionsBoxFlat(at<0?line:line.slice(0,at)),description:at<0?'':line.slice(at+1).trim()};
  }).filter(record=>record.label);
}
function optionsBoxNamed(q){return Object.entries(q.criteria).filter(([key,value])=>optionsBoxFlat(optionName(key,value)))}
function optionsBoxCount(count){return count===0?'No options yet':count===1?'1 option · add at least one more':count+' options'}
function optionsBoxProblem(q,key){
  if(optionsBoxErrors[key])return optionsBoxErrors[key];
  const labels=optionsBoxNamed(q).map(([k,v])=>optionsBoxFlat(optionName(k,v))),repeated=labels.find((label,i)=>labels.indexOf(label)!==i);
  return repeated?'“'+repeated+'” appears more than once. Give each option different text.':'';
}
/** One row per option, edited in place, then an add row. The count and any problem sit on one line underneath. What the step returns is shown with its output, not here. */
function optionsBoxField(p,s,qid,q,action=''){
  // Blank placeholder rows stay out of sight: an empty list is just the add row, matching "No options yet".
  const key=optionsBoxKey(p,s,qid),rows=Object.entries(q.criteria).filter(([k,value])=>optionsBoxFlat(optionName(k,value))||optionsBoxFlat(optionDescription(value))),error=optionsBoxProblem(q,key),count=optionsBoxNamed(q).length;
  const row=([k,value],i)=>{const name=optionName(k,value);return '<li class="options-row" data-option-key="'+attr(k)+'"><input data-option-field="label" value="'+attr(name)+'" placeholder="Option '+(i+1)+'" aria-label="Option '+(i+1)+' name" autocomplete="off" spellcheck="false"><input data-option-field="description" value="'+attr(optionsBoxFlat(optionDescription(value)))+'" title="'+attr(optionsBoxFlat(optionDescription(value)))+'" placeholder="Description (optional)" aria-label="Option '+(i+1)+' description" autocomplete="off"><button type="button" class="button small icon-button" data-act="setup-remove-option" data-key="'+attr(k)+'" aria-label="Remove '+attr(optionsBoxFlat(name)||'option '+(i+1))+'" title="Remove option" '+(rows.length<=2?'disabled':'')+'>'+icon('trash')+'</button></li>'};
  return '<div class="options-box" data-options-box><div class="options-box-head"><span id="optionsBoxLabel">Your options</span>'+action+'</div>'+
    '<ol class="options-list" aria-labelledby="optionsBoxLabel">'+rows.map(row).join('')+
    '<li class="options-row options-add"><input data-option-add value="'+attr(optionsBoxDrafts[key]||'')+'" placeholder="Add an option, or paste a list" aria-label="Add an option" aria-describedby="optionsBoxHint" autocomplete="off" spellcheck="false"><button type="button" class="button small icon-button" data-options-add aria-label="Add option" title="Add option">'+icon('plus')+'</button></li></ol>'+
    '<p class="options-box-meta"><strong id="optionsBoxStatus" role="status" aria-live="polite">'+esc(optionsBoxCount(count))+'</strong><span id="optionsBoxError" class="options-box-error" role="alert" '+(error?'':'hidden')+'>'+esc(error)+'</span><span id="optionsBoxHint">Paste several lines or drop a CSV or JSON file to add many.</span></p></div>';
}
/** Keeps the count, the problem line and the Options tab in step without redrawing, so typing is never interrupted. */
function optionsBoxRefresh(cur){
  const status=document.getElementById('optionsBoxStatus'),error=document.getElementById('optionsBoxError'),tab=root.querySelector('.round-tab[data-section=answers]'),problem=optionsBoxProblem(cur.q,cur.key);
  if(status)status.textContent=optionsBoxCount(optionsBoxNamed(cur.q).length);
  if(error){error.textContent=problem;error.hidden=!problem}
  if(tab&&typeof flowStopDone==='function'){const done=flowStopDone(cur.p,cur.s,'answers');tab.toggleAttribute?.('data-done',done);tab.toggleAttribute?.('data-todo',!done);tab.innerHTML=flowTabContent('Options',!done,done)}
}
function optionsBoxChanged(cur){S.dirty=true;S.plan=null;if(typeof updateSaveState==='function')updateSaveState();optionsBoxRefresh(cur)}
/** Typing in a row edits that option at once. Its ID and custom fields stay; a plain name stays a plain string until it gets a description. */
function optionsBoxEdit(el){
  const cur=optionsBoxCurrent(),k=el.closest?.('[data-option-key]')?.dataset.optionKey;if(!cur||!k||!Object.hasOwn(cur.q.criteria,k))return;
  const old=cur.q.criteria[k],label=el.dataset.optionField==='label'?el.value:optionName(k,old),description=el.dataset.optionField==='description'?el.value:optionsBoxFlat(optionDescription(old));
  cur.q.criteria[k]=old&&typeof old==='object'?{...old,label,description}:description?{label,description}:label;
  delete optionsBoxErrors[cur.key];optionsBoxChanged(cur);
}
function optionsBoxFresh(q,used){let key;do{key='option_'+id()}while(Object.hasOwn(q.criteria,key)||used.has(key));used.add(key);return key}
/** Adds the lines in text as new options, after the row with key "after" or at the end. Blank placeholder rows give way to them. Returns what was added. */
function optionsBoxAdd(text,after,redraw=true){
  const cur=optionsBoxCurrent();if(!cur)return null;
  const records=optionsBoxRecords(text);if(!records.length)return {records,error:''};
  const kept=Object.entries(cur.q.criteria).filter(([k,v])=>optionsBoxFlat(optionName(k,v))||k===after),total=kept.length+records.length;
  if(total>255){optionsBoxErrors[cur.key]='Use up to 255 options. This list would have '+total+'.';optionsBoxRefresh(cur);return {records,error:optionsBoxErrors[cur.key]}}
  const used=new Set(),added=records.map(record=>[optionsBoxFresh(cur.q,used),record.description?{label:record.label,description:record.description}:record.label]);
  const at=after?kept.findIndex(([k])=>k===after)+1:kept.length,next=[...kept.slice(0,at),...added,...kept.slice(at)];
  while(next.length<2)next.push([optionsBoxFresh(cur.q,used),'']);
  cur.q.criteria=Object.fromEntries(next);delete optionsBoxErrors[cur.key];delete optionsBoxDrafts[cur.key];
  S.dirty=true;S.plan=null;
  if(redraw){render();root.querySelector('[data-option-add]')?.focus()}else optionsBoxRefresh(cur);
  return {records,error:''};
}
/** Replaces the whole list with the lines in text: names that already exist keep their IDs, descriptions and custom fields; everything else gets a new ID. Fewer than two leave blank rows. */
function optionsBoxCommit(text){
  const cur=optionsBoxCurrent();if(!cur)return null;
  const records=optionsBoxRecords(text),labels=records.map(record=>record.label),repeated=labels.find((label,i)=>labels.indexOf(label)!==i);
  const error=labels.length>255?'Use up to 255 options. This list has '+labels.length+'.':repeated?'“'+repeated+'” appears more than once. Give each option different text.':'';
  if(error){optionsBoxErrors[cur.key]=error;optionsBoxRefresh(cur);return {records,error}}
  delete optionsBoxErrors[cur.key];
  const next=mergeOptionCriteria(cur.q,labels,new Map(records.map(record=>[record.label,record.description])),true);
  if(JSON.stringify(next)!==JSON.stringify(cur.q.criteria)){cur.q.criteria=next;S.dirty=true;S.plan=null}
  render();
  return {records,error:''};
}
/** Text left in the add row when the step is left or saved still becomes options. */
function optionsBoxFlush(){const cur=optionsBoxCurrent(),el=root.querySelector?.('[data-option-add]'),text=el?.value??(cur&&optionsBoxDrafts[cur.key]);if(cur&&String(text||'').trim())optionsBoxAdd(text,undefined,false)}
function optionsBoxMessage(message){const error=document.getElementById('optionsBoxError');if(error){error.textContent=message;error.hidden=!message}}
/** A dropped CSV or JSON file replaces the list with its names and descriptions, read by the same parsers as the import dialog. */
async function optionsBoxFile(file){
  const cur=optionsBoxCurrent();if(!file||!cur)return;
  try{
    if(file.size>256*1024)throw Error('File is too large. The maximum size is 256 KiB.');
    const text=await file.text(),records=answerFileRecords(answerFileLayout(file.name,text,'choice'),'choice');
    if(!records.length)throw Error('That file has no options in it.');
    const result=optionsBoxCommit(records.map(record=>{const name=optionsBoxFlat(record.label),description=optionsBoxFlat(record.description||'');return description?name+'\t'+description:name}).join('\n'));
    if(result&&!result.error&&typeof say==='function')say(result.records.length+' options read from '+file.name+'.');
  }catch(error){optionsBoxMessage(error.message)}
}
function optionsBoxInput(el){
  if(el.matches?.('[data-option-add]')){const cur=optionsBoxCurrent();if(cur)optionsBoxDrafts[cur.key]=el.value;return true}
  if(el.matches?.('[data-option-field]')){optionsBoxEdit(el);return true}
  return false;
}
/** Enter in the add row adds it; Enter in a row goes to the add row instead of submitting the form. */
function optionsBoxKeydown(event){
  const el=event.target;if(event.key!=='Enter'||event.isComposing||!el?.matches?.('[data-option-add],[data-option-field]'))return;
  event.preventDefault();
  if(el.matches('[data-option-add]'))optionsBoxAdd(el.value);else root.querySelector('[data-option-add]')?.focus();
}
/** Pasting several lines into the add row or a row name adds one option per line; a single line pastes normally. */
function optionsBoxPaste(event){
  const el=event.target,text=event.clipboardData?.getData?.('text')||'';
  if(!el?.matches?.('[data-option-add],[data-option-field=label]')||!/\r?\n/.test(text.trim()))return;
  event.preventDefault();
  try{optionsBoxAdd(text,el.matches('[data-option-add]')?undefined:el.closest('[data-option-key]')?.dataset.optionKey)}catch(error){fail(error)}
}
root.addEventListener('keydown',optionsBoxKeydown);
root.addEventListener('paste',optionsBoxPaste);
root.addEventListener('click',event=>{if(!event.target.closest?.('[data-options-add]'))return;event.preventDefault();try{optionsBoxAdd(root.querySelector('[data-option-add]')?.value||'')}catch(error){fail(error)}});
function optionsBoxDragTarget(event){return event.target.closest?.('[data-options-box]')}
document.addEventListener('dragover',event=>{const box=optionsBoxDragTarget(event);if(!box||![...(event.dataTransfer?.types||[])].includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';box.classList.add('dragging')});
document.addEventListener('dragleave',event=>optionsBoxDragTarget(event)?.classList.remove('dragging'));
document.addEventListener('drop',event=>{
  const box=optionsBoxDragTarget(event);if(!box)return;box.classList.remove('dragging');
  const files=event.dataTransfer?.files;if(!files?.length)return;event.preventDefault();
  if(files.length!==1){optionsBoxMessage('Choose one file at a time.');return}
  void optionsBoxFile(files[0]);
});
`;

export const OPTIONS_BOX_CSS = String.raw`
.options-box{display:grid;gap:4px;border-radius:6px}
.options-box.dragging{outline:2px dashed var(--blue);outline-offset:4px;background:var(--selection)}
.options-box-head{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;font-size:var(--text-sm);font-weight:600}
.options-box-actions{display:flex;gap:6px;flex-wrap:wrap}
.options-list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.options-row{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr) 28px;align-items:center;gap:0 6px;border-bottom:1px solid var(--line);padding:0}
.options-row input{width:100%;min-width:0;min-height:28px;height:28px;margin:0;padding:3px 6px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--ink);font:inherit;font-size:var(--text-sm);box-shadow:none}
.options-row input:hover{border-color:var(--line)}
.options-row input:focus{border-color:var(--blue);background:var(--surface);outline:none}
.options-row [data-option-field=label]{font-weight:600}
.options-row [data-option-field=description]{color:var(--muted)}
.options-row .button.icon-button{width:28px;height:28px;min-height:28px;min-width:28px;padding:0;border-color:transparent;background:transparent;color:var(--muted)}
.options-row .button.icon-button:hover:not(:disabled){color:var(--red);border-color:var(--line)}
.options-row .button.icon-button:disabled{opacity:.35}
.options-add{grid-template-columns:minmax(0,1fr) 28px}
.options-add .button.icon-button{color:var(--blue)}
.options-box-meta{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 8px;margin:2px 0 0;font-size:var(--text-xs);color:var(--muted)}
.options-box-meta strong{font-weight:600;color:var(--ink)}
.options-box-error{color:var(--red)}
`;
