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
function stepSettingsLabel(p,s){
  if(!s)return 'No step selected';
  const n=p.stages.findIndex(x=>x.id===s.id)+1,title=stepTitle(p,s).replace(/^\d+\. /,'');
  return 'Step '+n+' settings'+(title.replace(/\s+/g,' ')===studyQuestion(p).replace(/\s+/g,' ')?'':' · '+title);
}
function inputTitle(p,input){
  const source=p.stages.find(x=>x.id===input.stage);if(!source)return input.stage;
  const question=source.questions?.[input.question];
  return stepTitle(p,question?{...source,questions:{[input.question]:question}}:source);
}
function setupQuestionText(q){const text=q?.label||'';return text.trim()==='What should this phase decide?'?'':text}
function setupStageRole(p,s){
  if(s.kind!=='poll')return s.kind==='aggregate'?'Combined answer':'Final answer';
  const polls=p.stages.filter(x=>x.kind==='poll'),index=polls.findIndex(x=>x.id===s.id);
  return index===0?'Main question':s.dependsOn?.length?'Follow-up '+index:'Independent question '+(index+1);
}
function setupQuestionToolbar(p,s){
  const listLabel=p.stages.every(x=>x.kind==='poll')?'All questions':'Study outline';
  return '<div class="setup-question-location"><strong tabindex="-1">'+esc(setupStageRole(p,s))+'</strong><div class="row">'+(p.stages.length>1?'<button type="button" class="button small" data-act="setup-question-list">'+listLabel+'</button>':'')+'<button type="button" class="button small icon-button step-settings-button" aria-label="Step settings" title="Step settings" data-act="section-view" data-section-key="pipeline" data-section-id="advanced">'+icon('settings')+'</button></div></div>';
}
function studyQuestionList(p){
  const page=pageItems(p.stages,'study-questions-'+p.id,6);
  const rows=page.items.map(s=>{
    const entries=Object.values(s.questions||{}),missing=s.kind==='poll'?entries.map(q=>setupWizardReady(q,poolForPhase(p,s)).findIndex(value=>!value)).find(index=>index>=0):undefined;
    const status=s.kind==='poll'?(!entries.length?'Question needed':missing===undefined?'Ready to review':['Question needed','Choose cohort','Options needed'][missing]):s.kind==='aggregate'&&!s.inputs?.length?'Choose earlier answers':s.kind==='decision'&&!p.stages.some(x=>x.id===s.from?.stage)?'Choose source answer':'Ready to review';
    const questions=entries.map(q=>setupQuestionText(q)||'Write your question').join(' · '),custom=s.label?.trim();
    const text=s.kind==='poll'?(custom&&!['First question','Next question','New question'].includes(custom)&&custom!==questions?custom+': ':'')+questions:s.label||setupStageRole(p,s);
    return '<button type="button" class="setup-question-row" data-act="setup-edit-step" data-id="'+attr(s.id)+'" aria-label="Edit '+attr(setupStageRole(p,s))+': '+attr(text)+'"><span><strong>'+esc(setupStageRole(p,s))+'</strong><span>'+esc(text)+'</span></span><small>'+esc(status)+'</small>'+icon('right')+'</button>';
  }).join('');
  return '<section class="panel setup-question-list"><div class="setup-outline-heading"><h2 tabindex="-1">Questions in this study</h2><button type="button" class="button small" data-act="setup-edit-step" data-id="'+attr(S.stageId||p.stages[0]?.id||'')+'">Return to editor</button></div><p class="subtle">Each question has its own cohort and answer options.</p><div class="setup-question-rows">'+rows+'</div>'+page.controls+'</section>';
}
function setupQuestion(s){const entries=Object.entries(s.questions||{});return entries.find(([key])=>key===S.sections['setup-question-'+s.id])||entries[0]}
function setupCohortPicker(p,s){
  if(inlineCohortTarget(p,s))return cohortGenerator(true);
  const pool=poolForPhase(p,s),cohorts=pageItems(projectCohorts(),'setup-cohorts-'+s.id,4);
  const pending=cohortDraftElsewhere(p,s),notice=pending?'<div class="notice"><p>A cohort draft is already in progress. Review it before creating another.</p><div class="row"><button type="button" class="button small" data-act="cohort-resume">Review existing draft</button>'+(S.localJob.status==='running'?draftCancelButton(S.localJob):'<button type="button" class="button small" data-act="assistant-discard">Discard version</button>')+'</div></div>':'';
  const choices=cohorts.items.map(c=>'<div class="setup-cohort-row" data-selected="'+(pool?.id===c.id)+'"><button type="button" class="setup-choice" data-act="setup-cohort" data-id="'+attr(c.id)+'" aria-pressed="'+(pool?.id===c.id)+'"><strong>'+esc(c.name)+'</strong><span>'+c.personas.length.toLocaleString('en-US')+(c.personas.length===1?' persona':' personas')+(pool?.id===c.id?' · Selected':'')+'</span></button><button type="button" class="button small cohort-details" aria-label="Details: '+attr(c.name)+'" title="Open cohort details" data-act="phase-pool" data-id="'+attr(c.id)+'">Details '+icon('right')+'</button></div>').join('');
  return notice+(projectCohorts().length?'<div class="setup-section-heading"><h3>Who answers?</h3><button type="button" class="button small" data-act="new-cohort" '+(pending?'disabled':'')+'>'+icon('plus')+'New cohort</button></div><div class="setup-cohorts">'+choices+'</div>'+cohorts.controls+(!pool?'<p class="subtle">Choose a cohort for this question.</p>':''):'<div class="setup-cohort-empty"><h3>Who answers this step?</h3><p>Describe the people you want to hear from. Jev drafts virtual personas right here; when you accept them, the cohort joins your library and is assigned to this step.</p><button type="button" class="button primary" data-act="new-cohort" '+(pending?'disabled':'')+'>'+icon('plus')+'New cohort</button></div>');
}
function stageForm(p,s,focused=false){
  if(s.kind!=='poll')return resultSetup(p,s);
  const mode=S.sections.pipeline||'phase',tabs='';
  if(mode==='advanced')return tabs+advancedStageForm(p,s);
  const entry=setupQuestion(s),pool=poolForPhase(p,s);
  const picker=setupQuestionToolbar(p,s);
  if(!entry)return tabs+panel('Add a question','','<button class="button primary" data-act="add-question">Add question</button>',picker);
  const [qid,q]=entry,entries=Object.entries(s.questions);
  const questionPicker=entries.length>1?'<nav class="section-tabs" aria-label="Questions in this step">'+entries.map(([key,value])=>'<button type="button" class="button small" data-act="setup-question" data-id="'+attr(key)+'" aria-pressed="'+(key===qid)+'">'+esc(setupQuestionText(value)||'Question '+(entries.findIndex(([id])=>id===key)+1))+'</button>').join('')+'</nav>':'';

  const types='<div class="row setup-types" aria-label="Answer format">'+['choice','noul','score'].map(type=>'<button type="button" class="button" data-act="setup-type" data-type="'+type+'" aria-pressed="'+(q.type===type)+'">'+answerName(type)+'</button>').join('')+'</div>';
  const options=q.type==='score'?q.criteria.map((label,i)=>({key:String(i),label})):[],optionPage=pageItems(options,'setup-options-'+s.id+'-'+qid,4);
  const optionRows=optionPage.items.map((o,offset)=>{const i=optionPage.start+offset;return '<div class="setup-option" data-setup-option="'+attr(o.key)+'"><input name="setupOption" aria-label="Scale level '+(i+1)+'" placeholder="Describe this level" value="'+attr(o.label)+'"><button type="button" class="button small icon-button" data-act="setup-remove-option" data-key="'+attr(o.key)+'" aria-label="Remove level '+(i+1)+'" title="Remove level '+(i+1)+'" '+(options.length<=2?'disabled':'')+'>'+icon('trash')+'</button></div>'}).join('');
  const answer=q.type==='choice'?choiceOptionSetup(p,s,qid,q,types):types+(q.type==='noul'?'<p class="subtle">'+(S.evaluationProvider==='gliner'?'Returns a relative yes score from 0 to 1; not a calibrated probability.':'Returns probability of yes, from 0 to 1.')+'</p>':'<p class="subtle">Describe ordered levels, from lowest to highest.</p><div class="setup-options">'+optionRows+'</div>'+optionPage.controls+'<div class="row"><button type="button" class="button small icon-button" title="Add level" aria-label="Add level" data-act="setup-add-option" '+(options.length>=10?'disabled':'')+'>'+icon('plus')+'</button><button type="button" class="button small icon-button" aria-label="Paste list" title="Paste list" data-act="answer-list-open">'+icon('paste')+'</button><button type="button" class="button small icon-button" aria-label="Import CSV" title="Import CSV" data-act="answer-list-import">'+icon('upload')+'</button></div><p class="setup-answer-summary">'+(S.evaluationProvider==='gliner'?'Local GLiNER returns a position from 0 to '+(options.length-1)+', plus relative level scores normalized to total 1. These are not calibrated probabilities.':'Jev Score returns a position from 0 to '+(options.length-1)+', plus probabilities across these levels totaling 1.')+'</p>');
  const questionBody=questionPicker+'<div class="setup-prompt-row">'+area('What do you want to ask?','setupPrompt',setupQuestionText(q),'','3')+'</div>'+setupContextSummary(p,s);
  const cohortBody=setupCohortPicker(p,s);
  const answerBody='<div class="setup-section-heading"><h3>'+ (q.type==='choice'?'Options to compare':'How should they answer?') +'</h3></div>'+answer;
  const toolbar='<div class="setup-step-toolbar">'+picker+'</div>';
  const outputs='<section class="round-outputs"><h3>Later steps can use</h3><p class="subtle">'+esc(phaseOutput(p,s).map(o=>flowOutputLabel(p,s,o)).filter((v,i,a)=>a.indexOf(v)===i).join(' · ')||'This step has no outputs yet.')+'</p></section>';
  const content=focused==='question'?questionBody:focused==='answers'?answerBody+outputs:focused?toolbar+questionBody+'<div class="setup-columns"><section>'+cohortBody+'</section><section>'+answerBody+'</section></div>':setupWizard(p,s,qid,q,pool,toolbar,[questionBody,cohortBody,answerBody]);
  return '<section class="panel setup-panel"><form data-form="study-setup" data-question-id="'+attr(qid)+'">'+content+'</form></section>';
}
function setupWizardKey(p,s,qid){return 'setup-wizard-'+p.id+'-'+s.id+'-'+qid}
function setupHasQuestion(q){return !!setupQuestionText(q).trim()}
function setupWizardReady(q,pool){return [setupHasQuestion(q),!!pool?.personas.length,q.type==='noul'||(q.type==='choice'?Object.keys(q.criteria).length>=2&&Object.entries(q.criteria).every(([key,value])=>String(optionName(key,value)).trim()):q.criteria.length>=2&&q.criteria.every(value=>value.trim()))]}
function setupWizard(p,s,qid,q,pool,toolbar,bodies){
  const steps=[['question','Question'],['cohort','Cohort'],['options',q.type==='choice'?'Options':'Answers'],['review','Review']],key=setupWizardKey(p,s,qid),current=S.sections[key]||'question',index=Math.max(0,steps.findIndex(([step])=>step===current)),ready=setupWizardReady(q,pool);
  const nav='<nav class="setup-progress" aria-label="Question setup progress"><ol>'+steps.map(([step,label],i)=>'<li><button type="button" data-act="setup-wizard" data-step="'+step+'" aria-label="'+label+(i<3&&ready.slice(0,i+1).every(Boolean)?', complete':'')+'" '+(i===index?'aria-current="step"':'')+' data-complete="'+(i<3&&ready.slice(0,i+1).every(Boolean))+'"><span class="setup-progress-number">'+(i<3&&ready.slice(0,i+1).every(Boolean)?icon('check'):i+1)+'</span><span>'+label+'</span></button></li>').join('')+'</ol></nav>';
  const optionCount=q.type==='choice'?Object.keys(q.criteria).length:q.type==='score'?q.criteria.length:0;
  const reviewRow=(label,value,step)=>'<div class="setup-review-row"><div><dt>'+label+'</dt><dd>'+esc(value)+'</dd></div><button type="button" class="button small icon-button" data-act="setup-wizard" data-step="'+step+'" aria-label="Edit '+label.toLowerCase()+'" title="Edit '+label.toLowerCase()+'">'+icon('edit')+'</button></div>';
  const summary='<h3>Review this question</h3><dl class="setup-review">'+reviewRow('Question',setupQuestionText(q)||'Add a question','question')+reviewRow('Cohort',pool?pool.name+' · '+pool.personas.length.toLocaleString('en-US')+' personas':'Choose a cohort','cohort')+reviewRow('Answers',answerName(q.type)+(optionCount?' · '+optionCount+' options':'')+(ready[2]?'':' · Needs option text'),'options')+'</dl>'+setupContextSummary(p,s)+'<p class="subtle">Review the study request before running. No evaluation starts here.</p><button type="button" class="button small" data-act="next-phase">'+icon('plus')+' Add follow-up question</button>';
  const panes=[...bodies,summary].map((body,i)=>'<section class="setup-wizard-pane" data-setup-pane="'+steps[i][0]+'" '+(i===index?'':'hidden')+'>'+body+'</section>').join('');
  const footer='<div class="setup-wizard-actions">'+(index?'<button type="button" class="button" data-act="setup-wizard" data-step="'+steps[index-1][0]+'">'+icon('left')+' Back</button>':'<span></span>')+(index<3?'<button type="button" class="button primary" data-act="setup-wizard" data-step="'+steps[index+1][0]+'" data-forward="true">Next: '+steps[index+1][1]+' '+icon('right')+'</button>':'<button type="button" class="button primary" data-act="review" '+(ready.every(Boolean)?'':'disabled title="Complete the question, cohort and answers first."')+'>Review run</button>')+'</div>';
  const error=S.sections[key+'-error']&&!ready[index]?'<p class="setup-wizard-error" role="alert" tabindex="-1">'+esc(S.sections[key+'-error'])+'</p>':'';
  return toolbar+nav+'<div class="setup-wizard-body">'+panes+error+footer+'</div>';

}
function choiceOptionSetup(p,s,qid,q,types){
  const stateKey='setup-option-'+s.id+'-'+qid,formatKey='setup-format-'+s.id+'-'+qid;
  const selected=S.sections[stateKey],editing=selected!==undefined&&Object.hasOwn(q.criteria,selected);
  const output='<div class="setup-output-format"><span>'+ (S.evaluationProvider==='gliner'?'Normalized option scores':'Probability distribution') +'</span><button type="button" class="button small icon-button" data-act="setup-format" aria-label="Change answer format" title="Change answer format">'+icon('settings')+'</button></div>';
  if(S.sections[formatKey])return '<div class="row"><button type="button" class="button small" data-act="setup-format-back">'+icon('left')+' Back to options</button></div>'+types;
  if(editing){const keys=Object.keys(q.criteria),i=keys.indexOf(selected),value=q.criteria[selected];return '<button type="button" class="button small" data-act="setup-option-back">'+icon('left')+' Back to options</button><div class="setup-option-editor" data-setup-option="'+attr(selected)+'"><label>Option name<input name="setupOption" aria-label="Option '+(i+1)+' name" value="'+attr(optionName(selected,value))+'"></label><label>Description (optional)<textarea name="setupDescription" rows="3" aria-label="Option '+(i+1)+' description">'+esc(optionDescription(value))+'</textarea></label></div>';}
  const options=Object.entries(q.criteria),named=options.filter(([key,value])=>String(optionName(key,value)).trim()),page=pageItems(options,'setup-options-'+s.id+'-'+qid,4);
  const sourceKey='setup-input-'+p.id+'-'+s.id+'-'+qid,source=S.sections[sourceKey]||(named.length?'manual':'file');
  const tabs='<nav class="setup-input-tabs" aria-label="Add options">'+[['file','File'],['agent','Agent'],['manual','Manual']].map(([key,label])=>'<button type="button" data-act="setup-input" data-source="'+key+'" aria-pressed="'+(source===key)+'">'+label+'</button>').join('')+'</nav>';
  const list='<div class="setup-option-list">'+page.items.map(([key,value],offset)=>{const label=String(optionName(key,value)).trim()||'Unnamed option '+(page.start+offset+1);return '<div class="setup-option-record"><button type="button" class="setup-option-edit" data-act="setup-edit-option" data-key="'+attr(key)+'" aria-label="Edit option '+attr(label)+'"><span><strong>'+esc(label)+'</strong>'+(optionDescription(value)?'<small>'+esc(optionDescription(value))+'</small>':'')+'</span>'+icon('edit')+'</button><button type="button" class="button small icon-button" data-act="setup-remove-option" data-key="'+attr(key)+'" aria-label="Remove option '+attr(label)+'" title="Remove option" '+(options.length<=2?'disabled':'')+'>'+icon('trash')+'</button></div>'}).join('')+'</div>'+page.controls;
  const pane=source==='file'?'<button type="button" class="setup-file-drop" data-answer-drop="true" data-act="answer-list-import">'+icon('upload')+'<strong>Drop CSV or JSON</strong><span>or choose file · name + optional description</span></button>':source==='agent'?optionAgentInline(p,s,qid,q):'<div class="row setup-manual-actions"><span>'+named.length+(named.length===1?' option':' options')+'</span><button type="button" class="button small icon-button" data-act="answer-list-open" aria-label="Paste list" title="Paste list">'+icon('paste')+'</button><button type="button" class="button small icon-button" data-act="setup-add-option" aria-label="Add option" title="Add option" '+(options.length>=255?'disabled':'')+'>'+icon('plus')+'</button></div>'+list;
  return output+tabs+'<div class="setup-input-pane">'+pane+'</div><p class="setup-answer-summary">'+(S.evaluationProvider==='gliner'?'Relative scores 0–1, totaling 1; not calibrated probabilities.':'Probabilities 0–1, totaling 1.')+'</p>';

}
function applyStudySetup(form){
  const s=selectedStage(),qid=form.dataset.questionId,q=s?.questions?.[qid];if(!q)return;
  const d=new FormData(form),typed=String(d.get('setupPrompt')??q.label),label=q.label==='What should this phase decide?'&&!typed?q.label:typed;
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
  return tabs+panel(s.kind==='decision'?'Which answer should supply the result?':'Which answers should be combined?',s.kind==='decision'?'Uses the leading option from one earlier answer.':'Choose answers with matching options or ordered levels. New selections get equal weight.','<div class="setup-connections">'+(content||'<p>No compatible earlier answers available.</p>')+'</div>'+page.controls,'<div class="setup-step-toolbar">'+setupQuestionToolbar(p,s)+'</div>');
}
function setupAction(a,el){
  if(!a.startsWith('setup-'))return false;
  const p=pipeline(),s=selectedStage();if(!p)return true;
  if(a==='setup-question-list'){S.sections['question-list-'+p.id]=true;render();root.querySelector('.setup-question-list h2')?.focus();return true}
  if(a==='setup-edit-step'){const target=p.stages.find(x=>x.id===el.dataset.id);if(target){S.stageId=target.id;S.sections.pipeline='flow';S.sections['flow-inspector']=target.kind==='poll'?'question':'connections';S.sections['question-list-'+p.id]=false;render();root.querySelector('.setup-question-location strong')?.focus()}return true}
  if(!s)return true;
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
  if(a==='setup-wizard'){
    const steps=['question','cohort','options','review'],target=el.dataset.step;if(!steps.includes(target))return true;
    const key=setupWizardKey(p,s,entry[0]),current=S.sections[key]||'question',ready=setupWizardReady(q,poolForPhase(p,s));
    if(el.dataset.forward==='true'&&!ready[steps.indexOf(current)]){S.sections[key+'-error']={question:'Write the question before continuing.',cohort:'Choose a cohort with personas before continuing.',options:'Import a list or name every option before continuing.'}[current];render();root.querySelector('.setup-wizard-error')?.focus();return true}
    delete S.sections[key+'-error'];
    S.sections[key]=target;render();root.querySelector('.setup-wizard-pane:not([hidden]) textarea, .setup-wizard-pane:not([hidden]) button')?.focus();return true;
  }
  if(a==='setup-input'){if(['file','agent','manual'].includes(el.dataset.source))S.sections['setup-input-'+p.id+'-'+s.id+'-'+entry[0]]=el.dataset.source;render();return true}
  if(a==='setup-question'){S.sections['setup-question-'+s.id]=el.dataset.id;render();return true}
  if(a==='setup-cohort'){assignSetupCohort(p,s,el.dataset.id);S.flowCohortPick=false;}
  else if(a==='setup-edit-option'){S.sections['setup-input-'+p.id+'-'+s.id+'-'+entry[0]]='manual';S.sections['setup-option-'+s.id+'-'+entry[0]]=el.dataset.key;render();root.querySelector('[name=setupOption]')?.focus();return true}
  else if(a==='setup-option-back'){delete S.sections['setup-option-'+s.id+'-'+entry[0]];render();return true}
  else if(a==='setup-format'||a==='setup-format-back'){S.sections['setup-format-'+s.id+'-'+entry[0]]=a==='setup-format';render();return true}
  else if(a==='setup-type'){
    delete S.sections['setup-format-'+s.id+'-'+entry[0]];delete S.sections['setup-option-'+s.id+'-'+entry[0]];
    const type=el.dataset.type;if(!['choice','noul','score'].includes(type)||q.type===type)return true;
    // Cache formats per question so exploring formats never destroys typed options.
    const key=p.id+':'+s.id+':'+entry[0];setupFormats[key]??={};setupFormats[key][q.type]=clone(q);
    s.questions[entry[0]]=setupFormats[key][type]?{...clone(setupFormats[key][type]),label:q.label}:{type,label:q.label,instructions:'Answer the question using your persona and the supplied context.',...(type==='choice'?{criteria:{option_1:'',option_2:''}}:type==='score'?{criteria:['Does not meet the stated goal','Partly meets the stated goal','Fully meets the stated goal']}: {})};
  }else if(a==='setup-add-option'){
    S.sections['setup-input-'+p.id+'-'+s.id+'-'+entry[0]]='manual';
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
    const missing=!setupHasQuestion(q)||(q.type==='choice'&&Object.entries(q.criteria).some(([key,value])=>!String(optionName(key,value)).trim()))||(q.type==='score'&&q.criteria.some(value=>!value.trim()));
    if(missing){S.sections[setupWizardKey(p,s,qid)]=!setupHasQuestion(q)?'question':'options';if(q.type==='choice')S.sections['setup-input-'+p.id+'-'+s.id+'-'+qid]='manual';S.stageId=s.id;S.sections.pipeline='flow';S.sections['flow-inspector']='question';S.sections['question-list-'+p.id]=false;S.sections['setup-question-'+s.id]=qid;render();throw Error('Add the question and text for every answer option before reviewing.');}
  }
  for(const s of p?.stages||[])if(s.kind==='poll'&&!poolForPhase(p,s)?.personas.length){S.stageId=s.id;S.sections.pipeline='flow';S.sections['flow-inspector']='cohort';S.flowCohortPick=true;render();throw Error('Choose a cohort with synthetic members before reviewing.');}
}
`;

export const STUDY_SETUP_CSS = `
.step-settings-simple{max-width:760px;padding-block:4px 12px}.step-settings-simple>p{margin:0 0 18px}.step-settings-simple>p:last-child{margin:4px 0 0}
.setup-question-location{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;width:100%}.setup-question-location strong{font-size:14px;overflow-wrap:anywhere}.setup-question-location .row{gap:6px;flex:none}.setup-question-location .button{margin:0}.setup-question-list{max-width:840px;margin-inline:auto}.setup-outline-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}.setup-outline-heading h2{font-size:16px;margin:0}.setup-outline-heading .button{flex:none}.setup-question-list>p{font-size:12px;margin:8px 0 16px}.setup-question-row{display:flex;align-items:center;gap:16px;width:100%;text-align:left;background:transparent;border:0;border-top:1px solid var(--line);padding:14px 8px;color:var(--ink);font:inherit;cursor:pointer}.setup-question-row>span{display:grid;gap:4px;flex:1;min-width:0}.setup-question-row strong{font-size:13px}.setup-question-row>span>span{font-size:13px;overflow-wrap:anywhere}.setup-question-row small{font-size:12px;color:var(--muted);flex:none}.setup-question-row>.ui-icon{flex:none;width:16px;height:16px}.setup-question-row:hover{background:var(--hover)}.setup-question-row:focus-visible{outline:2px solid var(--blue);outline-offset:-2px;border-radius:var(--radius-control)}
@media(max-width:480px){.setup-question-row{flex-wrap:wrap;gap:6px;padding-inline:0}.setup-question-row>span{flex-basis:calc(100% - 32px)}.setup-question-row small{order:3;flex-basis:100%}.setup-outline-heading{align-items:start;flex-wrap:wrap}}

