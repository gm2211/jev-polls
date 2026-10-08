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
function flowReadiness(p,s){
  if(s.kind==='poll'){
    if(!Object.values(s.questions||{}).length||Object.values(s.questions).some(q=>!q.label.trim()||q.label==='What should this phase decide?'))return 'Needs question';
    if(!poolForPhase(p,s)?.personas.length)return 'Needs cohort';
    if(Object.values(s.questions).some(q=>q.type==='choice'?Object.keys(q.criteria).length<2||Object.entries(q.criteria).some(([key,value])=>!String(optionName(key,value)).trim()):q.type==='score'?q.criteria.length<2||q.criteria.some(value=>!value.trim()):false))return 'Needs options';
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
function flowNode(p,s){
  const pool=poolForPhase(p,s),outputs=phaseOutput(p,s),status=flowReadiness(p,s),pending=S.flowSource?.pipelineId===p.id?S.flowSource:null;
  const targetable=pending&&flowCanConnect(p,pending.stage,pending.question,s)&&!flowAlreadyConnected(p,s,pending.stage,pending.question);
  return '<article class="flow-node" data-flow-node="'+attr(s.id)+'" data-stage-index="'+p.stages.indexOf(s)+'" data-selected="'+(S.stageId===s.id)+'" data-targetable="'+!!targetable+'" aria-label="'+attr(stepTitle(p,s))+'">'+
    '<div class="flow-node-header"><span class="flow-number">'+(p.stages.indexOf(s)+1)+'</span><span class="flow-status" data-ready="'+(status==='Ready')+'">'+esc(status)+'</span><button class="button small icon-button" data-act="flow-add-menu" data-id="'+attr(s.id)+'" aria-label="Add after '+attr(stepTitle(p,s))+'" title="Add follow-up or result">'+icon('plus')+'</button></div>'+
    '<button class="flow-select" data-act="flow-select" data-id="'+attr(s.id)+'" aria-pressed="'+(S.stageId===s.id)+'" aria-label="'+(targetable?'Connect to ':'Edit ')+attr(stepTitle(p,s))+'"><strong>'+esc(stepTitle(p,s).replace(/^\d+\. /,''))+'</strong><span>'+esc(s.kind==='poll'?(pool?.name||'Choose a cohort'):(s.kind==='aggregate'?'Combine compatible answers':'Select leading option'))+'</span>'+(s.kind==='poll'?'<small>'+Number(s.size??pool?.personas.length??0).toLocaleString('en-US')+' personas · '+answerName(outputs[0]?.type)+'</small>':'')+'</button>'+
    (targetable?'<button class="flow-destination" data-act="flow-connect" data-id="'+attr(s.id)+'" aria-label="Connect here: '+attr(stepTitle(p,s))+'">'+icon('plus')+' Connect here</button>':'')+
    '<div class="flow-node-outputs">'+outputs.map(q=>'<button class="flow-output" data-act="flow-output" data-id="'+attr(s.id)+'" data-question="'+attr(q.id)+'" aria-pressed="'+(pending?.stage===s.id&&pending?.question===q.id)+'" aria-label="Connect '+attr(flowOutputLabel(p,s,q))+' from '+attr(stepTitle(p,s))+'" title="Connect this output to another step"><span class="flow-output-text"><strong>Connect output '+icon('right')+'</strong><span>'+esc(flowOutputLabel(p,s,q))+(outputs.length>1?' · '+esc(q.label||q.id):'')+'</span></span><span class="flow-socket" aria-hidden="true"></span></button>').join('')+'</div>'+
    (flowInputs(p,s).length?'<div class="flow-node-inputs">'+flowInputs(p,s).map(([,input])=>'<button data-act="flow-inputs" data-id="'+attr(s.id)+'" data-flow-source="'+attr(input.stage)+'" data-flow-question="'+attr(input.question)+'" aria-label="From '+attr(inputTitle(p,input))+'">'+icon('right')+'<span>From '+esc(inputTitle(p,input))+'</span></button>').join('')+'</div>':'')+'</article>';
}
function flowCanvas(p){
  if(!p.stages.length)return empty('Start with your question','Add a question and choose who answers.','<button class="button primary" data-act="flow-add" data-kind="independent">Add question</button>');
  const depths=flowDepths(p),levels=[...new Set(depths.values())].sort((a,b)=>a-b);
  return '<div class="flow-viewport" tabindex="0" role="region" aria-label="Study flow canvas"><div class="flow-space"><div class="flow-map">'+levels.map(level=>'<div class="flow-column">'+p.stages.filter(s=>depths.get(s.id)===level).map(s=>flowNode(p,s)).join('')+'</div>').join('')+'</div></div></div>';
}
function flowConnections(p,s){
  const inputs=flowInputs(p,s),available=dataInputOptions(p,s).flatMap(source=>phaseOutput(p,source).filter(q=>flowCanConnect(p,source.id,q.id,s)&&!flowAlreadyConnected(p,s,source.id,q.id)).map(q=>({source,q})));
  return '<section class="flow-connections"><h3>Connected results</h3>'+(inputs.length?inputs.map(([key,input])=>{const source=p.stages.find(x=>x.id===input.stage),q=source&&phaseOutput(p,source).find(x=>x.id===input.question),projection={summary:'Answer summary',probabilities:q?flowOutputLabel(p,source,q):'Distribution',responses:'Individual answers',winner:'Leading option',mean:'Mean score'}[input.select||'summary'];return '<div class="flow-connection-row"><div><strong>'+esc(inputTitle(p,input))+'</strong><span>'+esc(s.kind==='poll'?projection:q?flowOutputLabel(p,source,q):'Missing output')+'</span></div><button class="button small icon-button" data-act="flow-disconnect" data-id="'+attr(s.id)+'" data-key="'+attr(key)+'" title="Disconnect result" aria-label="Disconnect '+attr(inputTitle(p,input))+'">'+icon('trash')+'</button></div>'}).join(''):'<p class="subtle">No results connected. Choose an output below.</p>')+
    '<div class="flow-input-picker"><h3>Connect an output</h3>'+(available.length?available.map(({source,q})=>'<button class="flow-input-choice" data-act="flow-connect-input" data-id="'+attr(s.id)+'" data-source="'+attr(source.id)+'" data-question="'+attr(q.id)+'" aria-label="Connect '+attr(inputTitle(p,{stage:source.id,question:q.id}))+' to '+attr(stepTitle(p,s))+'"><span><strong>'+esc(inputTitle(p,{stage:source.id,question:q.id}))+'</strong><small>'+esc(flowOutputLabel(p,source,q))+'</small></span>'+icon('plus')+'</button>').join(''):'<p class="subtle">No other compatible outputs available. Add a question, or select another step.</p>')+'</div>'+(s.when?'<p class="subtle">Conditional dependencies also apply. Edit them in step settings.</p>':'')+'</section>';
}
function flowInspector(p,s){
  if(!s)return '<aside class="flow-inspector"><p>Select a question to edit it.</p></aside>';
  const requested=S.sections['flow-inspector']||'question',tab=s.kind==='poll'||['question','connections'].includes(requested)?requested:'question';
  return '<aside class="flow-inspector" aria-label="Selected step editor" data-inspector-tab="'+attr(tab)+'"><div class="flow-inspector-head"><h2 tabindex="-1">'+esc(stepTitle(p,s))+'</h2><button class="button small icon-button" data-act="flow-settings" aria-label="Step settings" title="Step settings">'+icon('settings')+'</button></div><nav class="section-tabs" aria-label="Selected step sections">'+(s.kind==='poll'?[['question','Question'],['cohort','Cohort'],['answer','Answers'],['connections','Inputs']]:[['question','Result'],['connections','Inputs']]).map(([key,label])=>'<button class="button small" data-act="flow-inspector" data-section="'+key+'" aria-pressed="'+(tab===key)+'">'+label+'</button>').join('')+'</nav><div class="flow-inspector-body">'+(tab==='connections'?flowConnections(p,s):stageForm(p,s))+'</div></aside>';
}
function flowWorkspace(p,s){
  const pending=S.flowSource?.pipelineId===p.id?S.flowSource:null,add=p.stages.find(x=>x.id===S.flowAdd),first=add&&phaseOutput(p,add)[0];
  return '<div class="flow-workspace"><section class="flow-board" aria-label="Study flow"><div class="flow-toolbar"><h2>Study flow <span>'+p.stages.length+' steps</span></h2><div class="row"><button class="button small" data-act="flow-add" data-kind="independent">'+icon('plus')+' Question</button><button class="button small icon-button" data-act="flow-fit" aria-label="Fit flow to view" title="Fit flow to view">'+icon('fit')+'</button><button class="button small" data-act="flow-reset" aria-label="Actual size" title="Actual size">100%</button></div></div>'+
    (add?'<div class="flow-action-bar" aria-label="Add after selected step"><span>After '+esc(stepTitle(p,add))+'</span><div class="row"><button class="button small" data-act="flow-add" data-id="'+attr(add.id)+'" data-kind="poll">Follow-up / branch</button><button class="button small" data-act="flow-add" data-id="'+attr(add.id)+'" data-kind="aggregate">Combine answers</button><button class="button small" data-act="flow-add" data-id="'+attr(add.id)+'" data-kind="decision" '+(first?.type!=='choice'?'disabled':'')+'>Final result</button><button class="button small icon-button" data-act="flow-add-close" aria-label="Close add step actions">'+icon('close')+'</button></div></div>':'')+
    '<div class="flow-hint" role="status">'+(pending?'<span><strong>2. Choose destination</strong><br>'+esc(inputTitle(p,{stage:pending.stage,question:pending.question}))+' → Click <strong>Connect here</strong> on a highlighted step.</span><button class="button small" data-act="flow-cancel">Cancel connection</button>':'<span><strong>1.</strong> Click <strong>Connect output</strong> → <strong>2.</strong> Click <strong>Connect here</strong>. Or select a step and choose an output in <strong>Inputs</strong>.</span>')+'</div>'+flowCanvas(p)+'</section>'+flowInspector(p,s)+'</div>';
}
function flowAction(a,el){
  if(!a.startsWith('flow-'))return false;
  const p=pipeline();if(!p)return true;
  if(a==='flow-fit'||a==='flow-reset'){S.flowScale=a==='flow-reset'?1:'fit';drawFlowEdges();return true}
  if(a==='flow-inspector'){S.sections['flow-inspector']=el.dataset.section;render();root.querySelector('[data-act=flow-inspector][data-section="'+el.dataset.section+'"]')?.focus();return true}
  if(a==='flow-settings'){S.flowSettingsReturn=true;S.sections.pipeline='advanced';render();return true}
  if(a==='flow-settings-back'){S.flowSettingsReturn=false;S.sections.pipeline='flow';render();return true}
  if(a==='flow-cancel'){S.flowSource=null;render();return true}
  if(a==='flow-add-menu'){S.flowAdd=S.flowAdd===el.dataset.id?null:el.dataset.id;render();return true}
  if(a==='flow-add-close'){S.flowAdd=null;render();return true}
  if(a==='flow-output'){if(!p.stages.some(s=>s.id===el.dataset.id))return true;S.flowSource={pipelineId:p.id,stage:el.dataset.id,question:el.dataset.question};render();root.querySelector('.flow-hint')?.scrollIntoView?.({block:'nearest'});return true}
  if(a==='flow-connect-input'){
    flowConnect(p,el.dataset.source,el.dataset.question,el.dataset.id);S.flowSource=null;S.stageId=el.dataset.id;S.sections['flow-inspector']='connections';S.dirty=true;S.plan=null;render();return true;
  }
  if(a==='flow-select'||a==='flow-connect'){
    if(a==='flow-connect'&&S.flowSource?.pipelineId!==p.id)return true;
    S.sections['flow-inspector']='question';
    if(S.flowSource?.pipelineId===p.id){flowConnect(p,S.flowSource.stage,S.flowSource.question,el.dataset.id);S.flowSource=null;S.dirty=true;S.plan=null;S.sections['flow-inspector']='connections'}
    S.stageId=el.dataset.id;render();root.querySelector('.flow-inspector h2')?.focus();return true;
  }
  if(a==='flow-inputs'){S.stageId=el.dataset.id;S.sections['flow-inspector']='connections';render();return true}
  if(a==='flow-disconnect'){const s=p.stages.find(s=>s.id===el.dataset.id);if(s)flowDisconnect(p,s,el.dataset.key)}
  else if(a==='flow-add'){
    const source=p.stages.find(s=>s.id===el.dataset.id),output=source&&phaseOutput(p,source)[0],kind=el.dataset.kind;
    const stage=kind==='aggregate'?{id:id(),kind:'aggregate',label:'Combined answers',inputs:[],outputQuestion:'combined',dependsOn:[]}:kind==='decision'?{id:id(),kind:'decision',label:'Final result',from:{stage:'',question:''},outputQuestion:'decision',dependsOn:[]}:{id:id(),kind:'poll',label:'New question',cohort:source?.kind==='poll'?source.cohort:Object.keys(p.cohorts)[0]||'',questions:{answer:{type:'choice',label:'',instructions:'Answer the question using your persona and the supplied context.',criteria:{option_a:'',option_b:''}}},inputs:{},dependsOn:[],repeats:1};
    if(source&&output)flowConnect({...p,stages:[...p.stages,stage]},source.id,output.id,stage.id);
    p.stages.push(stage);S.stageId=stage.id;S.flowAdd=null;S.flowSource=null;S.sections['flow-inspector']='question';
  }else return true;
  S.dirty=true;S.plan=null;render();return true;
}
function drawFlowEdges(){
  const map=root.querySelector('.flow-map');if(!map)return false;
  map.querySelector('.flow-links')?.remove();map.style.transform='';
  const viewport=map.closest('.flow-viewport'),space=map.closest('.flow-space'),p=pipeline(),nodes=[...map.querySelectorAll('[data-flow-node]')],columns=[...map.querySelectorAll('.flow-column')],edges=[];
  let lanes=0;
  for(const target of p.stages){const to=nodes.find(n=>n.dataset.flowNode===target.id);if(!to)continue;
    for(const dep of target.dependsOn){const from=nodes.find(n=>n.dataset.flowNode===dep);if(!from)continue;
      const bindings=flowInputs(p,target).filter(([,input])=>input.stage===dep);
      for(const input of bindings.length?bindings.map(([,input])=>input):[null]){
        const output=[...from.querySelectorAll('[data-act=flow-output]')].find(n=>n.dataset.question===input?.question)||from.querySelector('[data-act=flow-output]');
        const inlet=[...to.querySelectorAll('[data-act=flow-inputs]')].find(n=>n.dataset.flowSource===dep&&n.dataset.flowQuestion===input?.question);
        const source=p.stages.find(s=>s.id===dep),q=input&&phaseOutput(p,source).find(q=>q.id===input.question);
        const skip=columns.indexOf(to.closest('.flow-column'))>columns.indexOf(from.closest('.flow-column'))+1;
        edges.push({from,to,output,inlet,lane:skip?lanes++:-1,label:input?({summary:'Answer summary',winner:'Leading option',mean:'Mean score',probabilities:q?flowOutputLabel(p,source,q):'Distribution',responses:'Individual answers'}[input.select]||(q?flowOutputLabel(p,source,q):'Result')):'Dependency'});
      }
    }
  }
  map.style.paddingTop=lanes?(30+lanes*20)+'px':'12px';
  const box=map.getBoundingClientRect(),svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 '+box.width+' '+box.height);svg.setAttribute('aria-hidden','true');svg.classList.add('flow-links');
  for(const edge of edges){
    const from=edge.from.getBoundingClientRect(),to=edge.to.getBoundingClientRect(),out=(edge.output||edge.from).getBoundingClientRect(),inlet=(edge.inlet||edge.to).getBoundingClientRect();
    const a={...from,right:from.right,left:from.left,top:out.top,width:from.width,height:out.height,bottom:out.bottom},b={...to,right:to.right,left:to.left,top:inlet.top,width:to.width,height:inlet.height,bottom:inlet.bottom};
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');path.setAttribute('d',graphEdgePath(a,b,box,edge.lane));path.setAttribute('class','flow-wire');svg.append(path);
    const text=document.createElementNS('http://www.w3.org/2000/svg','text');text.textContent=edge.label;text.setAttribute('x',String((from.right+to.left)/2-box.left));text.setAttribute('y',String(edge.lane>=0?8+edge.lane*14:(out.top+out.height/2+inlet.top+inlet.height/2)/2-box.top-8));text.setAttribute('class','flow-wire-label');svg.append(text);
  }
  map.prepend(svg);const fitted=Math.min(1,(viewport.clientWidth-32)/box.width),scale=S.flowScale==='fit'?Math.min(fitted,(viewport.clientHeight-48)/box.height):S.flowScale??Math.max(.75,fitted);map.style.transform='scale('+scale+')';space.style.width=Math.ceil(box.width*scale)+'px';space.style.height=Math.ceil(box.height*scale)+'px';return true;
}

`;

export const WORKSPACE_FLOW_CSS = `
.flow-workspace{display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:16px;align-items:start;min-width:0}
.flow-board,.flow-inspector{border:1px solid var(--line);border-radius:var(--radius-panel);background:var(--surface);min-width:0;overflow:hidden}
.flow-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--line)}.flow-toolbar h2{margin:0;font-size:14px;white-space:nowrap}.flow-toolbar h2 span{font-weight:400;font-size:12px;margin-left:6px;color:var(--muted)}.flow-toolbar .row{gap:6px}
.flow-hint{padding:10px 16px;font-size:12px;color:var(--muted);min-height:42px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.flow-viewport{overflow:auto;max-height:calc(100dvh - 350px);min-height:330px;background:var(--raised);padding:24px 16px;border-top:1px solid var(--line)}
.flow-map{position:relative;display:flex;gap:110px;width:max-content;transform-origin:top left;padding:12px 0}.flow-space{min-width:100%}.flow-column{display:flex;flex-direction:column;justify-content:center;gap:60px;width:232px;flex:none}
.flow-node{position:relative;width:232px;border:1px solid var(--control-line);border-radius:10px;background:var(--surface);z-index:1;overflow:hidden}.flow-node[data-selected=true]{border:2px solid var(--blue)}.flow-node[data-targetable=true]{border-style:dashed;border-color:var(--blue)}.flow-node-header{display:flex;align-items:center;gap:8px;padding:8px 10px 0}.flow-node-header .button{margin-left:auto;border:0;background:transparent}.flow-number{display:grid;place-items:center;width:22px;height:22px;background:var(--raised);border-radius:6px;font-size:12px;font-variant-numeric:tabular-nums}.flow-status{font-size:11px;color:var(--amber);font-weight:600}.flow-status[data-ready=true]{color:var(--muted)}
.flow-select{border:0;background:transparent;color:var(--ink);font:inherit;display:grid;gap:8px;padding:10px 12px 14px;text-align:left;width:100%;cursor:pointer}.flow-select:hover{background:var(--hover)}.flow-select strong{font-size:14px;line-height:1.35;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.flow-select span{font-size:12px;color:var(--muted);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}.flow-select small{font-size:11px;color:var(--muted)}
.flow-node-outputs{border-top:1px solid var(--line)}.flow-output{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;padding:8px 12px;font:inherit;font-size:11px;color:var(--blue);background:var(--surface);border:0;text-align:left;cursor:pointer}.flow-output span:first-child{overflow-wrap:anywhere}.flow-output:hover,.flow-output[aria-pressed=true]{background:var(--selection)}.flow-socket{width:9px;height:9px;border:2px solid var(--blue);border-radius:50%;flex:none}.flow-output[aria-pressed=true] .flow-socket{background:var(--blue)}
.flow-node-inputs{padding:6px 12px;background:var(--raised);border-top:1px solid var(--line)}.flow-node-inputs button{border:0;background:transparent;color:var(--muted);font:inherit;font-size:10px;padding:3px 0;display:flex;align-items:center;gap:5px;text-align:left;cursor:pointer;width:100%}.flow-node-inputs button span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.flow-node-inputs .ui-icon{width:12px;height:12px;flex:none}
.flow-links{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.flow-wire{fill:none;stroke:var(--control-line);stroke-width:1.5}.flow-wire-label{font:10px var(--body);fill:var(--muted);text-anchor:middle;paint-order:stroke;stroke:var(--raised);stroke-width:5px;stroke-linejoin:round}
.flow-action-bar{padding:10px 16px;border-bottom:1px solid var(--line);background:var(--selection);font-size:12px}.flow-action-bar>span{display:block;margin-bottom:8px;overflow-wrap:anywhere}
.flow-inspector .setup-connections .setup-choice{display:grid;gap:5px}.flow-inspector .setup-connections .setup-choice span{font-size:11px}
.flow-inspector-head{display:flex;align-items:start;justify-content:space-between;gap:12px;padding:14px 16px 8px}.flow-inspector-head h2{font-size:14px;margin:0;overflow-wrap:anywhere;line-height:1.4}.flow-inspector-head .button{flex:none}.flow-inspector>.section-tabs{margin:0 12px;border-bottom:1px solid var(--line);gap:0}.flow-inspector>.section-tabs .button{padding-inline:10px;font-size:11px}.flow-inspector-body{padding:16px;max-height:calc(100dvh - 400px);overflow:auto;min-height:260px}
.flow-inspector .setup-panel,.flow-inspector-body>.panel{border:0;padding:0;border-radius:0;background:transparent;box-shadow:none}.flow-inspector .setup-prompt-row,.flow-inspector .setup-columns{display:block;margin:0}.flow-inspector .phase-picker,.flow-inspector .setup-footer,.flow-inspector .setup-context{display:none}.flow-inspector .setup-section-heading{margin-bottom:10px}.flow-inspector .setup-section-heading h3{font-size:13px}.flow-inspector[data-inspector-tab=question] .setup-columns,.flow-inspector[data-inspector-tab=cohort] .setup-prompt-row,.flow-inspector[data-inspector-tab=answer] .setup-prompt-row{display:none}.flow-inspector[data-inspector-tab=cohort] .setup-columns>section:last-child,.flow-inspector[data-inspector-tab=answer] .setup-columns>section:first-child{display:none}.flow-inspector[data-inspector-tab=cohort] [aria-label="Questions in this step"],.flow-inspector[data-inspector-tab=answer] [aria-label="Questions in this step"]{display:none}.flow-inspector .setup-types{gap:6px}.flow-inspector .setup-types .button{font-size:11px;padding-inline:8px}.flow-inspector .setup-cohort-row .setup-choice{padding:10px}.flow-inspector .setup-cohort-row .setup-choice strong{font-size:12px}.flow-inspector .setup-cohort-row>.cohort-details{font-size:11px;margin-right:4px;padding-inline:4px}.flow-connections h3{margin:0 0 12px;font-size:13px}.flow-connection-row{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:10px 0}.flow-connection-row>div{flex:1;min-width:0}.flow-connection-row strong{font-size:12px;overflow-wrap:anywhere;display:block}.flow-connection-row span{font-size:11px;color:var(--muted);display:block}.flow-connection-row .button{flex:none}
.flow-output-text{display:grid;gap:3px;min-width:0}.flow-output-text strong{display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600}.flow-output-text strong .ui-icon{width:12px;height:12px}.flow-output-text>span{font-size:10px;color:var(--muted);line-height:1.4}.flow-output{min-height:46px}.flow-destination{display:flex;align-items:center;justify-content:center;gap:6px;width:calc(100% - 20px);margin:0 10px 10px;padding:8px 10px;border:1px solid var(--blue);border-radius:6px;background:var(--selection);color:var(--blue);font:inherit;font-size:12px;font-weight:600;cursor:pointer}.flow-destination:hover{background:var(--hover)}.flow-destination .ui-icon{width:14px;height:14px}.flow-hint>span{flex:1;min-width:160px}.flow-hint strong{color:var(--ink)}.flow-hint .button{flex:none}.flow-node[data-targetable=true]{box-shadow:0 0 0 2px var(--selection)}.flow-input-picker{padding-top:20px}.flow-input-choice{display:flex;align-items:center;gap:10px;text-align:left;width:100%;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--ink);padding:10px;margin-bottom:8px;font:inherit;cursor:pointer}.flow-input-choice:hover{border-color:var(--blue);background:var(--selection)}.flow-input-choice>span{flex:1;min-width:0;display:grid;gap:4px}.flow-input-choice strong{font-size:12px;overflow-wrap:anywhere}.flow-input-choice small{color:var(--muted);font-size:11px}.flow-input-choice>.ui-icon{width:14px;height:14px;flex:none}
@media(max-width:1000px){.flow-workspace{grid-template-columns:minmax(0,1fr) 320px}.flow-toolbar{flex-wrap:wrap;gap:8px}.flow-toolbar h2{flex:1}}
@media(max-width:760px){.flow-workspace{grid-template-columns:minmax(0,1fr)}.flow-viewport{min-height:240px;max-height:350px}.flow-inspector-body{max-height:none;min-height:0}.flow-inspector-head h2{font-size:14px}.flow-toolbar{padding:10px 12px}.flow-hint{padding:8px 12px}.flow-column,.flow-node{width:216px}.flow-map{gap:100px}.flow-inspector>.section-tabs .button{flex:1}}
`;
