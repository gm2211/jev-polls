/** Step deletion: one path for the step panel, the canvas card and the Delete key. Confirmed in a dialog, undone from the toast or with Cmd/Ctrl+Z. */
export const STEP_DELETION_DIALOG = `<dialog id="deleteStepDialog" class="auth-dialog" aria-labelledby="deleteStepTitle" aria-describedby="deleteStepDescription deleteStepImpact"><h2 id="deleteStepTitle">Delete step?</h2><p id="deleteStepDescription"></p><p id="deleteStepImpact" class="subtle"></p><div class="row"><button type="button" class="button" data-act="step-delete-close" autofocus>Cancel</button><button type="button" class="button danger" data-act="step-delete-confirm">Delete step</button></div></dialog>`;

export const STEP_DELETION_CLIENT = String.raw`
function stepDeleteButton(p,s,extra){return '<button type="button" class="button small icon-button step-delete'+(extra?' '+extra:'')+'" data-act="step-delete" data-id="'+attr(s.id)+'" aria-label="Delete step: '+attr(stepTitle(p,s))+'" title="Delete step (Del)">'+icon('trash')+'</button>'}
function conditionMentions(c,id){if(!c)return false;if(c.all||c.any)return (c.all||c.any).some(x=>conditionMentions(x,id));if(c.not)return conditionMentions(c.not,id);return c.stage===id}
/** Drops the rules that read a deleted step; a group left with one rule becomes that rule, an empty one disappears. */
function conditionWithout(c,id){
  if(!c)return undefined;
  if(c.all||c.any){const key=c.all?'all':'any',kept=c[key].map(x=>conditionWithout(x,id)).filter(Boolean);return kept.length>1?{[key]:kept}:kept[0]}
  if(c.not){const inner=conditionWithout(c.not,id);return inner?{not:inner}:undefined}
  return c.stage===id?undefined:c;
}
/** Steps that use the step in any way: its output, its run order, a branch rule or its options. */
function stepReaders(p,id){return p.stages.filter(x=>x.id!==id&&(x.dependsOn.includes(id)||flowInputs(p,x).some(([,input])=>input.stage===id)||conditionMentions(x.when,id)||Object.values(x.questions||{}).some(q=>q.optionsFrom?.stage===id)))}
/** Removes a step and every reference to it. Later steps stay and lose only what they read from it. */
function removeStep(p,id){
  p.stages=p.stages.filter(x=>x.id!==id);if(p.layout)delete p.layout[id];
  for(const s of p.stages){
    s.dependsOn=s.dependsOn.filter(x=>x!==id);
    if((s.kind==='poll'||s.kind==='choose')&&s.inputs)for(const [key,input] of Object.entries(s.inputs))if(input.stage===id)delete s.inputs[key];
    if(s.kind==='aggregate')s.inputs=s.inputs.filter(input=>input.stage!==id);
    if(s.kind==='decision'&&s.from?.stage===id)s.from={stage:'',question:''};
    if(conditionMentions(s.when,id)){const when=conditionWithout(s.when,id);if(when)s.when=when;else delete s.when}
    // Options taken from the deleted step stay as typed options.
    for(const q of Object.values(s.questions||{}))if(q.optionsFrom?.stage===id)delete q.optionsFrom;
  }
}
function requestStepDeletion(stageId){
  const p=pipeline(),s=p?.stages.find(x=>x.id===stageId);if(!s)return;
  const readers=stepReaders(p,s.id).map(x=>p.stages.indexOf(x)+1).sort((a,b)=>a-b);
  S.stepDeletion={pipelineId:p.id,id:s.id};
  document.getElementById('deleteStepDescription').textContent='Remove step '+(p.stages.indexOf(s)+1)+', “'+stepTitle(p,s).replace(/^\d+\. /,'')+'”?';
  document.getElementById('deleteStepImpact').textContent=(readers.length?(readers.length===1?'Step ':'Steps ')+readers.join(', ')+' will stay but stop reading from it. ':'No other step reads from it. ')+'You can undo this.';
  document.getElementById('deleteStepDialog').showModal();
}
function deleteStep(){
  const pending=S.stepDeletion;S.stepDeletion=null;document.getElementById('deleteStepDialog').close();
  const p=pipeline(),s=p?.id===pending?.pipelineId&&p.stages.find(x=>x.id===pending.id);if(!s)return;
  const n=p.stages.indexOf(s)+1,title=stepTitle(p,s).replace(/^\d+\. /,'');
  const undo={pipelineId:p.id,stages:clone(p.stages),position:p.layout?.[s.id]?clone(p.layout[s.id]):null,stageId:s.id,flowPanel:S.flowPanel,tab:S.sections['flow-inspector']};
  removeStep(p,s.id);undo.after=JSON.stringify(p.stages);
  S.stepUndo=[...(S.stepUndo||[]).slice(-19),undo];
  if(S.flowSource?.stage===s.id)S.flowSource=null;
  if(S.flowAdd===s.id)S.flowAdd=null;
  if(S.cohortInlineTarget?.stageId===s.id)S.cohortInlineTarget=null;
  if(S.stageId===s.id){S.stageId=p.stages[Math.min(n-1,p.stages.length-1)]?.id||null;S.flowPanel=false}
  S.reviewPanel=false;S.plan=null;S.dirty=true;render();
  root.querySelector('.flow-viewport')?.focus({preventScroll:true});
  sayUndo('Deleted step '+n+': '+title+'.');
}
/** Undo puts the step back only while the study is as the deletion left it, so it never discards a later edit. */
function undoStepDeletion(){
  const undo=S.stepUndo?.at(-1);if(!undo)return false;
  if(undo.kind==='assistant')return undoAssistantProposal(undo);
  const p=S.doc.pipelines.find(x=>x.id===undo.pipelineId);
  if(!p||JSON.stringify(p.stages)!==undo.after){S.stepUndo=[];say('The study changed after that delete, so it can no longer be undone.');return true}
  S.stepUndo.pop();
  p.stages=undo.stages;if(undo.position){p.layout??={};p.layout[undo.stageId]=undo.position}
  S.pipelineId=p.id;S.stageId=undo.stageId;S.flowPanel=undo.flowPanel;if(undo.tab)S.sections['flow-inspector']=undo.tab;
  S.plan=null;S.dirty=true;render();
  root.querySelector('[data-flow-node="'+undo.stageId+'"] [data-act=flow-select]')?.focus({preventScroll:true});
  say('Step restored.');return true;
}
function stepDeletionAction(a,el){
  if(a==='step-delete'){requestStepDeletion(el.dataset.id);return true}
  if(a==='step-delete-close'){S.stepDeletion=null;document.getElementById('deleteStepDialog').close();return true}
  if(a==='step-delete-confirm'){deleteStep();return true}
  if(a==='step-undo'){toast.classList.remove('show','actionable');undoStepDeletion();return true}
  return false;
}
const editingText=t=>!!t?.closest?.('input,textarea,select,[contenteditable=""],[contenteditable=true]');
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented||e.isComposing||document.querySelector('dialog[open]'))return;
  if(e.key==='z'||e.key==='Z'){
    if(!(e.metaKey||e.ctrlKey)||e.shiftKey||e.altKey||editingText(e.target)||!S.stepUndo?.length)return;
    e.preventDefault();undoStepDeletion();return;
  }
  if((e.key!=='Delete'&&e.key!=='Backspace')||e.metaKey||e.ctrlKey||e.altKey||editingText(e.target))return;
  // A focused card, or the selected card while the canvas itself has focus.
  const node=e.target?.closest?.('.flow-board [data-flow-node]'),onCanvas=e.target?.classList?.contains('flow-viewport');
  const id=node?.dataset.flowNode||(onCanvas&&root.querySelector('.flow-board [data-flow-node][data-selected=true]')?.dataset.flowNode);
  if(!id)return;
  e.preventDefault();requestStepDeletion(id);
});
`;

