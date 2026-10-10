/** One-click creation: empty lists are the create control, and a new study is named on its own page. Inline edits save on Enter and discard on Esc or click-away, so the page's Save stays the only save button. */
export const STUDY_START_CLIENT = String.raw`
function emptyCreate(act,title,hint){
  return '<button type="button" class="empty-create" data-act="'+act+'"><span class="empty-create-plus" aria-hidden="true">'+icon('plus')+'</span><strong>'+esc(title)+'</strong><span class="empty-create-hint">'+esc(hint)+'</span></button>';
}
function createRow(act,label,cls=''){return '<button type="button" class="create-row '+cls+'" data-act="'+act+'">'+icon('plus')+'<span>'+esc(label)+'</span></button>'}
function createStudy(){
  const p=freshPipeline('');p.name='Study '+(projectPipelines().length+1);
  S.doc.pipelines.push(p);ownPipeline(p);
  S.tab='studies';S.plan=null;S.studyComposer=false;S.pipelineId=p.id;S.stageId=p.stages[0]?.id||null;
  S.sections.pipeline='flow';S.studyTitleEdit=p.id;S.dirty=true;
  render();const input=root.querySelector('[data-form=study-title] [name=question]');input?.focus();
}
function studyTitle(p){
  if(S.studyTitleEdit!==p.id)return '<div class="study-title"><h1 tabindex="-1">'+esc(studyQuestion(p))+'</h1><button type="button" class="button small icon-button study-title-edit" data-act="study-title-edit" aria-label="Edit study question" title="Edit study question">'+icon('edit')+'</button><button type="button" class="button small icon-button study-title-edit" data-act="section-view" data-section-key="pipeline" data-section-id="context" aria-label="Study settings" title="Study settings">'+icon('settings')+'</button></div>';
  const question=p.description?.trim()||'';
  return '<form class="study-title study-title-form" data-form="study-title" data-id="'+attr(p.id)+'" data-inline-edit="study-title-cancel"><h1 class="visually-hidden" tabindex="-1">'+esc(studyQuestion(p))+'</h1><input name="question" value="'+attr(question)+'" required maxlength="500" placeholder="What do you want to find out?" aria-label="Study question" aria-describedby="inlineEditHint" title="Enter to save · Esc or click away to discard" autocomplete="off">'+inlineEditHint()+'</form>';
}
function inlineEditHint(){return '<span id="inlineEditHint" class="inline-edit-hint">Enter to save · Esc or click away to discard</span>'}
function inlineEditOpen(form){return form.dataset.form==='study-title'?S.studyTitleEdit===form.dataset.id:form.dataset.form==='project-rename'?S.projectRename===form.dataset.id:false}
function inlineEditCancel(form){act(null,{dataset:{act:form.dataset.inlineEdit}})}
root.addEventListener('keydown',e=>{
  const form=e.target.closest?.('[data-inline-edit]');if(!form||e.key!=='Escape')return;
  e.preventDefault();e.stopPropagation();inlineEditCancel(form);
},true);
let inlineEditPointer=null;
root.addEventListener('pointerdown',e=>{inlineEditPointer=e.target.closest?.('[data-act]')||null},true);
document.addEventListener('pointerup',()=>{inlineEditPointer=null},true);
function inlineEditSoftCancel(form){
  /* Re-rendering here would delete the control being pressed and swallow its click, so end the edit first and repaint after the click. */
  if(form.dataset.form==='study-title')S.studyTitleEdit=null;else S.projectRename=null;
  const repaint=()=>{if(form.isConnected)render()};
  document.addEventListener('click',repaint,{once:true});setTimeout(()=>{document.removeEventListener('click',repaint);repaint()},1500);
}
root.addEventListener('focusout',e=>{
  const form=e.target.closest?.('[data-inline-edit]');if(!form||form.contains(e.relatedTarget)||!form.isConnected||!inlineEditOpen(form)||!document.hasFocus())return;
  const control=(e.relatedTarget?.closest?.('[data-act]'))||inlineEditPointer;
  if(control&&!form.contains(control)){inlineEditSoftCancel(form);return}
  inlineEditCancel(form);
});
function submitStudyTitle(form){
  const p=S.doc.pipelines.find(x=>x.id===form.dataset.id);if(!p){S.studyTitleEdit=null;render();return}
  const question=String(new FormData(form).get('question')||'').trim();if(!question)throw Error('Write the question this study should answer.');
  S.studyTitleEdit=null;p.description=question;
  if(p.context&&typeof p.context==='object'&&!Array.isArray(p.context))p.context.decisionQuestion=question;
  const first=p.stages.find(s=>s.kind==='poll'),q=first&&Object.values(first.questions)[0];if(q&&!String(q.label||'').trim())q.label=question;
  S.dirty=true;render();root.querySelector('h1')?.focus();
}
function studyStartAction(a,el){
  if(a==='create-study'){createStudy();return true}
  if(a==='study-title-edit'){S.studyTitleEdit=pipeline()?.id||null;render();const input=root.querySelector('[data-form=study-title] [name=question]');input?.focus();input?.select?.();return true}
  if(a==='study-title-cancel'){S.studyTitleEdit=null;render();root.querySelector('h1')?.focus();return true}
  return false;
}
`;

export const STUDY_START_CSS = String.raw`
.empty-create{appearance:none;display:grid;justify-items:center;align-content:center;gap:8px;width:100%;min-height:240px;padding:32px 20px;border:2px dashed var(--line);border-radius:var(--radius-panel,10px);background:transparent;color:var(--ink);font:inherit;text-align:center;cursor:pointer;transition:border-color 140ms ease-out,background 140ms ease-out}
.empty-create:hover,.empty-create:focus-visible{border-color:var(--blue);background:var(--action)}
.empty-create:focus-visible{outline:2px solid var(--focus,var(--blue));outline-offset:2px}
.empty-create-plus{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;background:var(--action);color:var(--blue)}
.empty-create:hover .empty-create-plus{background:var(--surface)}
.empty-create-plus .ui-icon{width:22px;height:22px}
.empty-create strong{font:600 18px/1.3 var(--display);letter-spacing:-.01em}
.empty-create-hint{max-width:46ch;color:var(--muted);font-size:13px}
.create-row{appearance:none;display:flex;align-items:center;gap:10px;width:100%;min-height:52px;padding:0 20px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:14px;font-weight:600;text-align:left;cursor:pointer}
.create-row:hover{background:var(--hover);color:var(--ink)}.create-row .ui-icon{width:16px;height:16px}
.create-row:focus-visible{outline:2px solid var(--focus,var(--blue));outline-offset:-2px}
.pool-create{min-height:160px;justify-content:center;border:2px dashed var(--line);border-radius:var(--radius-panel,10px)}
.study-title{grid-area:title;display:flex;align-items:center;gap:6px;min-width:0}
.study-title h1{min-width:0}
.study-title-edit{flex:none;background:transparent;border-color:transparent;color:var(--muted)}.study-title-edit:hover{color:var(--ink)}
.study-title-form input{flex:1;min-width:0;font:600 18px/1.3 var(--display);letter-spacing:-.02em}
.inline-edit-hint{flex:none;color:var(--faint);font-size:12px;white-space:nowrap}
@media(max-width:600px){.inline-edit-hint{display:none}}
.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
`;