.setup-panel:has(.setup-progress){width:100%;max-width:none;margin-inline:0;padding:16px}.setup-panel:has(.setup-progress) .setup-step-toolbar{margin-bottom:12px}.setup-progress{margin:0 0 16px}.setup-progress ol{display:flex;list-style:none;padding:0;margin:0}.setup-progress li{display:flex;align-items:center;flex:1;min-width:0}.setup-progress li:last-child{flex:none}.setup-progress li:not(:last-child)::after{content:"";flex:1;height:2px;margin-inline:12px;background:var(--line)}.setup-progress button{display:flex;align-items:center;gap:8px;flex:none;padding:0;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;cursor:pointer}.setup-progress-number{width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--line);border-radius:50%;background:var(--surface);font-variant-numeric:tabular-nums;font-weight:600}.setup-progress-number .ui-icon{width:16px;height:16px}.setup-progress [data-complete=true] .setup-progress-number{background:var(--blue-soft);color:var(--blue);border-color:var(--blue)}.setup-progress [aria-current=step]{color:var(--ink);font-weight:600}.setup-progress [aria-current=step] .setup-progress-number{background:var(--blue-soft);color:var(--blue);border:2px solid var(--blue)}.setup-progress button:focus-visible{outline:2px solid var(--blue);outline-offset:4px;border-radius:4px}.setup-wizard-body{min-width:0}.setup-wizard-pane[hidden]{display:none}.setup-wizard-pane>.setup-prompt-row{margin:0}.setup-wizard-pane h3{margin:0 0 16px;font-size:16px}.setup-wizard-error{font-size:12px;color:var(--ink);margin:16px 0 0}.setup-wizard-actions{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}.setup-wizard-actions>.button{flex:none}.setup-review{margin:0}.setup-review-row{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 0;border-bottom:1px solid var(--line)}.setup-review-row>div{min-width:0}.setup-review dt{font-size:12px;color:var(--muted);margin-bottom:4px}.setup-review dd{margin:0;font-size:13px;overflow-wrap:anywhere}.setup-review-row>.button{flex:none}.setup-review+.setup-context{margin-top:16px}