export const STEP_DELETION_CSS = String.raw`
.toast.actionable{pointer-events:auto;display:flex;align-items:center;gap:14px}
.toast .toast-action{border:0;background:transparent;color:#fff;font:inherit;font-weight:700;text-decoration:underline;text-underline-offset:3px;cursor:pointer;padding:2px 4px;border-radius:4px}
.toast .toast-action:focus-visible{outline:2px solid #fff;outline-offset:2px}
.flow-inspector-head .step-delete{color:var(--muted)}
.flow-inspector-head>.row{flex-wrap:nowrap}
.flow-inspector-head .step-delete:hover,.flow-inspector-head .step-delete:focus-visible{color:var(--red);background:color-mix(in srgb,var(--red) 10%,var(--surface))}
.flow-node-header .button.small.step-delete{display:none;flex:none;margin-left:-2px;width:26px;height:26px;min-height:26px;padding:4px;border:0;background:transparent;color:var(--muted)}
.flow-node-header .step-delete svg{width:15px;height:15px}
/* Cards are narrow, so the canvas shows delete only on the card being pointed at or worked in; phones list full-width cards and always show it. */
.flow-node:hover .button.small.step-delete,.flow-node:focus-within .button.small.step-delete,.flow-list .flow-node .button.small.step-delete{display:inline-flex}
@media(hover:none){.flow-node[data-selected=true] .button.small.step-delete{display:inline-flex}}
.flow-node-header .step-delete:hover,.flow-node-header .step-delete:focus-visible{color:var(--red);background:color-mix(in srgb,var(--red) 10%,var(--surface))}
`;
