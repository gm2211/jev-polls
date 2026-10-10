/** Keeps the open view in the URL hash so a browser reload returns to the same project, tab, study, cohort, or run. */
export const LOCATION_CLIENT = String.raw`
function locationParams(){try{return new URLSearchParams(String(location.hash||'').replace(/^#/,''))}catch{return new URLSearchParams()}}
const initialLocation=locationParams();
function locationHash(){
  const p=project();if(!p||S.projectComposer)return '';
  const q=new URLSearchParams({project:p.id,tab:['studies','cohorts','runs','project-settings'].includes(S.tab)?S.tab:'studies'});
  if(q.get('tab')==='studies'&&pipeline()){q.set('study',S.pipelineId);if(S.stageId)q.set('step',S.stageId);if(liveStudyRun())q.set('live',S.liveRunId)}
  if(q.get('tab')==='cohorts'&&cohort()&&!S.cohortComposer){q.set('cohort',S.cohortId);if(S.personaOpen&&S.personId)q.set('person',S.personId)}
  if(q.get('tab')==='runs'&&S.liveRunId)q.set('run',S.liveRunId);
  return '#'+q;
}
function syncLocation(){if(!S.doc)return;try{const first=!S.locationReady;S.locationReady=true;const hash=locationHash(),current=location.hash||'';if(hash===current)return;const target=hash||location.pathname+location.search;if(S.locationRestoring||first)history.replaceState(null,'',target);else history.pushState(null,'',target)}catch{}}
function restoreLocation(q=initialLocation){
  const id=q.get('project');if(!id||!S.doc?.projects?.some(p=>p.id===id))return false;
  S.locationRestoring=true;
  try{
    selectProject(id,true);
    const tab=q.get('tab');if(['studies','cohorts','runs','project-settings'].includes(tab))S.tab=tab;
    S.cohortComposer=false;S.personaOpen=false;S.cohortId=null;S.personId=null;S.liveRunId=null;S.liveInline=false;
    const study=q.get('study');if(S.tab==='studies'&&projectPipelines().some(p=>p.id===study)){S.pipelineId=study;S.studyLibrary=false;S.stageId=q.get('step')}
    const live=q.get('live');if(S.tab==='studies'&&S.pipelineId&&projectRuns().some(r=>r.id===live&&r.pipelineId===S.pipelineId)){S.liveRunId=live;S.liveInline=true}
    const c=projectCohorts().find(x=>x.id===q.get('cohort'));if(S.tab==='cohorts'&&c){S.cohortId=c.id;const person=c.personas.find(x=>x.id===q.get('person'));if(person){S.personId=person.id;S.personaOpen=true}}
    const run=q.get('run');if(S.tab==='runs'&&(run==='history'||projectRuns().some(r=>r.id===run)))S.liveRunId=run;
    retainSelections();render();
  }finally{S.locationRestoring=false}
  return true;
}
// The browser's Back and Forward buttons replay the hash this file wrote, so they move between views instead of leaving the workspace.
window.addEventListener('popstate',()=>{
  if(!S.doc)return;
  S.locationRestoring=true;
  try{try{flushForms()}catch(error){fail(error)}if(!restoreLocation(locationParams()))selectProject(null)}
  catch(error){fail(error)}
  finally{S.locationRestoring=false}
});
`;
