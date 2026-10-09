/** Small, draft-safe navigation primitives shared by workspace editors. */
export const NAVIGATION_CLIENT = String.raw`
function workspaceBreadcrumbItems(){
  const items=[{label:'Projects',action:'projects'}],p=project();
  if(!p){if(S.projectComposer)items.push({label:'New project'});return items}
  items.push({label:p.name,action:'project-overview'});
  const section=({studies:'Studies',cohorts:'Cohorts',runs:'Runs',agents:'Assistant','project-settings':'Project settings'})[S.tab]||'Studies';
  items.push({label:section,action:S.tab==='studies'?'back-studies':S.tab==='cohorts'?'back-cohorts':S.tab==='runs'?'live-close':'project-settings'});
  if(S.tab==='studies'){
    const study=pipeline();
    if(study){items.push({label:study.name||studyQuestion(study),action:'edit-review'});if(S.plan)items.push({label:'Review run'})}
    else if(!projectPipelines().length)items.push({label:'New study'});
  }else if(S.tab==='cohorts'){
    const c=S.cohortComposer?projectCohorts().find(c=>c.id===S.cohortTarget):cohort();
    if(c)items.push({label:c.name||'Cohort',action:'breadcrumb-cohort'});
    if(S.cohortComposer)items.push({label:c?'Regenerate personas':'New cohort'});
    else if(c&&S.personaOpen){const person=c.personas.find(person=>person.id===S.personId);if(person)items.push({label:person.label||'Persona'})}
  }else if(S.tab==='runs'){
    const runs=projectRuns(),run=runs.find(r=>r.id===S.liveRunId)||(S.liveRunId!=='history'&&runs.find(r=>r.status==='running'));
    if(run)items.push({label:run.pipelineName+' · '+run.id});
  }
  return items;
}
function workspaceBreadcrumbs(sectionRoot=false){
  // Project tabs sit right under the trail on section pages, so the trail stops at the project instead of repeating the selected tab.
  const items=workspaceBreadcrumbItems();if(sectionRoot&&items.length===3)items.pop();
  return '<nav class="workspace-breadcrumbs" aria-label="Breadcrumb"><ol>'+items.map((item,index)=>'<li>'+(index?'<span class="breadcrumb-separator" aria-hidden="true">/</span>':'')+(index===items.length-1?'<span aria-current="page">'+esc(item.label)+'</span>':'<button type="button" class="breadcrumb-link" data-act="'+attr(item.action)+'">'+esc(item.label)+'</button>')+'</li>').join('')+'</ol></nav>';
}
function viewportPageSize(large,small){return (window.innerWidth||1024)<=600?small:large}
function pageItems(items,key,limit=6){
  const scoped=(S.projectId||'workspace')+':'+key,pages=Math.max(1,Math.ceil(items.length/limit));
  const index=Math.max(0,Math.min(S.listPages[scoped]||0,pages-1));S.listPages[scoped]=index;
  const start=index*limit,end=Math.min(start+limit,items.length);
  const controls=pages>1?'<nav class="pagination" aria-label="'+attr(key)+' pages"><span role="status">'+(items.length?start+1:0)+'–'+end+' of '+items.length+'</span><div class="row"><button type="button" class="button small icon-button" aria-label="Previous page" title="Previous page" data-act="page-action" data-page-key="'+attr(scoped)+'" data-page="'+(index-1)+'" '+(!index?'disabled':'')+'>'+icon('left')+'</button><select class="page-select" aria-label="Go to page" name="listPage" data-page-key="'+attr(scoped)+'">'+Array.from({length:pages},(_,i)=>'<option value="'+i+'" '+(i===index?'selected':'')+'>'+ (i+1)+' / '+pages+'</option>').join('')+'</select><button type="button" class="button small icon-button" aria-label="Next page" title="Next page" data-act="page-action" data-page-key="'+attr(scoped)+'" data-page="'+(index+1)+'" '+(index===pages-1?'disabled':'')+'>'+icon('right')+'</button></div></nav>':'';
  return {items:items.slice(start,end),index,start,end,total:items.length,pages,controls};
}
function sectionTabs(key,options,selected){
  const active=selected||S.sections[key]||options[0]?.id;
  return '<nav class="section-tabs" aria-label="'+attr(key==='pipeline'?'Study':key)+' sections">'+options.map(o=>'<button type="button" class="button small" aria-pressed="'+(active===o.id)+'" data-act="section-view" data-section-key="'+attr(key)+'" data-section-id="'+attr(o.id)+'">'+esc(o.label)+'</button>').join('')+'</nav>';
}
function sectionPanels(key,options){
  const active=options.some(o=>o.id===S.sections[key])?S.sections[key]:options[0]?.id;
  return sectionTabs(key,options,active)+options.map(o=>'<div class="section-panel" data-section-panel data-section-key="'+attr(key)+'" data-section-id="'+attr(o.id)+'" '+(active===o.id?'':'hidden')+'>'+o.html+'</div>').join('');
}
function revealSectionField(field){
  let panel=field.closest?.('[data-section-panel]');
  while(panel){const key=panel.dataset.sectionKey,id=panel.dataset.sectionId;S.sections[key]=id;
    root.querySelectorAll('[data-section-panel]').forEach(p=>{if(p.dataset.sectionKey===key)p.hidden=p.dataset.sectionId!==id});
    root.querySelectorAll('[data-act=section-view]').forEach(b=>{if(b.dataset.sectionKey===key)b.setAttribute('aria-pressed',String(b.dataset.sectionId===id))});
    panel=panel.parentElement?.closest('[data-section-panel]');
  }
}
function navigationAction(a,el){
  if(a==='breadcrumb-cohort'){S.cohortComposer=false;S.personaOpen=false;render();root.querySelector('h1')?.focus();return true}
  if(a==='section-view'){if(S.targetDraft)readTargetForm();S.sections[el.dataset.sectionKey]=el.dataset.sectionId;render();root.querySelectorAll('[data-act=section-view]').forEach(b=>{if(b.dataset.sectionKey===el.dataset.sectionKey&&b.dataset.sectionId===el.dataset.sectionId)b.focus()});drawStageEdges();return true}
  if(a==='page-action'){if(S.targetDraft)readTargetForm();S.listPages[el.dataset.pageKey]=Math.max(0,Number(el.dataset.page));const shares=el.closest?.('[data-form=segment-shares]');if(shares){const page=pageItems(cohort().segments,'segments',viewportPageSize(4,3));shares.querySelectorAll('.segment-weight-row').forEach((row,i)=>row.hidden=i<page.start||i>=page.end);const pager=shares.querySelector('.pagination');if(pager)pager.outerHTML=page.controls;shares.querySelector('.page-select')?.focus();return true}render();root.querySelector('h1')?.focus();return true}
  return false;
}
`;

