/** Compact, keyboard-accessible study graph. Editing never starts inference. */
export const WORKSPACE_FLOW_CLIENT = String.raw`
function flowOutputLabel(p,s,q){
  if(s.kind==='decision')return 'Leading option';
  return {choice:S.evaluationProvider==='gliner'?'Relative score distribution':'Probability distribution',score:'Scale distribution',noul:S.evaluationProvider==='gliner'?'Yes / no score':'Yes / no probability'}[q.type]||'Answer summary';
}
function flowCanConnect(p,sourceId,questionId,target){
  if(!target||!dataInputOptions(p,target).some(x=>x.id===sourceId))return false;
  const source=p.stages.find(x=>x.id===sourceId),q=source&&phaseOutput(p,source).find(x=>x.id===questionId);
  if(!q)return false;
  if(target.kind==='decision')return q.type==='choice';
  if(target.kind==='aggregate'){
    const base=target.inputs[0]&&resolvedQuestion(p,target.inputs[0].stage,target.inputs[0].question);
    if(base&&setupAnswerSignature(base)!==setupAnswerSignature(q))return false;
  }
  return true;
}
function flowAlreadyConnected(p,s,sourceId,questionId){return flowInputs(p,s).some(([,input])=>input.stage===sourceId&&input.question===questionId)}
function flowInputs(p,s){
  if(s.kind==='decision')return s.from?.stage?[['result',s.from]]:[];
  if(s.kind==='aggregate')return s.inputs.map((input,i)=>[String(i),input]);
  if(s.inputs!==undefined)return Object.entries(s.inputs);
  return s.dependsOn.flatMap(sourceId=>{const source=p.stages.find(x=>x.id===sourceId);return source?phaseOutput(p,source).map(q=>['legacy_'+sourceId+'_'+q.id,{stage:sourceId,question:q.id,select:'summary'}]):[]});
}
function flowMaterializeInputs(p,s){if(s.kind==='poll'&&s.inputs===undefined)s.inputs=Object.fromEntries(flowInputs(p,s))}
function flowConnect(p,sourceId,questionId,targetId){
  const source=p.stages.find(x=>x.id===sourceId),target=p.stages.find(x=>x.id===targetId);
  if(!source||!target||!dataInputOptions(p,target).some(x=>x.id===sourceId))throw Error('That connection would create a loop. Choose a different question.');
  const q=resolvedQuestion(p,sourceId,questionId);
  if(!q||!phaseOutput(p,source).some(x=>x.id===questionId))throw Error('Choose an available output.');
  const before=flowInputs(p,target).map(([,input])=>input.stage);
  if(target.kind==='poll'){
    flowMaterializeInputs(p,target);
    if(!Object.values(target.inputs).some(input=>input.stage===sourceId&&input.question===questionId)){
      let key='answer_'+(p.stages.indexOf(source)+1),n=2;while(Object.hasOwn(target.inputs,key))key='answer_'+(p.stages.indexOf(source)+1)+'_'+n++;
      target.inputs[key]={stage:sourceId,question:questionId,select:'summary'};
    }
  }else if(target.kind==='aggregate'){
    const base=target.inputs[0]&&resolvedQuestion(p,target.inputs[0].stage,target.inputs[0].question);
    if(base&&setupAnswerSignature(base)!==setupAnswerSignature(q))throw Error('Combine answers with matching options or ordered levels.');
    if(!target.inputs.some(input=>input.stage===sourceId&&input.question===questionId))target.inputs.push({stage:sourceId,question:questionId,weight:1});
  }else{
    if(q.type!=='choice')throw Error('A final result needs an option comparison.');
    target.from={stage:sourceId,question:questionId};
  }
  reconcileSetupDependencies(target,before,flowInputs(p,target).map(([,input])=>input.stage));
}
function flowDisconnect(p,s,key){
  const before=flowInputs(p,s).map(([,input])=>input.stage);
  if(s.kind==='poll'){flowMaterializeInputs(p,s);delete s.inputs[key]}
  else if(s.kind==='aggregate')s.inputs.splice(Number(key),1);
  else s.from={stage:'',question:''};
  reconcileSetupDependencies(s,before,flowInputs(p,s).map(([,input])=>input.stage));
}
/** Distinct people a step can draw: personas in positive-weight segments (repeats never add people). */
function flowAvailablePeople(p,s){const c=poolForPhase(p,s);if(!c)return 0;const live=new Set((c.segments||[]).filter(x=>x.weight>0).map(x=>x.id));return c.personas.filter(x=>live.has(x.segment)).length}
/** The step's sample size when it asks for more distinct people than its cohort holds, else null. */
function flowSampleShort(p,s){if(s.kind!=='poll'||s.size===undefined||s.size===null||s.size==='')return null;const have=flowAvailablePeople(p,s),asks=Number(s.size);return have>0&&asks>have?{asks,have}:null}
function flowSampleNotice(p,s){
  const short=flowSampleShort(p,s);if(!short)return '';
  return '<div class="warning flow-sample-notice" role="alert"><p>Asks '+short.asks.toLocaleString('en-US')+' people but this cohort has '+short.have.toLocaleString('en-US')+'. Lower the sample size to '+short.have.toLocaleString('en-US')+' or add personas.</p><div class="row"><button type="button" class="button small primary" data-act="flow-sample-all" data-id="'+attr(s.id)+'">Use all '+short.have.toLocaleString('en-US')+'</button><button type="button" class="button small" data-act="phase-pool" data-id="'+attr(poolForPhase(p,s).id)+'">Add personas</button></div></div>';
}
function flowReadiness(p,s){
  if(s.kind==='poll'){
    if(!Object.values(s.questions||{}).length||Object.values(s.questions).some(q=>!q.label.trim()||q.label==='What should this phase decide?'))return 'Needs question';
    if(!poolForPhase(p,s)?.personas.length)return 'Needs cohort';
    if(Object.values(s.questions).some(q=>q.type==='choice'?Object.keys(q.criteria).length<2||Object.entries(q.criteria).some(([key,value])=>!String(optionName(key,value)).trim()):q.type==='score'?q.criteria.length<2||q.criteria.some(value=>!value.trim()):false))return 'Needs options';
    if(flowSampleShort(p,s))return 'Needs more personas';
  }else if(!flowInputs(p,s).length)return 'Needs input';
  if(flowInputs(p,s).some(([,input])=>!resolvedQuestion(p,input.stage,input.question)))return 'Needs input';
  if(s.kind==='aggregate'&&new Set(s.inputs.map(input=>setupAnswerSignature(resolvedQuestion(p,input.stage,input.question)))).size>1)return 'Options differ';
  if(s.kind==='decision'&&resolvedQuestion(p,s.from.stage,s.from.question)?.type!=='choice')return 'Needs option scores';
  return s.when?'Conditional':'Ready';
}
function flowDepths(p){
  const depths=new Map();
  function depth(s,seen=new Set()){if(depths.has(s.id))return depths.get(s.id);if(seen.has(s.id))return 0;const next=new Set([...seen,s.id]);const value=s.dependsOn.reduce((n,id)=>{const parent=p.stages.find(x=>x.id===id);return parent?Math.max(n,1+depth(parent,next)):n},0);depths.set(s.id,value);return value}
  p.stages.forEach(s=>depth(s));return depths;
}
function flowPlural(n,word){return Number(n).toLocaleString('en-US')+' '+word+(Number(n)===1?'':'s')}
function flowNodeTitle(p,s){
  const question=Object.values(s.questions||{})[0]?.label?.trim(),custom=s.label?.trim();
  if(s.kind!=='poll')return {title:custom||(s.kind==='aggregate'?'Combine answers':'Final result'),sub:s.kind==='aggregate'?'Weights the connected answers together':'Picks the leading option'};
  const asked=question&&question!=='What should this phase decide?'?question:'',more=Object.keys(s.questions||{}).length-1,named=custom&&!['First question','Next question','New question'].includes(custom)&&custom!==asked;
  return named?{title:custom,sub:asked?asked+(more>0?' (+'+more+' more)':''):'Add the question'}:{title:asked||'Untitled question',sub:more>0?'+'+more+' more '+(more===1?'question':'questions'):''};
}
function flowOutputUsed(p,s,q){return p.stages.some(x=>x.id!==s.id&&flowInputs(p,x).some(([,input])=>input.stage===s.id&&(!input.question||input.question===q.id)))}
function flowNode(p,s){
  const pool=poolForPhase(p,s),outputs=phaseOutput(p,s),status=flowReadiness(p,s),pending=S.flowSource?.pipelineId===p.id?S.flowSource:null;
  const targetable=pending&&flowCanConnect(p,pending.stage,pending.question,s)&&!flowAlreadyConnected(p,s,pending.stage,pending.question);
  const {title,sub}=flowNodeTitle(p,s),kind=s.kind==='poll'?'Ask cohort':s.kind==='aggregate'?'Combine':'Final result',inputs=flowInputs(p,s);
  const sources=[...new Set(inputs.map(([,input])=>input.stage))].map(id=>p.stages.findIndex(x=>x.id===id)+1).filter(n=>n>0).sort((a,b)=>a-b);
  const downstream=p.stages.some(x=>x.dependsOn.includes(s.id)),short=s.kind==='poll'&&flowSampleShort(p,s);
  const who=s.kind!=='poll'?'':pool?.personas.length?'<button class="flow-who" data-act="flow-cohort-map" data-id="'+attr(s.id)+'" aria-label="Explore '+attr(pool.name)+' ('+flowPlural(pool.personas.length,'member')+')" title="Explore the cohort"><span class="flow-host-dots" aria-hidden="true">'+pool.personas.slice(0,8).map(()=>'<i></i>').join('')+'</span><span class="flow-who-text"><strong>'+esc(pool.name)+'</strong><span>'+(short?'<span class="flow-sample-short">'+short.asks.toLocaleString('en-US')+' of '+flowPlural(short.have,'persona')+'</span>':flowPlural(s.size??pool.personas.length,'persona'))+'</span></span></button>':'';
  return '<article class="flow-node" data-flow-node="'+attr(s.id)+'" data-stage-index="'+p.stages.indexOf(s)+'" data-selected="'+(S.stageId===s.id)+'" data-targetable="'+!!targetable+'" aria-label="'+attr(stepTitle(p,s))+'">'+
    '<div class="flow-node-header"><span class="flow-number">'+(p.stages.indexOf(s)+1)+'</span><span class="flow-kind">'+kind+'</span><span class="flow-status" data-ready="'+(status==='Ready')+'">'+esc(status)+'</span></div>'+
    (inputs.length?'<div class="flow-node-inputs"><button data-act="flow-inputs" data-id="'+attr(s.id)+'" data-flow-source="'+attr(inputs[0][1].stage)+'" data-flow-question="'+attr(inputs[0][1].question||'')+'" aria-label="Inputs: results from '+(sources.length===1?'step ':'steps ')+sources.join(', ')+'">'+icon('right')+'<span>Uses '+(sources.length===1?'step ':'steps ')+sources.join(', ')+'</span></button></div>':'')+
    '<button class="flow-select" data-act="flow-select" data-id="'+attr(s.id)+'" aria-pressed="'+(S.stageId===s.id)+'" aria-label="'+(targetable?'Connect to ':'Edit ')+attr(stepTitle(p,s))+'"><strong>'+esc(title)+'</strong>'+(sub?'<span>'+esc(sub)+'</span>':'')+'</button>'+
    who+
    (targetable?'<button class="flow-destination" data-act="flow-connect" data-id="'+attr(s.id)+'" aria-label="Connect here: '+attr(stepTitle(p,s))+'">'+icon('plus')+' Connect here</button>':'')+
    '<div class="flow-node-outputs">'+outputs.map(q=>{const used=flowOutputUsed(p,s,q)||(s.kind==='decision'&&!downstream),label=(outputs.length>1?(q.label||q.id)+' · ':'')+flowOutputLabel(p,s,q);return '<button class="flow-output" data-act="flow-output" data-id="'+attr(s.id)+'" data-question="'+attr(q.id)+'" data-used="'+used+'" aria-pressed="'+(pending?.stage===s.id&&pending?.question===q.id)+'" aria-label="Connect '+attr(flowOutputLabel(p,s,q))+' from '+attr(stepTitle(p,s))+'" title="'+(s.kind==='decision'&&!downstream?'The study\'s final answer. Click to pass it to another step.':used?'Sent to a later step. Click to send it to another step too.':'Click, then choose the step that should use it')+'"><span class="flow-output-text">'+(used?'':'<strong>Connect output '+icon('right')+'</strong>')+'<span>'+esc(label)+'</span></span><span class="flow-socket" aria-hidden="true"></span></button>'}).join('')+'</div>'+
    (downstream||s.kind==='decision'?'':'<button class="flow-next" data-act="flow-add-menu" data-id="'+attr(s.id)+'" aria-label="Add after '+attr(stepTitle(p,s))+'">'+icon('plus')+'<span>Add next step</span></button>')+'</article>';
}
function flowNewStage(p,kind,source){
  return kind==='aggregate'?{id:id(),kind:'aggregate',label:'Combined answers',inputs:[],outputQuestion:'combined',dependsOn:[]}:kind==='decision'?{id:id(),kind:'decision',label:'Final result',from:{stage:'',question:''},outputQuestion:'decision',dependsOn:[]}:{id:id(),kind:'poll',label:'New question',cohort:source?.kind==='poll'?source.cohort:Object.keys(p.cohorts)[0]||'',questions:{answer:{type:'choice',label:'',instructions:'Answer the question using your persona and the supplied context.',criteria:{option_a:'',option_b:''}}},inputs:{},dependsOn:[],repeats:1};
}
/** The empty canvas is itself the way in: a question target, a describe-in-words target, and a click anywhere adds the first question. */
function flowEmptyCanvas(){
  return '<div class="flow-empty" data-act="flow-add" data-kind="independent"><div class="flow-empty-targets">'+
    '<button type="button" class="flow-empty-target" data-primary="true" data-act="flow-add" data-kind="independent"><span class="flow-empty-icon" aria-hidden="true">'+icon('plus')+'</span><strong>Add your first question</strong><span>Choose how people answer, then write the question.</span></button>'+
    '<button type="button" class="flow-empty-target" data-act="draft-panel-open"><span class="flow-empty-icon" aria-hidden="true">'+icon('edit')+'</span><strong>Describe the study in words</strong><span>Tell the assistant what you want to learn, then review its draft.</span></button>'+
    '</div><p class="flow-empty-hint">Click anywhere on the canvas to add a question.</p></div>';
}
function flowCanvas(p){
  if(!p.stages.length)return flowEmptyCanvas();
  const depths=flowDepths(p),levels=[...new Set(depths.values())].sort((a,b)=>a-b);
  return '<div class="flow-viewport" tabindex="0" role="region" aria-label="Study flow canvas. Drag steps to arrange them; click empty canvas or press Enter to add a step." aria-keyshortcuts="Enter"><div class="flow-space"><div class="flow-map">'+levels.map(level=>'<div class="flow-column">'+p.stages.filter(s=>depths.get(s.id)===level).map(s=>flowNode(p,s)).join('')+'</div>').join('')+'</div>'+flowCreateMenu(p)+'</div></div>';
}
/** "Split into batches" control for an input that passes individual responses. */
function flowBatchControl(s,key,input){
  const mode=input.batch===undefined?'off':input.batch==='auto'?'auto':'size',size=mode==='size'?input.batch.size:100,btn=(m,label)=>'<button type="button" class="button small'+(mode===m?' primary':'')+'" data-act="flow-batch" data-id="'+attr(s.id)+'" data-key="'+attr(key)+'" data-mode="'+m+'" aria-pressed="'+(mode===m)+'">'+label+'</button>';
  return '<div class="flow-batch-control" data-flow-batch="'+attr(key)+'"><strong>Split into batches</strong><div class="row">'+btn('off','Send all')+btn('auto','Auto')+btn('size','Batch size')+'</div>'+(mode==='size'?'<div class="row"><label for="flowBatch-'+attr(key)+'">Responses per batch</label><input id="flowBatch-'+attr(key)+'" type="number" min="1" step="1" value="'+attr(size)+'" data-flow-batch-size="'+attr(key)+'"><button type="button" class="button small" data-act="flow-batch" data-id="'+attr(s.id)+'" data-key="'+attr(key)+'" data-mode="size-set">Set size</button></div>':'')+'<p class="subtle">'+(mode==='off'?'Every individual response goes into one request. With many responses that is over Jev’s limit.':'Each persona reads one batch at a time, then combines its own verdicts into one answer. '+(mode==='auto'?'Auto uses the largest batch that fits.':'Smaller batches mean more requests.'))+'</p></div>'
}
function flowConnections(p,s){
  const inputs=flowInputs(p,s),available=dataInputOptions(p,s).flatMap(source=>phaseOutput(p,source).filter(q=>flowCanConnect(p,source.id,q.id,s)&&!flowAlreadyConnected(p,s,source.id,q.id)).map(q=>({source,q})));
  return '<section class="flow-connections"><h3>Connected results</h3>'+(inputs.length?inputs.map(([key,input])=>{const source=p.stages.find(x=>x.id===input.stage),q=source&&phaseOutput(p,source).find(x=>x.id===input.question),projection={summary:'Answer summary',probabilities:q?flowOutputLabel(p,source,q):'Distribution',responses:'Individual answers',winner:'Leading option',mean:'Mean score'}[input.select||'summary'];return '<div class="flow-connection-row"><div><strong>'+esc(inputTitle(p,input))+'</strong><span>'+esc(s.kind==='poll'?projection:q?flowOutputLabel(p,source,q):'Missing output')+'</span></div><button class="button small icon-button" data-act="flow-disconnect" data-id="'+attr(s.id)+'" data-key="'+attr(key)+'" title="Disconnect result" aria-label="Disconnect '+attr(inputTitle(p,input))+'">'+icon('trash')+'</button></div>'+(s.kind==='poll'&&input.select==='responses'?flowBatchControl(s,key,input):'')}).join(''):'<p class="subtle">No results connected. Choose an output below.</p>')+
    '<div class="flow-input-picker"><h3>Connect an output</h3>'+(available.length?available.map(({source,q})=>'<button class="flow-input-choice" data-act="flow-connect-input" data-id="'+attr(s.id)+'" data-source="'+attr(source.id)+'" data-question="'+attr(q.id)+'" aria-label="Connect '+attr(inputTitle(p,{stage:source.id,question:q.id}))+' to '+attr(stepTitle(p,s))+'"><span><strong>'+esc(inputTitle(p,{stage:source.id,question:q.id}))+'</strong><small>'+esc(flowOutputLabel(p,source,q))+'</small></span>'+icon('plus')+'</button>').join(''):'<p class="subtle">No other compatible outputs available. Add a question, or select another step.</p>')+'</div>'+(s.when?'<p class="subtle">Conditional dependencies also apply. Edit them in step settings.</p>':'')+'</section>';
}
function flowCohortMap(p,s){
  const c=poolForPhase(p,s);if(inlineCohortTarget(p,s))return setupCohortPicker(p,s);
  if(!c||S.flowCohortPick)return (c?'<button class="button small" data-act="flow-cohort-change">Back to member map</button>':'')+setupCohortPicker(p,s);
  const key='flow:'+p.id+':'+s.id+':'+c.id,person=hostMapMember(c,key),index=person?c.personas.findIndex(item=>item.id===person.id):-1;
  if(person)return '<section class="flow-member-focus"><div class="flow-member-navigation"><button class="button small" data-act="host-member-close" data-map="'+attr(key)+'">'+icon('left')+' Cohort map</button><div class="row"><button class="button small icon-button" data-act="host-member" data-map="'+attr(key)+'" data-id="'+attr(c.personas[index-1]?.id||'')+'" '+(index===0?'disabled':'')+' aria-label="Previous member">'+icon('left')+'</button><span>'+(index+1)+' / '+c.personas.length+'</span><button class="button small icon-button" data-act="host-member" data-map="'+attr(key)+'" data-id="'+attr(c.personas[index+1]?.id||'')+'" '+(index===c.personas.length-1?'disabled':'')+' aria-label="Next member">'+icon('right')+'</button></div></div>'+hostMapDetails(c,person)+'</section>';
  return '<div class="flow-cohort-summary"><strong>'+esc(c.name)+'</strong><div class="row"><button class="button small" data-act="phase-pool" data-id="'+attr(c.id)+'">Open full cohort</button><button class="button small" data-act="flow-cohort-change">Change cohort</button></div></div><section class="flow-cohort-map"><h3>Cohort host map</h3>'+hostMap(c,{key,limit:24})+'<p class="subtle">Hover for a quick look. Select a member to inspect their synthetic profile.</p></section>';
}
/** Steps that still block a run review, in canvas order, with the panel tab that fixes each. */
function flowTodo(p){
  const todo=[];
  for(const s of p.stages){
    if(s.kind==='poll'){const pool=poolForPhase(p,s),questions=Object.values(s.questions||{});if(!questions.length){todo.push({stageId:s.id,tab:'question'});continue}
      const ready=questions.map(q=>setupWizardReady(q,pool)),tab=ready.some(r=>!r[0])?'question':ready.some(r=>!r[2])?'answers':ready.some(r=>!r[1])?'cohort':flowSampleShort(p,s)?'cohort':null;if(tab)todo.push({stageId:s.id,tab,pick:tab==='cohort'&&!flowSampleShort(p,s)})}
    else if(s.kind==='aggregate'&&!s.inputs?.length)todo.push({stageId:s.id,tab:'connections'});
    else if(s.kind==='decision'&&!p.stages.some(x=>x.id===s.from?.stage))todo.push({stageId:s.id,tab:'question'});
  }
  return todo;
}
/** The guided stops of an Ask cohort step, in order: what to ask, its options (Yes/no has none), who answers. Inputs sits outside the sequence. */
const FLOW_STOP_LABEL={question:'What to ask',answers:'Options',cohort:'Who answers',connections:'Inputs'};
function flowGuidedStops(s){
  if(s.kind!=='poll')return [];
  const q=Object.values(s.questions||{})[0];
  return q?.type==='noul'?['question','cohort']:['question','answers','cohort'];
}
function flowStopDone(p,s,key){
  const q=Object.values(s.questions||{})[0],ready=q?setupWizardReady(q,poolForPhase(p,s)):[false,false,false];
  return key==='question'?ready[0]:key==='answers'?ready[2]:key==='cohort'?ready[1]&&!flowSampleShort(p,s):false;
}
function flowRoundTabs(p,s){
  if(s.kind!=='poll')return [['question','Result',false],['connections','Inputs',false]];
  const tabs=flowGuidedStops(s).map(key=>[key,FLOW_STOP_LABEL[key],!flowStopDone(p,s,key),flowStopDone(p,s,key)]);
  if(p.stages.length>1||flowInputs(p,s).length)tabs.push(['connections','Inputs',false,false]);
  return tabs;
}
function flowGuidedFooter(p,s,tab){
  const stops=flowGuidedStops(s),i=stops.indexOf(tab);if(i<0)return '';
  const next=stops[i+1],prev=stops[i-1];
  return '<div class="guided-footer">'+(prev?'<button type="button" class="button" data-act="flow-inspector" data-section="'+prev+'">'+icon('left')+' Back</button>':'<span></span>')+
    '<button type="button" class="button primary" data-act="flow-next">'+(next?'Next: '+FLOW_STOP_LABEL[next]+' '+icon('right'):'Done')+'</button></div>';
}
function flowInspector(p,s){
  if(!s||S.flowPanel===false)return '';
  const tabs=flowRoundTabs(p,s),requested=S.sections['flow-inspector']==='answer'?'answers':S.sections['flow-inspector']||'question',tab=tabs.some(([key])=>key===requested)?requested:'question';
  const kind=s.kind==='poll'?'Ask cohort · '+answerName(Object.values(s.questions||{})[0]?.type):s.kind==='aggregate'?'Combine answers':'Final result';
  const body=tab==='connections'?flowConnections(p,s):tab==='cohort'?flowSampleNotice(p,s)+flowCohortMap(p,s):s.kind==='poll'?stageForm(p,s,tab):stageForm(p,s,true);
  const error=S.sections['flow-inspector-error']?'<p class="setup-wizard-error" role="alert" tabindex="-1">'+esc(S.sections['flow-inspector-error'])+'</p>':'';
  const footer=inlineCohortTarget(p,s)&&tab==='cohort'?'':flowGuidedFooter(p,s,tab);
  return '<aside class="flow-inspector round-panel" aria-label="Selected step editor" data-inspector-tab="'+attr(tab)+'"><div class="flow-inspector-head"><div class="round-panel-title"><h2 tabindex="-1">'+esc(stepTitle(p,s))+'</h2><span class="round-panel-kind">'+esc(kind)+'</span></div><div class="row"><button class="button small icon-button" data-act="flow-settings" aria-label="Step settings" title="Step settings">'+icon('settings')+'</button><button class="button small icon-button" data-act="flow-panel-close" aria-label="Close step panel" title="Close (Esc)">'+icon('close')+'</button></div></div><nav class="round-tabs" role="tablist" aria-label="Selected step sections">'+tabs.map(([key,label,todo,done])=>'<button type="button" role="tab" class="round-tab" data-act="flow-inspector" data-section="'+key+'" aria-selected="'+(tab===key)+'"'+(todo?' data-todo="true"':'')+(done?' data-done="true"':'')+'>'+label+(todo?'<span class="round-tab-dot" aria-label="needs attention"></span>':done?'<span class="round-tab-check" aria-label="done">'+icon('check')+'</span>':'')+'</button>').join('')+'</nav><div class="flow-inspector-body" role="tabpanel">'+body+error+'</div>'+footer+'</aside>';
}
function flowWorkspace(p,s){
  const pending=S.flowSource?.pipelineId===p.id?S.flowSource:null,add=p.stages.find(x=>x.id===S.flowAdd),first=add&&phaseOutput(p,add)[0];
  return '<div class="flow-workspace"><section class="flow-board" aria-label="Study flow"><div class="flow-toolbar"><h2>Study flow <span>'+flowPlural(p.stages.length,'step')+'</span></h2><div class="row"><button class="button small primary" data-act="flow-create-open" aria-haspopup="dialog">'+icon('plus')+' Add step</button><button class="button small icon-button" data-act="flow-fit" aria-label="Fit flow to view" title="Fit flow to view">'+icon('fit')+'</button><button class="button small" data-act="flow-reset" aria-label="Actual size" title="Actual size">100%</button></div></div>'+
    (add?'<div class="flow-action-bar" aria-label="Add after selected step"><span>After '+esc(stepTitle(p,add))+'</span><div class="row"><button class="button small" data-act="flow-add" data-id="'+attr(add.id)+'" data-kind="poll">Follow-up / branch</button><button class="button small" data-act="flow-add" data-id="'+attr(add.id)+'" data-kind="aggregate">Combine answers</button><button class="button small" data-act="flow-add" data-id="'+attr(add.id)+'" data-kind="decision" '+(first?.type!=='choice'?'disabled':'')+'>Final result</button><button class="button small icon-button" data-act="flow-add-close" aria-label="Close add step actions">'+icon('close')+'</button></div></div>':'')+
    (pending?'<div class="flow-hint" role="status">'+'<span><strong>Choose where it goes</strong><br>'+esc(inputTitle(p,{stage:pending.stage,question:pending.question}))+' → Click <strong>Connect here</strong> on a highlighted step.</span><button class="button small" data-act="flow-cancel">Cancel connection</button>'+'</div>':'')+flowCanvas(p)+'</section>'+flowInspector(p,s)+'</div>';
}
function flowAction(a,el){
  if(!a.startsWith('flow-'))return false;
  const p=pipeline();if(!p)return true;
  if(a==='flow-batch'){const target=p.stages.find(x=>x.id===el.dataset.id),input=target?.inputs?.[el.dataset.key];if(!input)return true;const mode=el.dataset.mode;if(mode==='off')delete input.batch;else if(mode==='auto')input.batch='auto';else{const typed=Number(root.querySelector('[data-flow-batch-size="'+el.dataset.key+'"]')?.value);input.batch={size:mode==='size-set'&&Number.isInteger(typed)&&typed>=1?typed:input.batch&&input.batch!=='auto'?input.batch.size:100}}S.dirty=true;S.plan=null;render();return true}
  if(a==='flow-sample-all'){const target=p.stages.find(x=>x.id===el.dataset.id),have=target?flowAvailablePeople(p,target):0;if(target&&have>0){target.size=have;S.dirty=true;S.plan=null;render();say('Sample size lowered to '+have+'.')}return true}
  if(a==='flow-cohort-change'){S.flowCohortPick=!S.flowCohortPick;render();return true}
  if(a==='flow-cohort-map'){S.flowCohortPick=false;S.stageId=el.dataset.id;S.flowPanel=true;S.sections['flow-inspector']='cohort';render();root.querySelector('.flow-inspector h2')?.focus();return true}
  if(a==='flow-fit'||a==='flow-reset'){S.flowScale=a==='flow-reset'?1:'fit';drawFlowEdges();return true}
  if(a==='flow-audience-generate'){
    const s=selectedStage();if(!s||s.kind!=='poll')return true;
    if(cohortDraftElsewhere(p,s)){say('Review or discard the existing audience draft before creating another.');return true}
    if(!canGenerateCohort())throw Error(cohortBlockReason()||'Generation is not available right now.');
    S.cohortInlineTarget={pipelineId:p.id,stageId:s.id};S.cohortTarget=null;S.cohortComposer=true;S.sections['cohort-generation']='review';S.sections['flow-inspector']='cohort';S.flowCohortPick=true;S.localError=null;
    startCohortJob().catch(fail);return true;
  }
  if(a==='flow-next'){
    const s=selectedStage();if(!s||s.kind!=='poll')return true;
    const stops=flowGuidedStops(s),current=S.sections['flow-inspector']==='answer'?'answers':S.sections['flow-inspector']||'question',tab=stops.includes(current)?current:'question',i=stops.indexOf(tab);
    if(!flowStopDone(p,s,tab)){S.sections['flow-inspector-error']={question:'Write the question before continuing.',answers:'Add at least two named options before continuing.',cohort:poolForPhase(p,s)?.personas.length?'Lower the sample size or add personas before finishing.':'Choose who answers, or create the audience, before finishing.'}[tab];render();root.querySelector('.setup-wizard-error')?.focus();return true}
    delete S.sections['flow-inspector-error'];
    if(i<stops.length-1){S.sections['flow-inspector']=stops[i+1];render();root.querySelector('.flow-inspector-body textarea, .flow-inspector-body input, .flow-inspector-body .setup-cohort-row button')?.focus()}
    else{S.flowPanel=false;render();root.querySelector('[data-flow-node="'+S.stageId+'"] [data-act=flow-select]')?.focus({preventScroll:true})}
    return true;
  }
  if(a==='flow-inspector'){delete S.sections['flow-inspector-error'];S.sections['flow-inspector']=el.dataset.section;render();root.querySelector('[data-act=flow-inspector][data-section="'+el.dataset.section+'"]')?.focus();return true}
  if(a==='flow-create-open'){const v=root.querySelector('.flow-viewport');if(!v)return flowAction('flow-add',{dataset:{kind:'independent'}});const scale=flowScaleApplied||1,left=v.scrollLeft+Math.max(0,v.clientWidth-340),top=v.scrollTop+16;flowOpenCreate(p,left/scale,top/scale,left,top);return true}
  if(a==='flow-fix'){const todo=flowTodo(p)[0];if(!todo){S.flowPanel=true;render();return true}S.sections.pipeline='flow';S.stageId=todo.stageId;S.sections['flow-inspector']=todo.tab;S.flowPanel=true;S.flowCohortPick=!!todo.pick;render();root.querySelector('.round-tab[aria-selected=true]')?.focus();say('Finish this step, then review the run.');return true}
  if(a==='flow-panel-close'){S.flowPanel=false;render();root.querySelector('[data-flow-node="'+S.stageId+'"] [data-act=flow-select]')?.focus({preventScroll:true});return true}
  if(a==='flow-settings'){S.flowSettingsReturn=true;S.sections.pipeline='advanced';render();return true}
  if(a==='flow-settings-back'){S.flowSettingsReturn=false;S.sections.pipeline='flow';render();return true}
  if(a==='flow-cancel'){S.flowSource=null;render();return true}
  if(a==='flow-add-menu'){S.flowAdd=S.flowAdd===el.dataset.id?null:el.dataset.id;render();return true}
  if(a==='flow-add-close'){S.flowAdd=null;render();return true}
  if(a==='flow-create'){
    const m=S.flowCreate;if(m?.pipelineId!==p.id||!FLOW_KINDS.some(k=>k.kind===el.dataset.kind))return true;
    flowFreezeLayout(p);const stage=flowNewStage(p,el.dataset.kind,null);p.stages.push(stage);p.layout[stage.id]={x:Math.max(0,Math.round(m.x)),y:Math.max(0,Math.round(m.y))};
    S.stageId=stage.id;S.flowPanel=true;S.flowAdd=null;S.flowSource=null;S.flowCreate=null;S.flowCohortPick=false;S.sections['flow-inspector']='question';delete S.sections['flow-inspector-error'];
    S.dirty=true;S.plan=null;render();return true;
  }
  if(a==='flow-output'){if(!p.stages.some(s=>s.id===el.dataset.id))return true;S.flowSource={pipelineId:p.id,stage:el.dataset.id,question:el.dataset.question};render();root.querySelector('.flow-hint')?.scrollIntoView?.({block:'nearest'});return true}
  if(a==='flow-connect-input'){
    flowConnect(p,el.dataset.source,el.dataset.question,el.dataset.id);S.flowSource=null;S.stageId=el.dataset.id;S.flowPanel=true;S.sections['flow-inspector']='connections';S.dirty=true;S.plan=null;render();return true;
  }
  if(a==='flow-select'||a==='flow-connect'){
    if(a==='flow-connect'&&S.flowSource?.pipelineId!==p.id)return true;
    S.sections['flow-inspector']='question';
    if(S.flowSource?.pipelineId===p.id){flowConnect(p,S.flowSource.stage,S.flowSource.question,el.dataset.id);S.flowSource=null;S.dirty=true;S.plan=null;S.sections['flow-inspector']='connections'}
    S.stageId=el.dataset.id;S.flowPanel=true;render();root.querySelector('.flow-inspector h2')?.focus();return true;
  }
  if(a==='flow-inputs'){S.stageId=el.dataset.id;S.flowPanel=true;S.sections['flow-inspector']='connections';render();return true}
  if(a==='flow-disconnect'){const s=p.stages.find(s=>s.id===el.dataset.id);if(s)flowDisconnect(p,s,el.dataset.key)}
  else if(a==='flow-add'){
    const source=p.stages.find(s=>s.id===el.dataset.id),output=source&&phaseOutput(p,source)[0],stage=flowNewStage(p,el.dataset.kind,source);
    if(!p.stages.length&&stage.kind==='poll'&&p.description?.trim())Object.values(stage.questions)[0].label=p.description.trim();
    if(source&&output)flowConnect({...p,stages:[...p.stages,stage]},source.id,output.id,stage.id);
    p.stages.push(stage);S.stageId=stage.id;S.flowPanel=true;S.flowAdd=null;S.flowSource=null;S.flowCreate=null;S.flowCohortPick=false;S.sections['flow-inspector']='question';delete S.sections['flow-inspector-error'];
  }else return true;
  S.dirty=true;S.plan=null;render();return true;
}
function drawFlowEdges(){
  const map=root.querySelector('.flow-map');if(!map)return false;
  map.querySelector('.flow-links')?.remove();map.style.transform='';
  const viewport=map.closest('.flow-viewport'),space=map.closest('.flow-space'),p=pipeline(),nodes=[...map.querySelectorAll('[data-flow-node]')],columns=[...map.querySelectorAll('.flow-column')],edges=[];
  const free=flowApplyLayout(p,map,nodes);
  let lanes=0;
  for(const target of p.stages){const to=nodes.find(n=>n.dataset.flowNode===target.id);if(!to)continue;
    for(const dep of target.dependsOn){const from=nodes.find(n=>n.dataset.flowNode===dep);if(!from)continue;
      const bindings=flowInputs(p,target).filter(([,input])=>input.stage===dep);
      for(const input of bindings.length?bindings.map(([,input])=>input):[null]){
        const output=[...from.querySelectorAll('[data-act=flow-output]')].find(n=>n.dataset.question===input?.question)||from.querySelector('[data-act=flow-output]');
        const inlet=[...to.querySelectorAll('[data-act=flow-inputs]')].find(n=>n.dataset.flowSource===dep&&n.dataset.flowQuestion===input?.question)||to.querySelector('[data-act=flow-inputs]');
        const source=p.stages.find(s=>s.id===dep),q=input&&phaseOutput(p,source).find(q=>q.id===input.question);
        const skip=!free&&columns.indexOf(to.closest('.flow-column'))>columns.indexOf(from.closest('.flow-column'))+1;
        edges.push({focus:[dep,target.id].includes(S.stageId)&&S.flowPanel!==false,from,to,output,inlet,lane:skip?lanes++:-1,label:input?({summary:'Answer summary',winner:'Leading option',mean:'Mean score',probabilities:q?flowOutputLabel(p,source,q):'Distribution',responses:'Each answer'}[input.select]||(q?flowOutputLabel(p,source,q):'Result')):'Dependency'});
      }
    }
  }
  if(!free)map.style.paddingTop=lanes?(30+lanes*20)+'px':'12px';
  const box=map.getBoundingClientRect(),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 '+box.width+' '+box.height);svg.setAttribute('aria-hidden','true');svg.classList.add('flow-links');
  for(const edge of edges){
    const from=edge.from.getBoundingClientRect(),to=edge.to.getBoundingClientRect(),out=(edge.output||edge.from).getBoundingClientRect(),inlet=(edge.inlet||edge.to).getBoundingClientRect();
    const a={...from,right:from.right,left:from.left,top:out.top,width:from.width,height:out.height,bottom:out.bottom},b={...to,right:to.right,left:to.left,top:inlet.top,width:to.width,height:inlet.height,bottom:inlet.bottom};
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',free?flowEdgePath(a,b,box):graphEdgePath(a,b,box,edge.lane));path.setAttribute('class','flow-wire');svg.append(path);
    if(!edge.focus)continue;const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.textContent=edge.label;text.setAttribute('x',String((from.right+to.left)/2-box.left));text.setAttribute('y',String(edge.lane>=0?8+edge.lane*14:(out.top+out.height/2+inlet.top+inlet.height/2)/2-box.top-8));text.setAttribute('class','flow-wire-label');svg.append(text);
  }
  map.prepend(svg);const fitted=Math.max(.1,Math.min(1,(viewport.clientWidth-32)/box.width,(viewport.clientHeight-48)/box.height)),scale=flowDrag?.scale??(S.flowScale==='fit'?fitted:S.flowScale??fitted);flowScaleApplied=scale;map.style.transform='scale('+scale+')';space.style.width=Math.ceil(box.width*scale)+'px';space.style.height=Math.ceil(box.height*scale)+'px';
  if(S.flowScroll?.pipelineId===p.id){viewport.scrollLeft=S.flowScroll.left;viewport.scrollTop=S.flowScroll.top}
  flowPlaceMenu(viewport,space);return true;
}

/* Freeform canvas: drag steps, pan empty canvas, click empty canvas to add a step (Railway/Hex style). */
const FLOW_KINDS=[
  {kind:'poll',label:'Ask cohort',hint:'Ask one or more questions to a cohort',keys:'question poll ask survey',icon:'<path d="M5 5h14v10H9l-4 4z"/>'},
  {kind:'aggregate',label:'Combine answers',hint:'Weight compatible answers together',keys:'aggregate merge weight join',icon:'<path d="M5 5c0 7 7 7 7 14M19 5c0 7-7 7-7 14"/>'},
  {kind:'decision',label:'Final result',hint:'Select the leading option from a Choice',keys:'decision winner outcome',icon:'<path d="M6 21V4h11l-2 4 2 4H6"/>'},
];
let flowDrag=null,flowSuppressClick=false,flowScaleApplied=1,flowFrame=0;
function flowKindMatches(query){const q=String(query||'').trim().toLowerCase();return FLOW_KINDS.filter(k=>!q||(k.label+' '+k.hint+' '+k.keys).toLowerCase().includes(q))}
function flowCreateItems(m){
  const items=flowKindMatches(m.query);m.index=Math.max(0,Math.min(m.index||0,items.length-1));
  return items.length?items.map((k,i)=>'<button type="button" class="flow-create-item" role="option" id="flow-create-'+k.kind+'" data-act="flow-create" data-kind="'+k.kind+'" aria-selected="'+(i===m.index)+'"><span class="flow-create-kind" data-kind="'+k.kind+'"><svg class="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+k.icon+'</svg></span><span class="flow-create-text"><strong>'+esc(k.label)+'</strong><small>'+esc(k.hint)+'</small></span></button>').join(''):'<p class="flow-create-empty">No matching step</p>';
}
function flowCreateMenu(p){
  const m=S.flowCreate?.pipelineId===p.id?S.flowCreate:null;if(!m)return '';
  return '<div class="flow-create-menu" role="dialog" aria-label="Add a step"><input class="flow-create-search" type="text" role="combobox" aria-expanded="true" aria-controls="flowCreateList" aria-label="What would you like to add?" placeholder="What would you like to add?" autocomplete="off" spellcheck="false" value="'+attr(m.query||'')+'"><div class="flow-create-list" id="flowCreateList" role="listbox" aria-label="Step kinds">'+flowCreateItems(m)+'</div><p class="flow-create-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to add · <kbd>Esc</kbd> to close</p></div>';
}
function flowOpenCreate(p,x,y,left,top){S.flowCreate={pipelineId:p.id,x,y,left,top,query:'',index:0,focus:true};S.flowAdd=null;render()}
function flowCloseCreate(){if(!S.flowCreate)return;S.flowCreate=null;root.querySelector('.flow-create-menu')?.remove();root.querySelector('.flow-viewport')?.focus({preventScroll:true})}
function flowPlaceMenu(viewport,space){
  const menu=space.querySelector('.flow-create-menu'),m=S.flowCreate;if(!menu||!m)return;
  const maxLeft=viewport.scrollLeft+viewport.clientWidth-menu.offsetWidth-24,maxTop=viewport.scrollTop+viewport.clientHeight-menu.offsetHeight-32;
  menu.style.left=Math.max(0,Math.min(m.left,maxLeft))+'px';menu.style.top=Math.max(0,Math.min(m.top,maxTop))+'px';
  const input=menu.querySelector('input'),list=menu.querySelector('.flow-create-list');
  const sync=()=>{list.innerHTML=flowCreateItems(m);const active=list.querySelector('[aria-selected=true]');if(active)input.setAttribute('aria-activedescendant',active.id);else input.removeAttribute('aria-activedescendant')};
  sync();
  input.addEventListener('input',e=>{e.stopPropagation();m.query=input.value;m.index=0;sync()});
  input.addEventListener('keydown',e=>{
    const count=flowKindMatches(m.query).length;
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();e.stopPropagation();if(count){m.index=(m.index+(e.key==='ArrowDown'?1:count-1))%count;sync()}}
    else if(e.key==='Enter'){e.preventDefault();e.stopPropagation();list.querySelector('[aria-selected=true]')?.click()}
    else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();flowCloseCreate()}
  });
  if(m.focus){m.focus=false;input.focus({preventScroll:true})}
}
function flowLayoutActive(p){return !!p?.layout&&p.stages.some(s=>Object.hasOwn(p.layout,s.id))}
/** Copies every step's on-screen position into the study so later edits never reshuffle what the user arranged. */
function flowFreezeLayout(p){
  if(!p.layout)p.layout={};
  for(const node of root.querySelectorAll?.('.flow-map [data-flow-node]')||[])if(!Object.hasOwn(p.layout,node.dataset.flowNode))p.layout[node.dataset.flowNode]={x:Math.round(node.offsetLeft),y:Math.round(node.offsetTop)};
}
function flowApplyLayout(p,map,nodes){
  map.classList.remove('flow-free');map.style.width='';map.style.height='';nodes.forEach(n=>{n.style.left='';n.style.top=''});
  if(!flowLayoutActive(p))return false;
  const size=Object.fromEntries(nodes.map(n=>[n.dataset.flowNode,{w:n.offsetWidth,h:n.offsetHeight}])),placed={},gap=24;
  const overlaps=(x,y,w,h)=>Object.values(placed).some(r=>x<r.x+r.w+gap&&x+w+gap>r.x&&y<r.y+r.h+gap&&y+h+gap>r.y);
  for(const s of p.stages)if(size[s.id]&&p.layout[s.id])placed[s.id]={...p.layout[s.id],...size[s.id]};
  const depths=flowDepths(p);
  for(const s of [...p.stages].sort((a,b)=>depths.get(a.id)-depths.get(b.id))){
    if(!size[s.id]||placed[s.id])continue;
    const deps=s.dependsOn.map(id=>placed[id]).filter(Boolean),all=Object.values(placed);let x,y;
    if(deps.length){const right=deps.reduce((a,b)=>a.x+a.w>b.x+b.w?a:b);x=right.x+right.w+80;y=right.y}
    else{x=all.length?Math.min(...all.map(r=>r.x)):0;y=all.length?Math.max(...all.map(r=>r.y+r.h))+48:0}
    for(let guard=0;guard<80&&overlaps(x,y,size[s.id].w,size[s.id].h);guard++)y+=32;
    placed[s.id]={x,y,...size[s.id]};
  }
  map.classList.add('flow-free');map.style.paddingTop='0';
  let width=0,height=0;
  for(const n of nodes){const r=placed[n.dataset.flowNode];if(!r)continue;n.style.left=r.x+'px';n.style.top=r.y+'px';width=Math.max(width,r.x+r.w);height=Math.max(height,r.y+r.h)}
  map.style.width=(width+48)+'px';map.style.height=(height+48)+'px';
  return true;
}
function flowEdgePath(a,b,box){
  const x1=a.right-box.left,y1=a.top+a.height/2-box.top,x2=b.left-box.left-3,y2=b.top+b.height/2-box.top,d=Math.max(48,Math.abs(x2-x1)/2);
  return 'M '+x1+' '+y1+' C '+(x1+d)+' '+y1+', '+(x2-d)+' '+y2+', '+x2+' '+y2;
}
function flowRedraw(){if(flowFrame)return;flowFrame=requestAnimationFrame(()=>{flowFrame=0;drawFlowEdges()})}
function wireFlowCanvas(){
document.addEventListener('pointerdown',e=>{
  if(e.button!==0||S.loading||!e.target?.closest)return;
  const viewport=e.target.closest('.flow-viewport');
  if(!viewport||e.target.closest('.flow-create-menu,input,select,textarea,a'))return;
  const box=viewport.getBoundingClientRect();if(e.clientX>=box.left+viewport.clientLeft+viewport.clientWidth||e.clientY>=box.top+viewport.clientTop+viewport.clientHeight)return;
  const node=e.target.closest('[data-flow-node]');
  flowDrag={pointerId:e.pointerId,type:e.pointerType,x:e.clientX,y:e.clientY,node,viewport,moved:false,scrollLeft:viewport.scrollLeft,scrollTop:viewport.scrollTop,menuOpen:!!S.flowCreate};
});
document.addEventListener('pointermove',e=>{
  const d=flowDrag;if(!d||e.pointerId!==d.pointerId)return;
  const dx=e.clientX-d.x,dy=e.clientY-d.y;
  if(!d.moved){
    if(Math.hypot(dx,dy)<5)return;
    if(!d.node&&d.type==='touch'){flowDrag=null;return}
    d.moved=true;d.scale=flowScaleApplied;d.viewport.classList.add('flow-dragging');
    if(d.node){const p=pipeline();flowFreezeLayout(p);d.p=p;d.id=d.node.dataset.flowNode;d.start={...p.layout[d.id]};d.node.classList.add('flow-node-dragging');flowCloseCreate()}
  }
  e.preventDefault();
  if(d.node){d.p.layout[d.id]={x:Math.max(0,Math.round(d.start.x+dx/d.scale)),y:Math.max(0,Math.round(d.start.y+dy/d.scale))};flowRedraw()}
  else{d.viewport.scrollLeft=d.scrollLeft-dx;d.viewport.scrollTop=d.scrollTop-dy}
});
function flowPointerEnd(e,cancelled){
  const d=flowDrag;if(!d||e.pointerId!==d.pointerId)return;flowDrag=null;
  d.viewport.classList.remove('flow-dragging');d.node?.classList.remove('flow-node-dragging');
  if(d.moved){
    flowSuppressClick=true;setTimeout(()=>{flowSuppressClick=false},0);
    if(d.node){S.flowScale=d.scale;S.dirty=true;S.plan=null;render()}
    return;
  }
  if(cancelled||d.node||d.menuOpen)return;
  const p=pipeline(),map=d.viewport.querySelector('.flow-map'),space=d.viewport.querySelector('.flow-space');if(!p||!map||!space)return;
  flowSuppressClick=true;setTimeout(()=>{flowSuppressClick=false},0);
  if(S.flowSource){S.flowSource=null;render();return}
  const mapBox=map.getBoundingClientRect(),spaceBox=space.getBoundingClientRect(),scale=flowScaleApplied||1;
  flowOpenCreate(p,(e.clientX-mapBox.left)/scale,(e.clientY-mapBox.top)/scale,e.clientX-spaceBox.left,e.clientY-spaceBox.top);
}
document.addEventListener('pointerup',e=>flowPointerEnd(e,false));
document.addEventListener('pointercancel',e=>flowPointerEnd(e,true));
document.addEventListener('click',e=>{
  if(flowSuppressClick){flowSuppressClick=false;e.preventDefault();e.stopPropagation();return}
  if(S.flowCreate&&!e.target?.closest?.('.flow-create-menu'))flowCloseCreate();
},true);
document.addEventListener('scroll',e=>{const v=e.target;if(v?.classList?.contains('flow-viewport')&&v.isConnected){const p=pipeline();if(p)S.flowScroll={pipelineId:p.id,left:v.scrollLeft,top:v.scrollTop}}},true);
root.addEventListener('keydown',e=>{
  const v=e.target;if(!v?.classList?.contains('flow-viewport')||(e.key!=='Enter'&&e.key!==' ')||S.flowCreate)return;
  const p=pipeline();if(!p)return;e.preventDefault();
  const scale=flowScaleApplied||1,left=v.scrollLeft+Math.max(0,v.clientWidth/2-160),top=v.scrollTop+24;
  flowOpenCreate(p,left/scale,top/scale,left,top);
});
root.addEventListener('keydown',e=>{
  if(e.key!=='Escape'||e.defaultPrevented||S.flowCreate)return;
  const panel=root.querySelector('.round-panel');if(!panel)return;
  if(!panel.contains(e.target)&&!e.target?.classList?.contains('flow-viewport'))return;
  e.preventDefault();flowAction('flow-panel-close',{dataset:{}});
});
}

`;

