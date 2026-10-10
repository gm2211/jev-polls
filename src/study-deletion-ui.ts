/** Study deletion: a quick delete on each study row, confirmed in a dialog, removed from the draft until saved. */
export const STUDY_DELETION_DIALOG = `<dialog id="deleteStudyDialog" class="auth-dialog" aria-labelledby="deleteStudyTitle" aria-describedby="deleteStudyDescription deleteStudyImpact"><h2 id="deleteStudyTitle">Delete study?</h2><p id="deleteStudyDescription"></p><p id="deleteStudyImpact" class="subtle">Cohorts and past reports stay; the deletion is kept when you save.</p><div class="row"><button type="button" class="button" data-act="delete-study-close" autofocus>Cancel</button><button type="button" class="button danger" data-act="delete-study-confirm">Delete study</button></div></dialog>`;

export const STUDY_DELETION_CLIENT = String.raw`
function studyDeleteButton(p){return '<button type="button" class="button small danger icon-button list-delete study-delete" data-act="delete-study" data-id="'+attr(p.id)+'" aria-label="Delete study: '+attr(studyQuestion(p))+'" title="Delete study">'+icon('trash')+'</button>'}
function studyDeletionGuard(target){
  if(S.snap.activeRun?.pipelineId===target.id)throw Error('Wait for this study’s run to finish before deleting it.');
}
function requestStudyDeletion(pipelineId){
  const target=projectPipelines().find(p=>p.id===pipelineId);if(!target)return;
  studyDeletionGuard(target);
  S.studyDeletion={id:target.id,revision:S.revision};
  document.getElementById('deleteStudyDescription').textContent='Remove “'+studyQuestion(target)+'” and its '+target.stages.length+' step'+(target.stages.length===1?'':'s')+' from this draft?';
  document.getElementById('deleteStudyDialog').showModal();
}
function deleteStudyFromDraft(){
  const pending=S.studyDeletion;if(!pending)return;
  const target=S.doc.pipelines.find(p=>p.id===pending.id);
  if(pending.revision!==S.revision||S.remoteRevision!==null||!target)throw Error('Workspace changed. Close this dialog and review the study before deleting.');
  studyDeletionGuard(target);
  S.doc.pipelines=S.doc.pipelines.filter(p=>p.id!==target.id);
  for(const pr of S.doc.projects)pr.pipelineIds=pr.pipelineIds.filter(id=>id!==target.id);
  if(S.pipelineId===target.id){S.pipelineId=null;S.stageId=null;}
  if(S.flowSource?.pipelineId===target.id){S.flowSource=null;S.flowAdd=null;}
  if(S.cohortInlineTarget?.pipelineId===target.id)S.cohortInlineTarget=null;
  if(S.cohortReturn?.pipelineId===target.id)S.cohortReturn=null;
  if(S.studyTitleEdit===target.id)S.studyTitleEdit=null;
  if(answerListDraft?.pipelineId===target.id)closeAnswerList();
  S.studyDeletion=null;S.plan=null;S.dirty=true;
  document.getElementById('deleteStudyDialog').close();render();
  (root.querySelector('.list-open')||root.querySelector('.empty-create'))?.focus();
  say('Study removed from draft. Save changes to keep the deletion.');
}
function studyDeletionAction(a,el){
  if(a==='delete-study'){requestStudyDeletion(el.dataset.id);return true}
  if(a==='delete-study-close'){S.studyDeletion=null;document.getElementById('deleteStudyDialog').close();return true}
  if(a==='delete-study-confirm'){deleteStudyFromDraft();return true}
  return false;
}
`;

export const STUDY_DELETION_CSS = String.raw`
.study-list .study-list-item{display:flex;align-items:center;min-width:0;border-bottom:1px solid var(--line);transition:background 160ms ease-out}
.study-list-item>.study-delete:hover{background:color-mix(in srgb,var(--red) 10%,var(--surface));color:var(--red)}
@media(max-width:600px){.study-list-item>.study-delete{margin-right:4px}}
`;