export const NAVIGATION_CSS = `
.run-review .warning{margin-bottom:8px}
/* Short task pages; natural overflow remains available for zoom and long content. */
.study-list{display:grid;gap:0;border-top:1px solid var(--line);background:var(--surface)}
.study-list .study-list-row{display:flex;align-items:center;justify-content:space-between;gap:24px;width:100%;min-width:0;padding:18px 20px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;text-align:left;font:inherit;color:var(--ink);cursor:pointer;transition:background 160ms ease-out}
.study-row-body{display:grid;gap:9px;min-width:0;overflow-wrap:anywhere}.study-list .study-list-row strong{font:500 18px/1.35 var(--display);letter-spacing:-.025em}.study-row-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--muted)}.study-row-meta small{font-size:12px;line-height:20px}.study-list .study-list-row:hover{background:var(--hover)}.study-list-row>.ui-icon{flex:none;color:var(--blue);background:var(--blue-soft);border-radius:50%;width:14px;height:14px;padding:7px;box-sizing:content-box;transition:transform 160ms ease-out}.study-list-row:hover>.ui-icon{transform:translateX(2px)}
@media(max-width:600px){.study-list .study-list-row{padding:16px 12px;gap:14px}.study-list .study-list-row strong{font-size:17px}.study-row-meta{gap:6px}}

.study-workspace-header{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"title actions";align-items:center;gap:12px;margin-bottom:8px}

.study-workspace-header h1{grid-area:title;margin:0;font:600 18px/1.3 var(--display);letter-spacing:-.025em;overflow-wrap:anywhere}
.study-header-actions{grid-area:actions;display:flex;align-items:center;justify-content:flex-end;gap:6px;align-self:center}.study-header-actions .button{white-space:nowrap}
@media(max-width:700px){.study-workspace-header{grid-template-columns:minmax(0,1fr);grid-template-areas:"title" "actions";gap:8px 12px}.study-header-actions{justify-content:flex-end}.study-workspace-header h1{font-size:18px}}

.phase-edit-cue{display:block;margin-top:10px;font-size:11px;font-weight:700;color:var(--blue)}.phase-basics{padding-bottom:8px;border-bottom:1px solid var(--line)}.phase-cohort-hint{display:flex;justify-content:space-between;align-items:center;gap:10px;color:var(--muted);font-size:11px}.phase-cohort-hint .button{white-space:nowrap}.phase-form-tabs>.question-card{margin-top:8px}.phase-form-tabs .phase-basics .field,.phase-form-tabs .question-card .field{margin-bottom:6px}.phase-form-tabs .sticky-actions{display:flex;justify-content:space-between}
[hidden]{display:none!important}
.shell{padding:14px 24px 16px;max-width:1440px}
.workspace-breadcrumbs{flex:1;min-width:0;font-size:12px;color:var(--muted)}.workspace-breadcrumbs ol{display:flex;align-items:center;flex-wrap:wrap;gap:4px 8px;list-style:none;padding:0;margin:0}.workspace-breadcrumbs li{display:flex;align-items:baseline;gap:8px;min-width:0;max-width:100%;overflow-wrap:anywhere}.workspace-breadcrumbs [aria-current=page]{color:var(--ink)}.breadcrumb-separator{flex:none}.workspace-breadcrumbs .breadcrumb-link{padding-block:7px}.detail-back{margin-bottom:6px}
.project-navigation{margin-bottom:12px;padding-bottom:10px;gap:12px}
.breadcrumb-link{appearance:none;border:0;border-radius:3px;background:transparent;padding:0;min-width:0;color:var(--muted);font:inherit;text-align:left;overflow-wrap:anywhere;cursor:pointer}.breadcrumb-link:hover{color:var(--blue);text-decoration:underline;text-underline-offset:3px}.breadcrumb-link:focus-visible{outline:2px solid var(--blue);outline-offset:3px}

.project-navigation strong{font-size:13px}.project-navigation p{display:none}
.masthead{margin-bottom:14px;align-items:center}.masthead h1{font-size:27px;line-height:1.2;margin:3px 0 5px}.masthead p{font-size:12px;margin:0}.masthead .eyebrow{display:none}
.detail-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;margin-bottom:10px;padding:8px 0;background:var(--paper);position:sticky;top:0;z-index:4}
.detail-header h1{font-size:25px;line-height:1.2;margin:0}.detail-header .detail-toolbar{grid-column:2;grid-row:1 / span 2;display:flex;gap:8px;margin:0;padding:0;border:0;align-self:center}.detail-toolbar .save-state{font-size:10px}.detail-toolbar .button{padding:7px 10px;font-size:11px}.detail-description{font-size:11px;color:var(--muted)}.detail-description summary{cursor:pointer;width:fit-content}.detail-description p{margin:7px 0;max-width:85ch}
.tabs{margin-bottom:14px}.tab{padding-block:9px}.panel{padding:14px;margin-bottom:12px}.panelhead{margin-bottom:10px}.panelhead h2{font-size:15px}.panelhead p{font-size:11px;margin-top:3px}
.cohort-sections,.section-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.cohort-sections .button,.section-tabs .button{padding:7px 10px;font-size:11px}.section-tabs [aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.section-panel{min-width:0}.section-panel>.panel:last-child{margin-bottom:0}.pagination{padding-block:8px;margin:8px 0 0;border-top:1px solid var(--line);font-size:11px;position:sticky;bottom:0;background:var(--surface);z-index:2}.page-select{width:76px;height:29px;padding:3px 6px;font-size:11px}.page-position{font-variant-numeric:tabular-nums;color:var(--muted);font-size:11px}
.persona-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.persona-group{margin:8px 0}.persona-group h3{margin:6px 0}.persona-tile{padding:12px}.persona-tile p{-webkit-line-clamp:2}.persona-tile .persona-avatar{float:left;margin-right:8px}.persona-tile strong{margin:0 0 7px;min-height:32px}.persona-tile .open-cue{margin-top:8px}.explorer-controls{margin-bottom:8px;align-items:center}.explorer-controls p{margin:0 0 6px}
.segment-weights{margin-top:8px}.segment-weight-row{padding:5px 12px;gap:10px}.segment-details{margin:0;padding:0;border:0}.weights-footer{margin-top:10px}.cohort-detail-page .detail-header .detail-toolbar{grid-column:1 / -1;grid-row:auto;justify-content:space-between;gap:8px;padding-top:10px;border-top:1px solid var(--line)}.cohort-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.chart-key{font-size:11px;gap:12px}
.pool-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pool-card{padding:16px}.pool-card h2{font-size:21px}.pool-card p{font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.pool-card .pool-cloud,.pool-card .segment-legend{display:none}.pool-metrics{margin:12px 0}.pool-metrics strong{font-size:22px}.pool-card .button{font-size:11px;padding:7px 9px}
.project-card{padding:16px}.project-card h2{font-size:20px}.project-counts{margin:12px 0}.project-layout{gap:16px}.phase-inspector{margin-top:0}.phase-canvas{padding:10px 6px;max-height:340px}.phase-picker{width:240px;max-width:100%}.phase-inspector>aside .mini-card~.mini-card{display:none}.phase-inspector>aside .segment-legend{display:none}.phase-picker .field{margin-bottom:0}.phase-form-tabs .sticky-actions{margin-top:10px}.question-card{margin:0;padding:10px}.question-flat{padding:0;border:0;background:transparent}.phase-picker .field{gap:3px}.phase-picker label{font-size:10px}.question-card textarea{min-height:66px}.phase-select{padding:10px}.phase-input{margin:6px 0;padding:10px}
.brief-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.form-footer{display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:0;background:var(--surface);padding:10px 0;z-index:2}.connected-provider{padding:10px 12px;margin:10px 0;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:12px}.connected-provider summary{cursor:pointer}.connected-provider[open]>summary{margin-bottom:12px}
[data-theme=sepia] .section-tabs .button[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
@media(max-width:850px){.detail-header{grid-template-columns:1fr}.detail-header .detail-toolbar{grid-column:1;grid-row:auto;justify-content:space-between}.persona-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.brief-grid{grid-template-columns:1fr}.phase-inspector>aside{display:none}}
@media(max-width:600px){.shell{padding:10px 12px 20px}.project-navigation{margin-bottom:8px;padding-bottom:8px}.project-navigation>div{flex-basis:auto}.project-navigation strong{font-size:11px}.detail-header h1{font-size:21px}.detail-header .detail-toolbar{gap:5px}.detail-toolbar .row{gap:5px;flex-wrap:wrap}.detail-toolbar .save-state{max-width:65px}.cohort-detail-page .detail-toolbar .save-state{max-width:none}.cohort-actions{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%}.detail-header{position:static}.persona-grid,.pool-grid{grid-template-columns:1fr}.panel{padding:12px}.masthead h1{font-size:24px}.header-actions{margin-top:8px}.section-tabs,.cohort-sections{gap:5px}.section-tabs .button,.cohort-sections .button{padding:7px 8px}.explorer-controls{grid-template-columns:minmax(0,1fr) auto;gap:8px}.explorer-controls p{display:none}.pagination{gap:6px}.pagination .row{gap:6px}.pool-card h2{font-size:20px}.segment-weight-row{grid-template-columns:minmax(0,1fr) 82px 64px;padding:8px;gap:8px}.segment-weight-row .button{grid-column:3;grid-row:1}.segment-share-input{grid-column:2;grid-row:1}.segment-weight-name strong{font-size:11px}.segment-weight-name small{font-size:10px}.segment-share-input input{padding-inline:5px}.project-layout{grid-template-columns:1fr}.section-panel .layout>.aside{display:none}}
`;