.setup-file-drop{width:100%;display:grid;justify-items:center;gap:6px;padding:20px 12px;border:1px dashed var(--control-line);border-radius:8px;background:var(--surface);color:var(--ink);font:inherit;text-align:center;cursor:pointer}.setup-file-drop span{font-size:12px;color:var(--muted)}.setup-file-drop:hover{border-color:var(--blue);background:var(--blue-soft)}

.setup-input-tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:12px}.setup-input-tabs button{font:inherit;font-size:12px;font-weight:600;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);padding:8px 12px;cursor:pointer}.setup-input-tabs button[aria-pressed=true]{border-bottom-color:var(--blue);color:var(--ink)}.setup-input-tabs button:hover{background:var(--hover)}.setup-input-tabs button:focus-visible{outline:2px solid var(--blue);outline-offset:-2px}.setup-manual-actions{gap:6px}.setup-manual-actions>span{flex:1;font-size:12px;color:var(--muted)}.setup-agent-entry{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.setup-agent-entry p{font-size:12px;margin:0;color:var(--muted)}.setup-input-pane{min-width:0}.setup-file-drop>.ui-icon{width:18px;height:18px;color:var(--muted)}
.setup-output-format{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px;font-size:12px;color:var(--muted)}.setup-option-list{margin-top:12px}.setup-option-record{display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line);padding:8px 0}.setup-option-edit{display:flex;align-items:center;gap:12px;flex:1;min-width:0;border:0;background:transparent;color:var(--ink);font:inherit;text-align:left;padding:4px 0;cursor:pointer}.setup-option-edit>span{flex:1;min-width:0}.setup-option-edit strong{display:block;font-size:13px;overflow-wrap:anywhere}.setup-option-edit small{display:block;color:var(--muted);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}.setup-option-edit .ui-icon{width:14px;height:14px;flex:none;color:var(--muted)}.setup-option-record>.button{flex:none}.setup-option-editor{display:grid;gap:14px;margin-top:16px}.setup-option-editor label{display:grid;gap:6px;font-size:12px;font-weight:600}.setup-options-empty{font-size:12px;color:var(--muted);margin:16px 0}

