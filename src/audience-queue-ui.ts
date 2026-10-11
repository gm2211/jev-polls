/**
 * Audiences the assistant asked the app to generate instead of drafting inline. After the proposal is applied each one becomes the
 * normal "Create the audience" job of its step, one at a time. The queue lives in sessionStorage so a reload keeps it.
 */
export const AUDIENCE_QUEUE_CLIENT = String.raw`
function audienceKey(){return 'jev-audience-queue:'+location.origin+':'+S.projectId}
function audienceState(){
  if(S.audience&&S.audience.projectId===S.projectId)return S.audience;
  let saved=null;try{saved=JSON.parse(sessionStorage.getItem(audienceKey())||'null')}catch{}
  S.audience={projectId:S.projectId,queue:Array.isArray(saved?.queue)?saved.queue:[],active:saved?.active&&typeof saved.active.cohortId==='string'?saved.active:null};
  return S.audience;
}
function audienceSave(){const a=audienceState();try{if(a.queue.length||a.active)sessionStorage.setItem(audienceKey(),JSON.stringify({queue:a.queue,active:a.active}));else sessionStorage.removeItem(audienceKey())}catch{}}
function audienceAdd(requests){const a=audienceState();for(const request of requests||[])if(!a.queue.some(x=>x.cohortId===request.cohortId))a.queue.push(request);audienceSave()}
function audienceQueued(){return audienceState().queue}
function audiencePeople(n){return n.toLocaleString('en-US')+(n===1?' person':' people')}
function audienceProposalList(job){
  const requests=job?.proposal?.audienceRequests;if(!requests?.length)return '';
  return '<div class="notice proposal-audiences" role="note"><ul>'+requests.map(r=>'<li>Will generate: <strong>'+esc(r.name)+'</strong> · '+esc(audiencePeople(r.size))+'</li>').join('')+'</ul><p class="subtle">'+(requests.length===1?'After you apply, the audience is drafted in its step, and you review it before it is used.':'After you apply, each audience is drafted in its own step, one at a time, and you review each before it is used.')+' The people are synthetic assumptions.</p></div>';
}
/** The prompt the audience is generated from: the brief, the attributes and segments the assistant named, and the question-independence rule. */
function audienceBrief(request){
  const parts=[String(request.description||'').trim()];
  if(request.attributes?.length)parts.push('Structured attributes every persona must carry: '+request.attributes.join(', ')+'. Fill each one for every person, and vary them within each segment so people in one segment do not all look alike.');
  if(request.segments?.length)parts.push('Segments: '+request.segments.map(s=>s.label+(s.share?' (about '+s.share+'%)':'')).join('; ')+'. Give every persona one of these segments.');
  parts.push('Personas are independent of the questions asked later: give nobody a preference for or against any option, name or product being compared.');
  return parts.filter(Boolean).join('\n\n');
}
function audienceStepFor(step){
  const p=projectPipelines().find(x=>x.id===step?.pipelineId),stage=p?.stages.find(x=>x.id===step?.stageId&&x.kind==='poll');
  return p&&stage&&!p.cohorts?.[stage.cohort]?{p,stage}:null;
}
/** Starts the next queued audience in its step, unless another draft is running or waiting for a decision. */
async function audienceNext(){
  const a=audienceState();
  if(!a.queue.length||!project()||S.localStarting||S.localLoading||S.localJob?.status==='running'||(S.localJob?.status==='completed'&&!S.proposalApplied))return false;
  while(a.queue.length){
    const request=a.queue.shift(),steps=request.steps.map(audienceStepFor).map((found,i)=>found?request.steps[i]:null).filter(Boolean);
    if(!steps.length||S.doc.cohorts.some(c=>c.id===request.cohortId)){audienceSave();continue}
    const found=audienceStepFor(steps[0]);
    a.active={cohortId:request.cohortId,name:request.name,steps:steps.slice(1)};audienceSave();
    S.cohortInlineTarget={pipelineId:found.p.id,stageId:found.stage.id};S.cohortTarget=request.cohortId;S.cohortPrompt=audienceBrief(request).slice(0,10000);S.cohortSize=request.size;S.cohortLastSize=request.size;
    S.cohortComposer=true;S.cohortAttempted=false;S.sections['cohort-generation']='review';S.localError=null;
    returnToInlineCohortStep();render();
    say('Drafting the audience for this step: '+request.name+' · '+audiencePeople(request.size)+'.');
    await startCohortJob();
    return true;
  }
  return false;
}
function audienceResume(){if(audienceState().queue.length&&!S.localJob&&!S.localStarting)void audienceNext().catch(fail)}
/** After an accepted audience: also gives it to any other step that asked for it, then clears it as the active request. */
function audienceAccepted(cohortId){
  const a=audienceState();if(a.active?.cohortId!==cohortId)return;
  for(const step of a.active.steps||[]){const found=audienceStepFor(step);if(found)assignSetupCohort(found.p,found.stage,cohortId)}
  a.active=null;audienceSave();
}
function audienceNote(){
  const a=audienceState(),job=S.localJob?.cohort,active=a.active&&job&&a.active.cohortId===job.id;
  if(!active&&!a.queue.length)return '';
  return '<div class="notice audience-queue-note" role="status">'+(active?'<p><strong>Drafting from your description:</strong> '+esc(a.active.name)+' · '+esc(audiencePeople(job.size))+'. Use this audience when it is ready.</p>':'')+(a.queue.length?'<p class="subtle">Next, one at a time: '+a.queue.map(r=>esc(r.name)+' · '+esc(audiencePeople(r.size))).join('; ')+'.</p>':'')+'</div>';
}
`;
