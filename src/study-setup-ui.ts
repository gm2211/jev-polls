/** Point-and-click study setup. Existing pipeline contracts remain unchanged. */
export const STUDY_SETUP_CLIENT = String.raw`
function answerName(type){return {choice:'Compare options',noul:'Yes / no',score:'Ordered scale'}[type]||'Result'}
function optionName(key,value){return value&&typeof value==='object'?value.label:value??key}
function optionDescription(value){return value&&typeof value==='object'?value.description:''}
function stepTitle(p,s){
  const questions=Object.values(s.questions||{}),question=questions[0]?.label?.trim();
  const custom=s.label?.trim(),prefix=s.kind==='poll'&&custom&&!['First question','Next question','New question'].includes(custom)&&custom!==question?custom+': ':'';
  const title=s.kind==='poll'?prefix+(question&&question!=='What should this phase decide?'?question:'Untitled question')+(questions.length>1?' + '+(questions.length-1)+' more':''):(s.label?.trim()||(s.kind==='aggregate'?'Combine answers':'Final result'));
  return (p.stages.findIndex(x=>x.id===s.id)+1)+'. '+title.replace(/\s+/g,' ');
}
function inputTitle(p,input){
  const source=p.stages.find(x=>x.id===input.stage);if(!source)return input.stage;
  const question=source.questions?.[input.question];
  return stepTitle(p,question?{...source,questions:{[input.question]:question}}:source);
}
function updateStepPicker(form){
  const p=pipeline(),s=selectedStage(),qid=form.dataset.questionId;if(!p||!s||!s.questions?.[qid])return;
  const prompt=form.querySelector('[name=setupPrompt]')?.value;if(prompt===undefined)return;
  const draft={...s,questions:{...s.questions,[qid]:{...s.questions[qid],label:prompt}}};
  root.querySelectorAll('[name=phasePicker] option').forEach(option=>{if(option.value===s.id)option.textContent=stepTitle(p,draft)});
}
function setupQuestion(s){const entries=Object.entries(s.questions||{});return entries.find(([key])=>key===S.sections['setup-question-'+s.id])||entries[0]}
function stageForm(p,s){
  if(s.kind!=='poll')return resultSetup(p,s);
  const mode=S.sections.pipeline||'phase',tabs='';
  if(mode==='advanced')return tabs+advancedStageForm(p,s);
  const entry=setupQuestion(s),pool=poolForPhase(p,s);
  const picker='<div class="phase-picker">'+select('phasePicker',p.stages.map(x=>({value:x.id,label:stepTitle(p,x)})),s.id,'Selected step')+'<button type="button" class="button small icon-button step-settings-button" aria-label="Step settings" title="Step settings" data-act="section-view" data-section-key="pipeline" data-section-id="advanced">'+icon('settings')+'</button></div>';
  if(!entry)return tabs+panel('Add a question','','<button class="button primary" data-act="add-question">Add question</button>',picker);
  const [qid,q]=entry,entries=Object.entries(s.questions),cohorts=pageItems(projectCohorts(),'setup-cohorts-'+s.id,4);
  const questionPicker=entries.length>1?'<nav class="section-tabs" aria-label="Questions in this step">'+entries.map(([key,value])=>'<button type="button" class="button small" data-act="setup-question" data-id="'+attr(key)+'" aria-pressed="'+(key===qid)+'">'+esc(value.label||key)+'</button>').join('')+'</nav>':'';
  const cohortChoices=cohorts.items.map(c=>'<div class="setup-cohort-row" data-selected="'+(pool?.id===c.id)+'"><button type="button" class="setup-choice" data-act="setup-cohort" data-id="'+attr(c.id)+'" aria-pressed="'+(pool?.id===c.id)+'"><strong>'+esc(c.name)+'</strong><span>'+c.personas.length.toLocaleString('en-US')+(c.personas.length===1?' persona':' personas')+(pool?.id===c.id?' · Selected':'')+'</span></button><button type="button" class="button small cohort-details" aria-label="Details: '+attr(c.name)+'" title="Open cohort details" data-act="phase-pool" data-id="'+attr(c.id)+'">Details '+icon('right')+'</button></div>').join('');
  const types='<div class="row setup-types" aria-label="Answer format">'+['choice','noul','score'].map(type=>'<button type="button" class="button" data-act="setup-type" data-type="'+type+'" aria-pressed="'+(q.type===type)+'">'+answerName(type)+'</button>').join('')+'</div>';
  const options=q.type==='score'?q.criteria.map((label,i)=>({key:String(i),label})):[],optionPage=pageItems(options,'setup-options-'+s.id+'-'+qid,4);
  const optionRows=optionPage.items.map((o,offset)=>{const i=optionPage.start+offset;return '<div class="setup-option" data-setup-option="'+attr(o.key)+'"><input name="setupOption" aria-label="Scale level '+(i+1)+'" placeholder="Describe this level" value="'+attr(o.label)+'"><button type="button" class="button small icon-button" data-act="setup-remove-option" data-key="'+attr(o.key)+'" aria-label="Remove level '+(i+1)+'" title="Remove level '+(i+1)+'" '+(options.length<=2?'disabled':'')+'>'+icon('trash')+'</button></div>'}).join('');
  const answer=q.type==='choice'?choiceOptionSetup(p,s,qid,q,types):types+(q.type==='noul'?'<p class="subtle">'+(S.evaluationProvider==='gliner'?'Returns a relative yes score from 0 to 1; not a calibrated probability.':'Returns probability of yes, from 0 to 1.')+'</p>':'<p class="subtle">Describe ordered levels, from lowest to highest.</p><div class="setup-options">'+optionRows+'</div>'+optionPage.controls+'<div class="row"><button type="button" class="button small icon-button" title="Add level" aria-label="Add level" data-act="setup-add-option" '+(options.length>=10?'disabled':'')+'>'+icon('plus')+'</button><button type="button" class="button small icon-button" aria-label="Paste list" title="Paste list" data-act="answer-list-open">'+icon('paste')+'</button><button type="button" class="button small icon-button" aria-label="Import CSV" title="Import CSV" data-act="answer-list-import">'+icon('upload')+'</button></div><p class="setup-answer-summary">'+(S.evaluationProvider==='gliner'?'Local GLiNER returns a position from 0 to '+(options.length-1)+', plus relative level scores normalized to total 1. These are not calibrated probabilities.':'Jev Score returns a position from 0 to '+(options.length-1)+', plus probabilities across these levels totaling 1.')+'</p>');
  const form='<form data-form="study-setup" data-question-id="'+attr(qid)+'">'+questionPicker+'<div class="setup-prompt-row">'+area('What do you want to ask?','setupPrompt',q.label,'','2')+picker+'</div>'+setupContextSummary(p,s)+'<div class="setup-columns"><section><div class="setup-section-heading"><h3>Who answers?</h3></div><div class="setup-cohorts">'+cohortChoices+'</div>'+cohorts.controls+(!pool?'<p class="subtle">Choose a cohort for this question.</p>':'')+(!projectCohorts().length?'<button type="button" class="button" data-act="new-cohort">Generate a cohort</button>':'')+'</section><section><div class="setup-section-heading"><h3>'+ (q.type==='choice'?'Options to compare':'How should they answer?') +'</h3></div>'+answer+'</section></div></form>';
  return '<section class="panel setup-panel">'+form+'<div class="setup-footer"><button class="button" data-act="next-phase">＋ Ask a follow-up</button></div></section>';
}
function choiceOptionSetup(p,s,qid,q,types){
  const stateKey='setup-option-'+s.id+'-'+qid,formatKey='setup-format-'+s.id+'-'+qid;
  const selected=S.sections[stateKey],editing=selected!==undefined&&Object.hasOwn(q.criteria,selected);
  const toolbar='<div class="row setup-import-actions"><button type="button" class="button primary" data-act="answer-list-import">'+icon('upload')+' Import file</button><button type="button" class="button" data-act="option-agent-open">Create with agent</button><button type="button" class="button" data-act="answer-list-open">'+icon('paste')+' Paste list</button><button type="button" class="button small icon-button" data-act="setup-add-option" aria-label="Add option" title="Add option" '+(Object.keys(q.criteria).length>=255?'disabled':'')+'>'+icon('plus')+'</button></div>';
  const output='<div class="setup-output-format"><span>'+ (S.evaluationProvider==='gliner'?'Normalized option scores':'Probability distribution') +'</span><button type="button" class="button small" data-act="setup-format" aria-label="Change answer format">Change format</button></div>';
  if(S.sections[formatKey])return '<div class="row"><button type="button" class="button small" data-act="setup-format-back">'+icon('left')+' Back to options</button></div>'+types;
  if(editing){const keys=Object.keys(q.criteria),i=keys.indexOf(selected),value=q.criteria[selected];return '<button type="button" class="button small" data-act="setup-option-back">'+icon('left')+' Back to options</button><div class="setup-option-editor" data-setup-option="'+attr(selected)+'"><label>Option name<input name="setupOption" aria-label="Option '+(i+1)+' name" value="'+attr(optionName(selected,value))+'"></label><label>Description (optional)<textarea name="setupDescription" rows="3" aria-label="Option '+(i+1)+' description">'+esc(optionDescription(value))+'</textarea></label></div>';}
  const options=Object.entries(q.criteria).filter(([key,value])=>String(optionName(key,value)).trim()),page=pageItems(options,'setup-options-'+s.id+'-'+qid,4);
  const list=options.length?'<div class="setup-option-list">'+page.items.map(([key,value])=>'<div class="setup-option-record"><button type="button" class="setup-option-edit" data-act="setup-edit-option" data-key="'+attr(key)+'" aria-label="Edit option '+attr(optionName(key,value))+'"><span><strong>'+esc(optionName(key,value))+'</strong>'+(optionDescription(value)?'<small>'+esc(optionDescription(value))+'</small>':'')+'</span>'+icon('edit')+'</button><button type="button" class="button small icon-button" data-act="setup-remove-option" data-key="'+attr(key)+'" aria-label="Remove option '+attr(optionName(key,value))+'" title="Remove option" '+(Object.keys(q.criteria).length<=2?'disabled':'')+'>'+icon('trash')+'</button></div>').join('')+'</div>'+page.controls:'<button type="button" class="setup-file-drop" data-answer-drop="true" data-act="answer-list-import"><strong>Drop CSV or JSON here</strong><span>Names and optional descriptions · or choose file</span></button>';
  return output+toolbar+'<p class="subtle">'+(options.length?options.length+' options':'CSV: one option per row; description column optional.')+'</p>'+list+'<p class="setup-answer-summary">'+(S.evaluationProvider==='gliner'?'Local GLiNER returns relative option scores: 0–1, normalized to total 1. These are not calibrated probabilities.':'Jev returns a probability for every option: 0–1, totaling 1.')+'</p>';
}
function applyStudySetup(form){
  const s=selectedStage(),qid=form.dataset.questionId,q=s?.questions?.[qid];if(!q)return;
  const d=new FormData(form),label=String(d.get('setupPrompt')??q.label);
  // Preserve custom instructions; remove only the duplicated question from our old default.
  const suffix='\nChoose the option that best answers this question. Select no-match if none is suitable.';
  if(label!==q.label&&q.instructions===q.label+suffix)q.instructions='Answer the question using your persona and the supplied context.';
  q.label=label;
  for(const row of form.querySelectorAll('[data-setup-option]')){
    const key=row.dataset.setupOption,value=row.querySelector('[name=setupOption]').value;
    if(q.type==='choice'){const old=q.criteria[key],description=row.querySelector('[name=setupDescription]')?.value??optionDescription(old);if(value!==optionName(key,old)||description!==optionDescription(old))q.criteria[key]={...(old&&typeof old==='object'&&!Array.isArray(old)?old:{}),label:value,description}}
    else if(q.type==='score')q.criteria[Number(key)]=value;
  }
  S.dirty=true;S.plan=null;
}
function assignSetupCohort(p,s,cid){
  if(!projectCohorts().some(c=>c.id===cid))throw Error('Choose a cohort from this project.');
  let alias=Object.entries(p.cohorts).find(([,value])=>value===cid)?.[0];
  if(!alias){alias='cohort';let n=2;while(Object.hasOwn(p.cohorts,alias))alias='cohort_'+n++;p.cohorts[alias]=cid}
  s.cohort=alias;
}
function setupContextSummary(p,s){
  const sources=s.inputs===undefined?s.dependsOn.map(id=>{const source=p.stages.find(x=>x.id===id);return source?stepTitle(p,source):id}):Object.values(s.inputs).map(input=>inputTitle(p,input));
  const labels=[...new Set(sources)];
  return labels.length?'<p class="setup-context subtle">This cohort also sees results from: '+labels.map(label=>'“'+esc(label)+'”').join('; ')+'.</p>':'';
}
function reconcileSetupDependencies(s,removed,remaining){
  const conditional=new Set();
  const visit=node=>{if(!node)return;if(node.stage)conditional.add(node.stage);for(const child of node.all||node.any||[])visit(child);if(node.not)visit(node.not)};visit(s.when);
  s.dependsOn=s.dependsOn.filter(id=>!removed.includes(id)||remaining.includes(id)||conditional.has(id));
  for(const id of remaining)if(id&&!s.dependsOn.includes(id))s.dependsOn.push(id);
}
function setupAnswerSignature(q){return JSON.stringify([q?.type,q?.type==='choice'?Object.entries(q.criteria||{}).sort(([a],[b])=>a.localeCompare(b)):q?.criteria])}
function resultSetup(p,s){
  const mode=S.sections.pipeline||'phase',tabs='';
  if(mode==='advanced')return tabs+advancedStageForm(p,s);
  const current=s.kind==='decision'?[s.from]:s.inputs,first=current.find(x=>x.stage&&x.question),base=first?resolvedQuestion(p,first.stage,first.question):null;
  const compatible=q=>!base||setupAnswerSignature(q)===setupAnswerSignature(base);
  const outputs=dataInputOptions(p,s).flatMap(source=>phaseOutput(p,source).map(q=>({source,q}))).filter(({source,q})=>s.kind==='decision'?q.type==='choice':compatible(resolvedQuestion(p,source.id,q.id)||{}));
  const page=pageItems(outputs,'setup-results-'+s.id,5);
  const content=page.items.map(({source,q})=>{
    const selected=current.some(x=>x.stage===source.id&&x.question===q.id);
    return '<button class="setup-choice" data-act="setup-result" data-source="'+attr(source.id)+'" data-question="'+attr(q.id)+'" aria-pressed="'+selected+'"><strong>'+esc(q.label||source.label)+'</strong><span>'+'Step '+(p.stages.indexOf(source)+1)+' · '+answerName(q.type)+(selected?' · Selected':'')+'</span></button>';
  }).join('');
  return tabs+panel(s.kind==='decision'?'Which answer should supply the result?':'Which answers should be combined?',s.kind==='decision'?'Uses the leading option from one earlier answer.':'Choose answers with matching options or ordered levels. New selections get equal weight.','<div class="setup-connections">'+(content||'<p>No compatible earlier answers available.</p>')+'</div>'+page.controls,'<div class="phase-picker">'+select('phasePicker',p.stages.map(x=>({value:x.id,label:stepTitle(p,x)})),s.id,'Selected step')+'<button type="button" class="button small icon-button step-settings-button" aria-label="Step settings" title="Step settings" data-act="section-view" data-section-key="pipeline" data-section-id="advanced">'+icon('settings')+'</button></div>');
}
function setupAction(a,el){
  if(!a.startsWith('setup-'))return false;
  const p=pipeline(),s=selectedStage();if(!p||!s)return true;
  if(a==='setup-result'){
    const source=dataInputOptions(p,s).find(x=>x.id===el.dataset.source),qid=el.dataset.question,q=source&&resolvedQuestion(p,source.id,qid);
    if(!q||!phaseOutput(p,source).some(x=>x.id===qid))throw Error('Choose an available earlier answer.');
    const before=s.kind==='decision'?[s.from.stage]:s.kind==='aggregate'?s.inputs.map(x=>x.stage):[];
    if(s.kind==='decision'){if(q.type!=='choice')throw Error('Select an option comparison.');s.from={stage:source.id,question:qid}}
    else if(s.kind==='aggregate'){
      const index=s.inputs.findIndex(x=>x.stage===source.id&&x.question===qid),base=s.inputs[0]&&resolvedQuestion(p,s.inputs[0].stage,s.inputs[0].question);
      if(index>=0)s.inputs.splice(index,1);
      else {if(base&&setupAnswerSignature(q)!==setupAnswerSignature(base))throw Error('Combined answers must use matching options or ordered levels.');s.inputs.push({stage:source.id,question:qid,weight:1})}
    }else return true;
    reconcileSetupDependencies(s,before,s.kind==='decision'?[s.from.stage]:s.inputs.map(x=>x.stage));
    S.dirty=true;S.plan=null;render();return true;
  }
  if(s.kind!=='poll')return true;
  const entry=setupQuestion(s),q=entry?.[1];
  if(a==='setup-question'){S.sections['setup-question-'+s.id]=el.dataset.id;render();return true}
  if(a==='setup-cohort')assignSetupCohort(p,s,el.dataset.id);
  else if(a==='setup-edit-option'){S.sections['setup-option-'+s.id+'-'+entry[0]]=el.dataset.key;render();root.querySelector('[name=setupOption]')?.focus();return true}
  else if(a==='setup-option-back'){delete S.sections['setup-option-'+s.id+'-'+entry[0]];render();return true}
  else if(a==='setup-format'||a==='setup-format-back'){S.sections['setup-format-'+s.id+'-'+entry[0]]=a==='setup-format';render();return true}
  else if(a==='setup-type'){
    delete S.sections['setup-format-'+s.id+'-'+entry[0]];delete S.sections['setup-option-'+s.id+'-'+entry[0]];
    const type=el.dataset.type;if(!['choice','noul','score'].includes(type)||q.type===type)return true;
    // Cache formats per question so exploring formats never destroys typed options.
    const key=p.id+':'+s.id+':'+entry[0];setupFormats[key]??={};setupFormats[key][q.type]=clone(q);
    s.questions[entry[0]]=setupFormats[key][type]?{...clone(setupFormats[key][type]),label:q.label}:{type,label:q.label,instructions:'Answer the question using your persona and the supplied context.',...(type==='choice'?{criteria:{option_1:'',option_2:''}}:type==='score'?{criteria:['Does not meet the stated goal','Partly meets the stated goal','Fully meets the stated goal']}: {})};
  }else if(a==='setup-add-option'){
    if(q.type==='choice'){if(Object.keys(q.criteria).length>=255)return true;let key='option_'+id();while(Object.hasOwn(q.criteria,key))key='option_'+id();q.criteria[key]='';S.sections['setup-option-'+s.id+'-'+entry[0]]=key}
    else if(q.type==='score'&&q.criteria.length<10)q.criteria.push('');
    const count=q.type==='choice'?Object.keys(q.criteria).length:q.criteria.length;S.listPages[S.projectId+':setup-options-'+s.id+'-'+entry[0]]=Math.floor((count-1)/4);
  }else if(a==='setup-remove-option'){
    if(q.type==='choice'&&Object.keys(q.criteria).length>2)delete q.criteria[el.dataset.key];
    if(q.type==='score'&&q.criteria.length>2)q.criteria.splice(Number(el.dataset.key),1);
  }else return false;
  S.dirty=true;S.plan=null;render();if(a==='setup-add-option')root.querySelector('[name=setupOption]')?.focus();return true;
}
const setupFormats={};
function validateSetupAnswers(p){
  for(const s of p?.stages||[])if(s.kind==='poll')for(const [qid,q] of Object.entries(s.questions)){
    const missing=!q.label.trim()||(q.type==='choice'&&Object.entries(q.criteria).some(([key,value])=>!String(optionName(key,value)).trim()))||(q.type==='score'&&q.criteria.some(value=>!value.trim()));
    if(missing){S.stageId=s.id;S.sections.pipeline='phase';S.sections.pipeline='phase';S.sections['setup-question-'+s.id]=qid;render();throw Error('Add the question and text for every answer option before reviewing.');}
  }
}
`;