.phase-picker:has(.step-settings-button){display:grid;grid-template-columns:minmax(0,1fr) var(--control-height);gap:8px;align-items:end;width:100%}.step-settings-button{margin:0;align-self:end}.button.icon-button.step-settings-button{width:var(--control-height);height:var(--control-height)}.study-step-settings{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:12px 0}.study-step-settings strong{font-size:12px;overflow-wrap:anywhere}.setup-step-toolbar{display:flex;align-items:center;gap:12px;margin-bottom:20px}.setup-step-toolbar>.button{margin-left:auto;flex:none}.setup-prompt-row{margin-bottom:20px}.setup-prompt-row .field{margin-bottom:0}.setup-prompt-row .phase-picker{margin-top:0}.phase-picker .field{gap:6px}.setup-columns{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}.setup-section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:var(--button-height);margin-bottom:12px}.setup-columns .setup-section-heading h3{margin:0}.setup-columns h3{margin:0 0 12px;font-size:14px}.setup-columns>section{min-width:0}.setup-cohorts,.setup-connections{display:grid;gap:8px}.setup-choice{appearance:none;width:100%;min-height:48px;text-align:left;font:inherit;color:var(--ink);background:var(--raised);border:1px solid var(--line);padding:10px 12px;cursor:pointer;border-radius:var(--radius-control)}.setup-cohort-row{display:flex;align-items:center;gap:8px;min-width:0;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--raised)}.setup-cohort-row[data-selected=true]{background:var(--selection);border-color:var(--blue);box-shadow:inset 3px 0 var(--blue)}.setup-cohort-row>.setup-choice{flex:1;min-width:0;border:0;background:transparent;box-shadow:none}.setup-cohort-row>.setup-choice:hover{background:var(--hover)}.setup-cohort-row[data-selected=true]>.setup-choice:hover{background:var(--selection)}.setup-cohort-row>.cohort-details{margin-right:8px;gap:4px;flex-shrink:0;padding-inline:8px;background:transparent;border-color:transparent}.setup-cohort-row>.cohort-details:hover{background:var(--hover);border-color:var(--line)}.cohort-details .ui-icon{width:14px;height:14px}.setup-choice strong,.setup-choice span span{display:block}.setup-choice strong{font-size:13px;overflow-wrap:anywhere}.setup-choice span{font-size:12px;color:var(--muted)}.setup-choice[aria-pressed=true]{background:var(--selection);border-color:var(--blue);box-shadow:inset 3px 0 var(--blue)}.setup-choice:hover{background:var(--hover);border-color:var(--control-line)}.setup-choice[aria-pressed=true]:hover{background:var(--selection)}.setup-choice:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.setup-types [aria-pressed=true]{background:var(--selection);color:var(--ink);border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}.setup-options{display:grid;gap:10px;margin:10px 0}.setup-option{display:grid;grid-template-columns:minmax(0,1fr) var(--control-height);align-items:start;gap:8px}.setup-option .button.icon-button{width:var(--control-height);height:var(--control-height);min-width:var(--control-height);align-self:start}.setup-option-fields{display:grid;gap:8px;min-width:0}.setup-option-fields [name=setupOption]{font-weight:600}[data-form=study-setup] .setup-option-fields [name=setupDescription]{font-size:12px;min-height:48px;height:54px;line-height:1.4}.setup-answer-summary{border-top:1px solid var(--line);padding-top:10px;margin-top:12px!important;font-size:12px;color:var(--muted)}.setup-context{margin:0 0 18px;overflow-wrap:anywhere}.setup-connections .setup-choice{display:flex;gap:12px;align-items:center}[data-form=study-setup]> .field{margin-bottom:20px}[data-form=study-setup] textarea{min-height:70px}
@media(max-width:650px){.setup-panel:has(.setup-progress){padding:12px}.setup-progress ol{display:grid;grid-template-columns:repeat(4,minmax(0,1fr))}.setup-progress li{position:relative;display:block}.setup-progress li:not(:last-child)::after{position:absolute;top:15px;left:calc(50% + 20px);right:calc(-50% + 20px);margin:0}.setup-progress button{position:relative;z-index:1;display:grid;justify-items:center;gap:4px;width:100%;font-size:11px}.setup-step-toolbar{flex-wrap:wrap;gap:8px}.setup-step-toolbar>.phase-picker{max-width:none;flex:1;min-width:200px}.setup-step-toolbar>.button{margin-left:0}.setup-prompt-row textarea{min-height:70px}.setup-columns{grid-template-columns:minmax(0,1fr);gap:18px}.setup-types{gap:6px}}
.setup-cohort-empty{display:grid;justify-items:start;gap:14px;padding:12px 0 20px;max-width:60ch}.setup-cohort-empty h3{margin:0;font-size:18px}.setup-cohort-empty p{margin:0;max-width:54ch;color:var(--muted)}.setup-cohort-empty>.button{margin-top:2px}
`;