export const WORKSPACE_FLOW_CSS = `
.flow-empty{display:grid;justify-items:center;align-content:center;gap:16px;min-height:360px;padding:32px 16px;background:var(--raised);border-top:1px solid var(--line);cursor:pointer}
.flow-empty-targets{display:flex;flex-wrap:wrap;justify-content:center;gap:16px;width:100%}
.flow-empty-target{appearance:none;display:grid;justify-items:center;align-content:center;gap:8px;flex:1 1 240px;max-width:340px;min-height:180px;padding:24px 20px;border:2px dashed var(--control-line);border-radius:var(--radius-panel,10px);background:var(--surface);color:var(--ink);font:inherit;text-align:center;cursor:pointer;transition:border-color 140ms ease-out,background 140ms ease-out}
.flow-empty-target[data-primary=true]{border-color:var(--blue)}
.flow-empty-target:hover,.flow-empty-target:focus-visible{border-color:var(--blue);background:var(--action)}
.flow-empty-target:focus-visible{outline:2px solid var(--focus,var(--blue));outline-offset:2px}
.flow-empty-target strong{font:600 17px/1.3 var(--display);letter-spacing:-.01em}
.flow-empty-target>span:last-child{max-width:30ch;color:var(--muted);font-size:13px}
.flow-empty-icon{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--action);color:var(--blue)}.flow-empty-icon .ui-icon{width:22px;height:22px}
.flow-empty-hint{margin:0;color:var(--muted);font-size:12px}
@media(min-width:761px){.flow-empty{min-height:max(360px,calc(100dvh - 330px))}}
.flow-workspace{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start;min-width:0}
.flow-board,.flow-inspector{border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--surface);min-width:0;overflow:hidden}
.flow-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}.flow-toolbar h2{margin:0;font-size:14px;white-space:nowrap}.flow-toolbar h2 span{font-weight:400;font-size:12px;margin-left:6px;color:var(--muted)}.flow-toolbar .row{gap:6px}
.flow-hint{padding:10px 16px;font-size:12px;color:var(--muted);min-height:42px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.flow-viewport{overflow:auto;max-height:calc(100dvh - 350px);min-height:330px;background:var(--raised);padding:24px 16px;border-top:1px solid var(--line)}
.flow-map{position:relative;display:flex;gap:110px;width:max-content;transform-origin:top left;padding:12px 0}.flow-space{min-width:100%}.flow-column{display:flex;flex-direction:column;justify-content:center;gap:60px;width:232px;flex:none}
.flow-node{position:relative;width:232px;border:1px solid var(--control-line);border-radius:10px;background:var(--surface);z-index:1;overflow:hidden}.flow-node[data-selected=true]{border:2px solid var(--blue)}.flow-node[data-targetable=true]{border-style:dashed;border-color:var(--blue)}.flow-node-header{display:flex;align-items:center;gap:8px;padding:8px 10px 0}.flow-node-header .button{margin-left:auto;border:0;background:transparent}.flow-number{display:grid;place-items:center;width:22px;height:22px;background:var(--raised);border-radius:6px;font-size:12px;font-variant-numeric:tabular-nums}.flow-status{font-size:11px;color:var(--amber);font-weight:600}.flow-status[data-ready=true]{color:var(--muted)}.flow-select .flow-sample-short{display:inline;color:var(--red);font-weight:600}.flow-sample-notice .row{margin-top:8px}.flow-sample-notice p{margin:0}
.flow-select{border:0;background:transparent;color:var(--ink);font:inherit;display:grid;gap:8px;padding:10px 12px 14px;text-align:left;width:100%;cursor:pointer}.flow-select:hover{background:var(--hover)}.flow-select strong{font-size:14px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.flow-select span{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.flow-select small{font-size:11px;color:var(--muted)}
.flow-node-outputs{border-top:1px solid var(--line)}.flow-output{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:8px 12px;font:inherit;font-size:11px;color:var(--blue);background:var(--surface);border:0;text-align:left;cursor:pointer}.flow-output span:first-child{overflow-wrap:anywhere}.flow-output:hover,.flow-output[aria-pressed=true]{background:var(--selection)}.flow-socket{width:9px;height:9px;border:2px solid var(--blue);border-radius:50%;flex:none}.flow-output[aria-pressed=true] .flow-socket{background:var(--blue)}
.flow-node-inputs{padding:4px 12px;background:var(--raised);border-bottom:1px solid var(--line)}.flow-node-inputs button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:10px;padding:3px 0;display:flex;align-items:center;gap:5px;text-align:left;cursor:pointer;width:100%}.flow-node-inputs button span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.flow-node-inputs .ui-icon{width:12px;height:12px;flex:none}
.flow-kind{font-size:11px;font-weight:600;color:var(--muted)}.flow-node-header .flow-status{margin-left:auto;display:inline-flex;align-items:center;gap:5px}.flow-status::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}.flow-status[data-ready=true]{color:var(--green,#2f7d4f)}
.flow-who{display:flex;align-items:center;gap:10px;width:100%;padding:8px 12px;border:0;border-top:1px solid var(--line);background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}.flow-who:hover{background:var(--hover)}.flow-who .flow-host-dots{display:grid;grid-template-columns:repeat(4,6px);gap:3px;flex:none}.flow-who .flow-host-dots i{width:6px;height:6px;border-radius:2px;background:var(--blue);opacity:.55}.flow-who-text{display:grid;gap:1px;min-width:0}.flow-who-text strong{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.flow-who-text>span{font-size:11px;color:var(--muted)}
.flow-output[data-used=true]{color:var(--muted)}.flow-output[data-used=true] .flow-output-text>span{color:var(--muted);font-size:11px}.flow-output[data-used=true] .flow-socket{background:var(--blue)}
.flow-next{display:flex;align-items:center;gap:6px;width:100%;padding:8px 12px;border:0;border-top:1px dashed var(--line);background:transparent;color:var(--blue);font:inherit;font-size:12px;font-weight:600;cursor:pointer}.flow-next:hover{background:var(--selection)}.flow-next .ui-icon{width:14px;height:14px}
.flow-links{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.flow-wire{fill:none;stroke:var(--control-line);stroke-width:1.5}.flow-wire-label{font:10px var(--body);fill:var(--muted);text-anchor:middle;paint-order:stroke;stroke:var(--raised);stroke-width:5px;stroke-linejoin:round}
.flow-action-bar{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--selection);font-size:12px}.flow-action-bar>span{display:block;margin-bottom:8px;overflow-wrap:anywhere}
.flow-member-navigation{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}.flow-member-navigation .row{gap:4px;font-size:10px}.flow-member-focus .host-member-detail{margin-top:10px;padding-top:10px}.flow-inspector .setup-connections .setup-choice{display:grid;gap:5px}.flow-inspector .setup-connections .setup-choice span{font-size:11px}
.flow-inspector-head{display:flex;align-items:start;justify-content:space-between;gap:12px;padding:14px 16px 8px}.flow-inspector-head h2{font-size:14px;margin:0;overflow-wrap:anywhere;line-height:1.4}.flow-inspector-head .button{flex:none}.flow-inspector>.section-tabs{margin:0 12px;border-bottom:1px solid var(--line);gap:0}.flow-inspector>.section-tabs .button{padding-inline:10px;font-size:11px}.flow-inspector-body{padding:16px;max-height:calc(100dvh - 400px);overflow:auto;min-height:260px}
.flow-batch-control{display:grid;gap:8px;margin:-4px 0 12px;padding:10px 12px;border:1px solid var(--line,#d7d7d7);border-radius:8px}.flow-batch-control .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.flow-batch-control input{width:7rem}.flow-batch-control p{margin:0}
.flow-inspector .setup-panel,.flow-inspector-body>.panel{border:0;padding:0;border-radius:0;background:transparent;box-shadow:none}.flow-inspector .setup-prompt-row,.flow-inspector .setup-columns{display:block;margin:0}.flow-inspector .phase-picker,.flow-inspector .setup-step-toolbar,.flow-inspector .setup-context{display:none}.flow-inspector .setup-section-heading{margin-bottom:10px}.flow-inspector .setup-section-heading h3{font-size:13px}.flow-inspector[data-inspector-tab=question] .setup-columns>section:first-child,.flow-inspector[data-inspector-tab=cohort] .setup-prompt-row,.flow-inspector[data-inspector-tab=answer] .setup-prompt-row{display:none}.flow-inspector[data-inspector-tab=cohort] .setup-columns>section:last-child,.flow-inspector[data-inspector-tab=answer] .setup-columns>section:first-child{display:none}.flow-inspector[data-inspector-tab=cohort] [aria-label="Questions in this step"],.flow-inspector[data-inspector-tab=answer] [aria-label="Questions in this step"]{display:none}.flow-inspector .setup-types{gap:6px}.flow-inspector .setup-types .button{font-size:11px;padding-inline:8px}.flow-inspector .setup-cohort-row .setup-choice{padding:10px}.flow-inspector .setup-cohort-row .setup-choice strong{font-size:12px}.flow-inspector .setup-cohort-row>.cohort-details{font-size:11px;margin-right:4px;padding-inline:4px}.flow-connections h3{margin:0 0 12px;font-size:13px}.flow-connection-row{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:10px 0}.flow-connection-row>div{flex:1;min-width:0}.flow-connection-row strong{font-size:12px;overflow-wrap:anywhere;display:block}.flow-connection-row span{font-size:11px;color:var(--muted);display:block}.flow-connection-row .button{flex:none}
.flow-output-text{display:grid;gap:3px;min-width:0}.flow-output-text strong{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600}.flow-output-text strong .ui-icon{width:12px;height:12px}.flow-output-text>span{font-size:10px;color:var(--muted);line-height:1.4}.flow-output{min-height:46px}.flow-destination{display:flex;align-items:center;justify-content:center;gap:6px;width:calc(100% - 20px);margin:0 10px 10px;padding:8px 10px;border:1px solid var(--blue);border-radius:6px;background:var(--selection);color:var(--blue);font:inherit;font-size:12px;font-weight:600;cursor:pointer}.flow-destination:hover{background:var(--hover)}.flow-destination .ui-icon{width:14px;height:14px}.flow-hint>span{flex:1;min-width:160px}.flow-hint strong{color:var(--ink)}.flow-hint .button{flex:none}.flow-node[data-targetable=true]{box-shadow:0 0 0 2px var(--selection)}.flow-input-picker{padding-top:20px}.flow-input-choice{display:flex;align-items:center;gap:10px;text-align:left;width:100%;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);padding:10px;margin-bottom:8px;font:inherit;cursor:pointer}.flow-input-choice:hover{border-color:var(--blue);background:var(--selection)}.flow-input-choice>span{flex:1;min-width:0;display:grid;gap:4px}.flow-input-choice strong{font-size:12px;overflow-wrap:anywhere}.flow-input-choice small{color:var(--muted);font-size:11px}.flow-input-choice>.ui-icon{width:14px;height:14px;flex:none}
@media(min-width:1001px) and (min-height:700px){
.study-shell:has(.flow-workspace){padding-top:16px;padding-bottom:16px;max-width:1600px;height:calc(100dvh - 66px);display:flex;flex-direction:column;gap:0;min-height:0}.study-shell:has(.flow-workspace)>.masthead{margin-bottom:12px}.study-shell:has(.flow-workspace)>#view-studies{flex:1;min-height:0;display:flex;flex-direction:column}.study-shell:has(.flow-workspace) #view-studies>.section-tabs{flex:none;margin-bottom:12px}.flow-workspace{flex:1;min-height:0;align-items:stretch;gap:12px}.flow-board,.flow-inspector{display:flex;flex-direction:column;min-height:0}.flow-toolbar,.flow-hint,.flow-action-bar,.flow-inspector-head,.flow-inspector>.section-tabs{flex:none}.flow-viewport{flex:1;min-height:0;max-height:none;padding:16px}.flow-inspector-body{flex:1;min-height:0;max-height:none;padding:12px}.flow-inspector .setup-prompt-row{margin-bottom:14px}.flow-inspector .setup-section-heading{margin-bottom:6px}.flow-inspector .setup-option-record{padding:4px 0}.flow-inspector .setup-answer-summary{font-size:11px}.flow-inspector [data-form=study-setup] textarea{min-height:58px}
}
@media(min-width:1001px) and (min-height:700px){
.flow-inspector-head{padding:10px 12px 6px;gap:8px}.flow-inspector-head h2{font-size:13px;line-height:1.3}.flow-inspector>.section-tabs .button{min-height:28px;padding-block:5px}.flow-inspector-body{padding:10px 12px}.flow-inspector [aria-label="Questions in this step"]{display:flex;gap:4px;margin:0 0 8px;padding:0;flex-wrap:wrap}.flow-inspector [aria-label="Questions in this step"] .button{flex:1;min-width:70px;min-height:28px;max-width:100%;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;display:block;font-size:10px;padding:5px 7px}.flow-inspector .setup-prompt-row{margin-bottom:8px}.flow-inspector .setup-prompt-row .field{gap:4px}.flow-inspector .setup-prompt-row label{font-size:11px}.flow-inspector [data-form=study-setup] textarea[name=setupPrompt]{height:54px;min-height:54px;padding:7px 9px;line-height:1.35;font-size:12px}.flow-inspector .setup-section-heading{min-height:20px;margin-bottom:4px}.flow-inspector .setup-section-heading h3{font-size:12px}.flow-inspector .setup-output-format{margin-bottom:4px;font-size:11px;min-height:28px}.flow-inspector .setup-output-format .button{min-height:26px;width:26px;height:26px;padding:4px}.flow-inspector .setup-input-tabs{margin:0 0 4px}.flow-inspector .setup-input-tabs button{min-height:28px;padding:5px 8px;font-size:11px}.flow-inspector .setup-option-list{margin-top:4px}.flow-inspector .setup-option-record{padding:3px 0;gap:6px;min-height:30px}.flow-inspector .setup-option-record>.button{min-height:26px;width:26px;height:26px;padding:4px}.flow-inspector .setup-option-edit{padding:2px 0;gap:6px}.flow-inspector .setup-option-edit strong{font-size:12px}.flow-inspector .setup-option-edit small{font-size:10px}.flow-inspector .setup-answer-summary{margin-top:6px!important;padding-top:6px;font-size:10px}.flow-inspector .setup-input-pane>.row{margin-top:6px;gap:4px}.flow-inspector .setup-input-pane>.row>.button{min-height:28px;padding-block:4px}
.flow-map{gap:64px}.flow-column{gap:32px;width:210px}.flow-node{width:210px}.flow-node-header{padding:6px 8px 0;gap:6px}.flow-node-header .button{min-height:26px;width:26px;height:26px;padding:4px}.flow-select{gap:5px;padding:8px 10px}.flow-select strong{font-size:13px;-webkit-line-clamp:2}.flow-select span{font-size:11px;-webkit-line-clamp:1}.flow-select small{font-size:10px}.flow-output{min-height:36px;padding:5px 10px}.flow-output-text{gap:2px}.flow-output-text>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:175px}.flow-node-inputs{padding:3px 10px}.flow-node-inputs button{min-height:24px}.flow-hint{font-size:11px;padding:8px 12px}
}
@media(max-width:1000px){.flow-workspace{grid-template-columns:minmax(0,1fr) 320px}.flow-toolbar{flex-wrap:wrap;gap:8px}.flow-toolbar h2{flex:1}}
@media(max-width:760px){.flow-workspace{grid-template-columns:minmax(0,1fr)}.flow-viewport{min-height:240px;max-height:350px}.flow-inspector-body{max-height:none;min-height:0}.flow-inspector-head h2{font-size:14px}.flow-toolbar{padding:10px 12px}.flow-hint{padding:8px 12px}.flow-column,.flow-node{width:216px}.flow-map{gap:100px}.flow-inspector>.section-tabs .button{flex:1}}
.flow-space{position:relative}.flow-viewport{cursor:default}.flow-viewport.flow-dragging{cursor:grabbing;user-select:none;-webkit-user-select:none}.flow-viewport.flow-dragging *{cursor:grabbing!important}
.flow-node{cursor:grab;touch-action:none}.flow-map.flow-free{display:block;padding:0}.flow-map.flow-free .flow-column{display:contents}.flow-map.flow-free .flow-node{position:absolute;margin:0}
.flow-node-dragging{z-index:3;box-shadow:0 14px 30px rgba(15,35,55,.2)}.flow-node-dragging button{pointer-events:none}
.flow-create-menu{position:absolute;z-index:6;width:300px;max-width:calc(100vw - 48px);display:grid;gap:2px;padding:6px;border:1px solid var(--line);border-radius:12px;background:var(--surface);color:var(--ink);box-shadow:0 18px 40px rgba(15,35,55,.22);cursor:default}
.flow-create-search{width:100%;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:10px 10px 12px;margin-bottom:4px;font:inherit;font-size:13px;background:transparent;color:var(--ink);outline:none;box-shadow:none}
.flow-create-list{display:grid;gap:2px}.flow-create-item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--ink);font:inherit;text-align:left;cursor:pointer}.flow-create-item[aria-selected=true],.flow-create-item:hover{background:var(--selection)}
.flow-create-kind{flex:none;display:grid;place-items:center;width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:var(--raised);color:var(--blue)}.flow-create-kind .ui-icon{width:16px;height:16px}
.flow-create-text{display:grid;gap:2px;min-width:0}.flow-create-text strong{font-size:13px}.flow-create-text small{font-size:11px;color:var(--muted)}
.flow-create-empty{margin:0;padding:10px;font-size:12px;color:var(--muted)}.flow-create-foot{margin:4px 0 0;padding:6px 10px 4px;border-top:1px solid var(--line);font-size:10px;color:var(--muted)}.flow-create-foot kbd{font:inherit;font-size:10px;padding:0 4px;border:1px solid var(--line);border-radius:4px;margin-right:2px}
`;