/* Page anatomy, loaded last: brand, breadcrumb trail, project tabs, then one header whose actions sit on the title line. */
export const PAGE_LAYOUT_CSS = `
.wordmark-text{display:grid;gap:3px;line-height:1}.wordmark-text b{font-weight:inherit}.wordmark-text i{font:600 10px/1 var(--body);letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.project-navigation{display:flex;align-items:center;min-height:32px;margin-bottom:14px;padding-bottom:0;border-bottom:0}
.project-navigation+.project-tabs{margin-top:-6px}.project-tabs{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:4px 16px;margin:12px 0 22px;border-bottom:1px solid var(--line)}.project-tabs>.tabs{margin:0;border-bottom:0}
.project-settings-link{appearance:none;display:inline-flex;align-items:center;gap:6px;min-height:var(--button-height);padding:0 4px;border:0;border-bottom:2px solid transparent;background:transparent;color:var(--muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer}.project-settings-link:hover{color:var(--blue)}.project-settings-link:focus-visible{outline:2px solid var(--blue);outline-offset:2px}.project-settings-link .ui-icon{width:15px;height:15px}
.live-shell .project-tabs{margin-bottom:6px}
.masthead{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:0 24px;align-items:center}.masthead>div:first-child{display:contents}.masthead h1{grid-column:1;grid-row:1;margin:0}.masthead p{grid-column:1;grid-row:2;margin-top:6px}.masthead .header-actions{grid-column:2;grid-row:1;align-self:center;justify-content:flex-end}
.cohort-detail-page .detail-header .detail-toolbar{grid-row:1;flex-direction:row;flex-wrap:wrap;align-items:center;justify-content:flex-end;align-self:center;gap:10px}.cohort-detail-page .detail-toolbar .cohort-actions,.cohort-detail-page .detail-toolbar>.row{order:0}
.save-button{display:inline-flex;align-items:center;gap:6px}.save-button .ui-icon{width:15px;height:15px}
@media(max-width:800px){.cohort-detail-page .detail-header .detail-toolbar{justify-content:flex-start}}
@media(max-width:600px){.cohort-detail-page .cohort-actions{display:flex;width:auto}.masthead{display:block}.masthead .header-actions{margin-top:12px;justify-content:flex-start}.project-settings-link span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}}
`;
