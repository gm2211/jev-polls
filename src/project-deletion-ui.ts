/** Project deletion uses the same explicit draft/save boundary as cohort deletion. */
export const PROJECT_DELETION_DIALOG = `<dialog id="deleteProjectDialog" class="auth-dialog" aria-labelledby="deleteProjectTitle" aria-describedby="deleteProjectDescription deleteProjectImpact"><h2 id="deleteProjectTitle">Delete project?</h2><p id="deleteProjectDescription"></p><p id="deleteProjectImpact" class="subtle">Saved run files stay on this machine; the deletion is kept when you save.</p><div class="row"><button type="button" class="button" data-act="delete-project-close" autofocus>Cancel</button><button type="button" class="button danger" data-act="delete-project-confirm">Delete project</button></div></dialog>`;

export const PROJECT_DELETION_CLIENT = String.raw`
function projectDeletionGuard(target){
  if(S.localStarting||S.localLoading)throw Error('Wait for drafting status to finish loading before deleting a project.');
  if(S.snap.activeRun?.projectId===target.id)throw Error('Wait for the active study to finish before deleting its project.');
  const job=target.id===S.projectId?S.localJob:S.projectViews[target.id]?.localJob;
  if(job?.status==='running'||[...optionAgentDrafts.values()].some(d=>d.projectId===target.id&&(d.starting||d.job?.status==='running')))throw Error('Open this project to check or cancel its drafting job before deleting it.');
}
function requestProjectDeletion(projectId){
  const target=S.doc.projects.find(p=>p.id===projectId);if(!target)return;
  projectDeletionGuard(target);
  S.projectDeletion={id:target.id,revision:S.revision,signature:JSON.stringify(target)};
  document.getElementById('deleteProjectDescription').textContent='Remove “'+target.name+'”, '+target.cohortIds.length+' cohort'+(target.cohortIds.length===1?'':'s')+' and '+target.pipelineIds.length+' stud'+(target.pipelineIds.length===1?'y':'ies')+' from this draft?';
  document.getElementById('deleteProjectDialog').showModal();
}
function deleteProjectFromDraft(){
  const pending=S.projectDeletion;if(!pending)return;
  const target=S.doc.projects.find(p=>p.id===pending.id);
  if(pending.revision!==S.revision||S.remoteRevision!==null||!target||JSON.stringify(target)!==pending.signature)throw Error('Workspace changed. Close this dialog and review the project before deleting.');
  projectDeletionGuard(target);
  const cohorts=new Set(target.cohortIds),pipelines=new Set(target.pipelineIds);
  S.doc.projects=S.doc.projects.filter(p=>p.id!==target.id);
  S.doc.cohorts=S.doc.cohorts.filter(c=>!cohorts.has(c.id));
  S.doc.pipelines=S.doc.pipelines.filter(p=>!pipelines.has(p.id));
  for(const [key,d] of optionAgentDrafts)if(d.projectId===target.id)optionAgentDrafts.delete(key);
  if(optionAgentDraft?.projectId===target.id)optionAgentDraft=null;
  if(answerListDraft?.projectId===target.id)closeAnswerList();
  if(pipelines.has(S.flowSource?.pipelineId)){S.flowSource=null;S.flowAdd=null;}
  try{sessionStorage.removeItem('jev-local-job:'+location.origin+':'+target.id);sessionStorage.removeItem('jev-local-job-target:'+location.origin+':'+target.id)}catch{}
  S.projectDeletion=null;S.plan=null;S.dirty=true;
  document.getElementById('deleteProjectDialog').close();
  if(S.projectId===target.id)selectProject(null);else render();
  delete S.projectViews[target.id];
  for(const key of Object.keys(S.listPages))if(key.startsWith(target.id+':'))delete S.listPages[key];
  say('Project removed from draft. Save changes to keep the deletion.');
}
function projectDeletionAction(a,el){
  if(a==='delete-project'){requestProjectDeletion(el.dataset.id);return true}
  if(a==='delete-project-close'){S.projectDeletion=null;document.getElementById('deleteProjectDialog').close();return true}
  if(a==='delete-project-confirm'){deleteProjectFromDraft();return true}
  return false;
}
`;