/* Railway-style step panel: slides over the right of the canvas with one row of tabs. Loaded last. */
export const ROUND_PANEL_CSS = `
.flow-workspace{position:relative;grid-template-columns:minmax(0,1fr)}
.round-panel{position:absolute;top:0;right:0;bottom:0;z-index:6;width:min(640px,62%);display:flex;flex-direction:column;border-radius:var(--radius-panel);box-shadow:-18px 0 40px rgba(20,32,48,.16);animation:round-panel-in 160ms ease-out}
@keyframes round-panel-in{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
@media(prefers-reduced-motion:reduce){.round-panel{animation:none}}
.round-panel .flow-inspector-head{align-items:center;padding:16px 18px 10px}
.round-panel-title{display:grid;gap:2px;min-width:0}.round-panel-title h2{margin:0;font:600 17px/1.3 var(--display);letter-spacing:-.01em;overflow-wrap:anywhere}
.round-panel-kind{font-size:12px;color:var(--muted)}
.round-tabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--line);overflow-x:auto}
.round-tab{appearance:none;display:inline-flex;align-items:center;gap:6px;min-height:42px;padding:0 12px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;white-space:nowrap;cursor:pointer}
.round-tab:hover{color:var(--ink)}.round-tab[aria-selected=true]{color:var(--ink);border-bottom-color:var(--blue)}
.round-tab:focus-visible{outline:2px solid var(--focus,var(--blue));outline-offset:-2px}
.round-tab-dot{width:7px;height:7px;border-radius:50%;background:var(--amber)}
.round-tab-check{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;background:var(--blue-soft);color:var(--blue)}.round-tab-check .ui-icon{width:11px;height:11px}
.guided-footer{display:flex;align-items:center;justify-content:space-between;gap:12px;flex:none;padding:12px 18px;border-top:1px solid var(--line);background:var(--surface)}
.round-panel .setup-wizard-error{margin:12px 0 0}
.round-panel .flow-inspector-body{flex:1;min-height:0;overflow:auto;padding:16px 18px}
.round-outputs{margin-top:16px;padding-top:12px;border-top:1px solid var(--line)}.round-outputs h3{margin:0 0 4px;font-size:13px}
@media(max-width:760px){.round-panel{position:static;width:auto;box-shadow:none;animation:none}}
`;