export const STUDY_SETUP_CSS = `
.setup-file-drop{width:100%;display:grid;gap:4px;padding:22px 12px;border:1px dashed var(--control-line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;text-align:center;cursor:pointer}.setup-file-drop span{font-size:12px;color:var(--muted)}.setup-file-drop:hover{border-color:var(--blue);background:var(--blue-soft)}

.setup-output-format{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;font-size:12px;color:var(--muted)}.setup-import-actions{margin-bottom:10px}.setup-option-list{margin-top:12px}.setup-option-record{display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line);padding:8px 0}.setup-option-edit{display:flex;align-items:center;gap:12px;flex:1;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;padding:4px 0;cursor:pointer}.setup-option-edit>span{flex:1;min-width:0}.setup-option-edit strong{display:block;font-size:13px;overflow-wrap:anywhere}.setup-option-edit small{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.setup-option-edit .ui-icon{width:14px;height:14px;flex:none;color:var(--muted)}.setup-option-record>.button{flex:none}.setup-option-editor{display:grid;gap:14px;margin-top:16px}.setup-option-editor label{display:grid;gap:6px;font-size:12px;font-weight:600}.setup-options-empty{font-size:12px;color:var(--muted);margin:16px 0}

.phase-picker:has(.step-settings-button){display:grid;grid-template-columns:minmax(0,1fr) var(--control-height);gap:8px;align-items:end;width:100%}.step-settings-button{margin:0;align-self:end}.button.icon-button.step-settings-button{width:var(--control-height);height:var(--control-height)}.study-step-settings{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}.study-step-settings strong{font-size:12px;overflow-wrap:anywhere}.setup-prompt-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;align-items:start;margin-bottom:20px}.setup-prompt-row .field{margin-bottom:0}.setup-prompt-row .phase-picker{margin-top:0}.phase-picker .field{gap:6px}.setup-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.setup-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:var(--button-height);margin-bottom:12px}.setup-columns .setup-section-heading h3{margin:0}.setup-columns h3{margin:0 0 12px;font-size:14px}.setup-columns>section{min-width:0}.setup-cohorts,.setup-connections{display:grid;gap:8px}.setup-choice{appearance:none;width:100%;min-height:48px;text-align:left;font:inherit;color:var(--ink);background:var(--raised);border:1px solid var(--line);padding:10px 12px;cursor:pointer;border-radius:var(--radius-control)}.setup-cohort-row{display:flex;align-items:center;gap:8px;min-width:0;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--raised)}.setup-cohort-row[data-selected=true]{background:var(--selection);border-color:var(--blue);box-shadow:inset 3px 0 var(--blue)}.setup-cohort-row>.setup-choice{flex:1;min-width:0;border:0;background:transparent;box-shadow:none}.setup-cohort-row>.setup-choice:hover{background:var(--hover)}.setup-cohort-row[data-selected=true]>.setup-choice:hover{background:var(--selection)}.setup-cohort-row>.cohort-details{margin-right:8px;gap:4px;flex-shrink:0;padding-inline:8px;background:transparent;border-color:transparent}.setup-cohort-row>.cohort-details:hover{background:var(--hover);border-color:var(--line)}.cohort-details .ui-icon{width:14px;height:14px}.setup-choice strong,.setup-choice span span{display:block}.setup-choice strong{font-size:13px;overflow-wrap:anywhere}.setup-choice span{font-size:12px;color:var(--muted)}.setup-choice[aria-pressed=true]{background:var(--selection);border-color:var(--blue);box-shadow:inset 3px 0 var(--blue)}.setup-choice:hover{background:var(--hover);border-color:var(--control-line)}.setup-choice[aria-pressed=true]:hover{background:var(--selection)}.setup-choice:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.setup-types [aria-pressed=true]{background:var(--selection);color:var(--ink);border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}.setup-options{display:grid;gap:10px;margin:10px 0}.setup-option{display:grid;grid-template-columns:minmax(0,1fr) var(--control-height);align-items:start;gap:8px}.setup-option .button.icon-button{width:var(--control-height);height:var(--control-height);min-width:var(--control-height);align-self:start}.setup-option-fields{display:grid;gap:8px;min-width:0}.setup-option-fields [name=setupOption]{font-weight:600}[data-form=study-setup] .setup-option-fields [name=setupDescription]{font-size:12px;min-height:48px;height:54px;line-height:1.4}.setup-answer-summary{border-top:1px solid var(--line);padding-top:10px;margin-top:12px!important;font-size:12px;color:var(--muted)}.setup-context{margin:0 0 18px;overflow-wrap:anywhere}.setup-footer{display:flex;justify-content:flex-end;align-items:center;gap:12px;margin-top:18px;padding-top:12px;border-top:1px solid var(--line)}.setup-connections .setup-choice{display:flex;gap:12px;align-items:center}[data-form=study-setup]> .field{margin-bottom:20px}[data-form=study-setup] textarea{min-height:70px}
@media(max-width:650px){.setup-prompt-row{grid-template-columns:minmax(0,1fr);gap:16px}.setup-prompt-row .phase-picker{grid-row:1;width:100%}.setup-prompt-row textarea{min-height:70px}.setup-columns{grid-template-columns:minmax(0,1fr);gap:18px}.setup-footer{flex-wrap:wrap}.setup-types{gap:6px}}
`;
