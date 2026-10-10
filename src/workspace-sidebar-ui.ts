/** Project sidebar: the one place to move between a project's studies, cohorts, runs and settings. */
export const SIDEBAR_CLIENT = String.raw`
const SIDEBAR_STUDY_LIMIT=8;
function sidebarLink(label,act,current,extra='',count=null,sub=false){
  return '<button type="button" class="side-link'+(sub?' side-sub':'')+'" data-act="'+act+'"'+extra+(current?' aria-current="page"':'')+(sub?' title="'+attr(label)+'"':'')+'><span class="side-label">'+esc(label)+'</span>'+(count===null?'':'<span class="side-count">'+count+'</span>')+'</button>';
}
function workspaceSidebar(){
  const p=project();if(!p)return '';
  const studies=projectPipelines(),open=S.tab==='studies'?pipeline():null,shown=studies.slice(0,SIDEBAR_STUDY_LIMIT);
  if(open&&!shown.includes(open))shown.push(open);
  const studyLinks=shown.map(s=>sidebarLink(studyQuestion(s),'side-study',open?.id===s.id,' data-id="'+attr(s.id)+'"',null,true)).join('')
    +(studies.length>shown.length?sidebarLink('All '+plural(studies.length,'study','studies'),'tab',false,' data-tab="studies"',null,true):'');
  return '<nav class="app-sidebar" aria-label="Project">'
    +'<button type="button" class="side-back" data-act="projects" aria-label="All projects">'+icon('left')+'<span>All projects</span></button>'
    +'<div class="side-project" title="'+attr(p.name)+'">'+esc(p.name)+'</div>'
    +'<div class="side-group">'+sidebarLink('Studies','tab',S.tab==='studies'&&!open,' data-tab="studies"',studies.length)+(studyLinks?'<div class="side-children">'+studyLinks+'</div>':'')+'</div>'
    +sidebarLink('Cohorts','tab',S.tab==='cohorts',' data-tab="cohorts"',projectCohorts().length)
    +sidebarLink('Runs','tab',S.tab==='runs',' data-tab="runs"',projectRuns().length)
    +sidebarLink('Settings','project-settings',S.tab==='project-settings')
    +'</nav>';
}
function sidebarAction(a,el){
  if(a!=='side-study')return false;
  if(!projectPipelines().some(p=>p.id===el.dataset.id))return true;
  S.tab='studies';S.plan=null;S.studyComposer=false;S.pipelineId=el.dataset.id;S.stageId=pipeline()?.stages[0]?.id||null;S.sections.pipeline='flow';S.flowSettingsReturn=false;S.flowPanel=false;
  render();root.querySelector('h1')?.focus();return true;
}
`;

export const SIDEBAR_CSS = String.raw`
.app-frame{display:grid;grid-template-columns:224px minmax(0,1fr);align-items:start;min-height:calc(100dvh - 56px)}
.app-frame>.shell{min-width:0;width:100%}
.app-sidebar{position:sticky;top:0;align-self:stretch;max-height:calc(100dvh - 56px);overflow:auto;display:flex;flex-direction:column;gap:2px;padding:16px 12px;background:var(--raised);border-right:1px solid var(--line)}
.side-back{appearance:none;display:flex;align-items:center;gap:6px;min-height:36px;padding:0 10px;border:0;border-radius:var(--radius-control,6px);background:transparent;color:var(--muted);font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-align:left}
.side-back:hover{color:var(--ink);background:var(--hover)}.side-back .ui-icon{width:14px;height:14px}
.side-project{margin:10px 10px 8px;font:600 15px/1.3 var(--display);letter-spacing:-.01em;color:var(--ink);overflow-wrap:anywhere}
/* minmax(0,1fr) stops a long nowrap label from widening the track past the sidebar, so the label can ellipsize. */
.side-group{display:grid;grid-template-columns:minmax(0,1fr);gap:2px}.side-children{display:grid;grid-template-columns:minmax(0,1fr);gap:1px;margin:0 0 4px}
.side-link{appearance:none;display:flex;min-width:0;align-items:center;justify-content:space-between;gap:8px;width:100%;min-height:40px;padding:0 10px;border:0;border-radius:var(--radius-control,6px);background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;text-align:left;cursor:pointer}
.side-link:hover{background:var(--hover);color:var(--ink)}
.side-link[aria-current=page]{background:var(--surface);color:var(--ink);box-shadow:inset 3px 0 0 var(--blue)}
.side-link.side-sub{min-height:34px;padding-left:22px;font-size:12px;font-weight:500}
.side-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side-count{flex:none;font:500 11px var(--numeric,var(--body));font-variant-numeric:tabular-nums;color:var(--faint)}
.side-back:focus-visible,.side-link:focus-visible{outline:2px solid var(--focus,var(--blue));outline-offset:-2px}
@media(max-width:800px){
  .app-frame{grid-template-columns:minmax(0,1fr);min-height:0}
  .app-sidebar{position:static;max-height:none;flex-direction:row;flex-wrap:nowrap;align-items:center;gap:2px;padding:4px 8px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}
  .side-link[aria-current=page]{box-shadow:inset 0 -3px 0 var(--blue)}.side-back span{display:none}
  .side-project{display:none}.side-group{display:contents}.side-children{display:none}
  .side-link{width:auto;flex:none;min-height:44px}.side-back{min-height:44px}
}
`;
