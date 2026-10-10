/** The Options stop's one-step entry: a box where one option per line is read live into the option list. Import, the paste dialog and the drafting AI stay as secondary actions. Nothing here calls a model. */
export const OPTIONS_BOX_CLIENT = String.raw`
const optionsBoxState={};
let optionsBoxTimer=0;
const optionsBoxFlat=value=>String(value??'').replace(/\s+/g,' ').trim();
function optionsBoxKey(p,s,qid){return [S.projectId,p.id,s.id,qid].join(':')}
/** A line is a name, optionally followed by a description after a tab or a colon and a space: "Orbital Empire: an empire, but in orbit". A tab wins, so names that contain a colon stay whole. */
function optionsBoxRecords(text){
  return String(text).split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const tab=line.indexOf('\t'),colon=/:(\s|$)/.exec(line),at=tab>=0?tab:colon?colon.index:-1;
    return {label:optionsBoxFlat(at<0?line:line.slice(0,at)),description:at<0?'':line.slice(at+1).trim()};
  }).filter(record=>record.label);
}
function optionsBoxLine(name,description){
  const text=optionsBoxFlat(description);
  return text?name+(name.includes(':')?'\t':': ')+text:name.includes(':')?name+'\t':name;
}
function optionsBoxText(q){
  return Object.entries(q.criteria).map(([key,value])=>[optionsBoxFlat(optionName(key,value)),optionDescription(value)]).filter(([name])=>name).map(([name,description])=>optionsBoxLine(name,description)).join('\n');
}
function optionsBoxMatches(text,q){
  const records=optionsBoxRecords(text),named=Object.entries(q.criteria).filter(([key,value])=>optionsBoxFlat(optionName(key,value)));
  return records.length===named.length&&records.every((record,i)=>record.label===optionsBoxFlat(optionName(...named[i]))&&optionsBoxFlat(record.description)===optionsBoxFlat(optionDescription(named[i][1])));
}
/** The text shown in the box. What was typed stays while it is unread or invalid; otherwise the box mirrors the option list, so edits made elsewhere show up here. */
function optionsBoxFor(p,s,qid,q){
  const key=optionsBoxKey(p,s,qid),state=optionsBoxState[key];
  if(state&&(state.pending||state.invalid||optionsBoxMatches(state.text,q)))return state;
  return optionsBoxState[key]={text:optionsBoxText(q),pending:false,invalid:false,error:''};
}
function optionsBoxCount(count){return count===0?'No options yet':count===1?'1 option · add at least one more':count+' options'}
function optionsBoxField(box){
  const count=optionsBoxRecords(box.text).length;
  return '<div class="field options-box"><label for="optionsBox">Your options</label><textarea id="optionsBox" name="optionsBox" data-options-box rows="6" maxlength="262144" spellcheck="false" autocomplete="off" aria-describedby="optionsBoxHint optionsBoxStatus optionsBoxError" aria-invalid="'+!!box.error+'" placeholder="Orbital Empire: an empire, but in orbit&#10;Starfall&#10;Project Dawn: a new beginning">'+esc(box.text)+'</textarea>'+
    '<small id="optionsBoxHint">One option per line. Add a description after a colon or tab, e.g. <code>Orbital Empire: an empire, but in orbit</code>. You can drop a CSV or JSON file here.</small>'+
    '<div class="options-box-meta"><strong id="optionsBoxStatus" role="status" aria-live="polite">'+esc(box.error?'':optionsBoxCount(count))+'</strong><span id="optionsBoxError" class="options-box-error" role="alert" '+(box.error?'':'hidden')+'>'+esc(box.error)+'</span></div></div>';
}
/** Keeps the compact list, count and Options tab in step with the box without redrawing it, so typing is never interrupted. */
function optionsBoxRefresh(p,s,qid,q,state,count){
  const status=document.getElementById('optionsBoxStatus'),error=document.getElementById('optionsBoxError'),list=root.querySelector('[data-options-list]'),box=root.querySelector('[data-options-box]'),tab=root.querySelector('.round-tab[data-section=answers]');
  if(status)status.textContent=state.error?'':optionsBoxCount(count);
  if(error){error.textContent=state.error;error.hidden=!state.error}
  box?.setAttribute?.('aria-invalid',String(!!state.error));
  if(list)list.innerHTML=choiceOptionList(p,s,qid,q);
  if(tab&&typeof flowStopDone==='function'){const done=flowStopDone(p,s,'answers');tab.toggleAttribute?.('data-done',done);tab.toggleAttribute?.('data-todo',!done);tab.innerHTML=flowTabContent('Options',!done,done)}
}
/** Reads the box into the option list: names that already exist keep their IDs, descriptions and custom fields; everything else gets a new ID. Returns what was read. */
function optionsBoxCommit(text){
  clearTimeout(optionsBoxTimer);
  const p=pipeline(),s=selectedStage(),entry=s?.kind==='poll'?setupQuestion(s):null,q=entry?.[1];
  if(!p||!q||q.type!=='choice')return null;
  const key=optionsBoxKey(p,s,entry[0]),state=optionsBoxState[key]||(optionsBoxState[key]={text:'',pending:false,invalid:false,error:''});
  state.text=text??root.querySelector('[data-options-box]')?.value??state.text;state.pending=false;
  const records=optionsBoxRecords(state.text),labels=records.map(record=>record.label),repeated=labels.find((label,i)=>labels.indexOf(label)!==i);
  state.error=labels.length>255?'Use up to 255 options. This list has '+labels.length+'.':repeated?'“'+repeated+'” appears more than once. Give each option different text.':'';
  state.invalid=!!state.error;
  if(!state.error){
    const next=mergeOptionCriteria(q,labels,new Map(records.map(record=>[record.label,record.description])),true);
    if(JSON.stringify(next)!==JSON.stringify(q.criteria)){q.criteria=next;S.dirty=true;S.plan=null;S.listPages[S.projectId+':setup-options-'+s.id+'-'+entry[0]]=0}
  }
  optionsBoxRefresh(p,s,entry[0],q,state,labels.length);
  return {records,error:state.error};
}
/** Typing reads the box after a short pause. */
function optionsBoxInput(el){
  const p=pipeline(),s=selectedStage(),entry=s?.kind==='poll'?setupQuestion(s):null;if(!p||!entry)return;
  const state=optionsBoxState[optionsBoxKey(p,s,entry[0])]||(optionsBoxState[optionsBoxKey(p,s,entry[0])]={text:'',pending:false,invalid:false,error:''});
  state.text=el.value;state.pending=true;S.dirty=true;S.plan=null;if(typeof updateSaveState==='function')updateSaveState();
  clearTimeout(optionsBoxTimer);optionsBoxTimer=setTimeout(()=>{try{optionsBoxCommit()}catch(error){fail(error)}},250);
}
function optionsBoxMessage(message){const error=document.getElementById('optionsBoxError');if(error){error.textContent=message;error.hidden=!message}}
/** A dropped CSV or JSON file replaces the box with its names and descriptions, read by the same parsers as the import dialog. */
async function optionsBoxFile(file){
  const s=selectedStage(),q=s&&setupQuestion(s)?.[1];if(!file||q?.type!=='choice')return;
  try{
    if(file.size>256*1024)throw Error('File is too large. The maximum size is 256 KiB.');
    const text=await file.text(),records=answerFileRecords(answerFileLayout(file.name,text,'choice'),'choice');
    if(!records.length)throw Error('That file has no options in it.');
    const next=records.map(record=>optionsBoxLine(optionsBoxFlat(record.label),record.description||'')).join('\n'),box=root.querySelector('[data-options-box]');
    if(box)box.value=next;
    const result=optionsBoxCommit(next);if(result&&!result.error)if(typeof say==='function')say(result.records.length+' options read from '+file.name+'.');
  }catch(error){optionsBoxMessage(error.message)}
}
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
.options-box{margin-bottom:0}
.options-box textarea{min-height:140px;max-height:50dvh;resize:vertical;line-height:1.5}
.options-box textarea.dragging{border-color:var(--blue);background:var(--selection)}
.options-box code{font-size:11px;overflow-wrap:anywhere}
.options-box-meta{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;min-height:20px;font-size:12px}
.options-box-meta strong{font-weight:600}
.options-box-error{color:var(--red)}
.options-more{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin:8px 0 4px}
.options-more>span{font-size:12px;color:var(--muted)}
[data-options-list]:not(:empty){margin-top:8px}
`;
