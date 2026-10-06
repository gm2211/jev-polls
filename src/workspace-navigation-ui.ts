/** Small, draft-safe navigation primitives shared by workspace editors. */
export const NAVIGATION_CLIENT = String.raw`
function viewportPageSize(large,small){return (window.innerWidth||1024)<=600?small:large}
function pageItems(items,key,limit=6){
  const scoped=(S.projectId||'workspace')+':'+key,pages=Math.max(1,Math.ceil(items.length/limit));
  const index=Math.max(0,Math.min(S.listPages[scoped]||0,pages-1));S.listPages[scoped]=index;
  const start=index*limit,end=Math.min(start+limit,items.length);
  const controls=pages>1?'<nav class="pagination" aria-label="'+attr(key)+' pages"><span role="status">'+(items.length?start+1:0)+'–'+end+' of '+items.length+'</span><div class="row"><button type="button" class="button small" data-act="page-action" data-page-key="'+attr(scoped)+'" data-page="'+(index-1)+'" '+(!index?'disabled':'')+'>Previous page</button><select class="page-select" aria-label="Go to page" name="listPage" data-page-key="'+attr(scoped)+'">'+Array.from({length:pages},(_,i)=>'<option value="'+i+'" '+(i===index?'selected':'')+'>'+ (i+1)+' / '+pages+'</option>').join('')+'</select><button type="button" class="button small" data-act="page-action" data-page-key="'+attr(scoped)+'" data-page="'+(index+1)+'" '+(index===pages-1?'disabled':'')+'>Next page</button></div></nav>':'';
  return {items:items.slice(start,end),index,start,end,total:items.length,pages,controls};
}
function sectionTabs(key,options,selected){
  const active=selected||S.sections[key]||options[0]?.id;
  return '<nav class="section-tabs" aria-label="'+attr(key)+' sections">'+options.map(o=>'<button type="button" class="button small" aria-pressed="'+(active===o.id)+'" data-act="section-view" data-section-key="'+attr(key)+'" data-section-id="'+attr(o.id)+'">'+esc(o.label)+'</button>').join('')+'</nav>';
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
  if(a==='section-view'){if(S.targetDraft)readTargetForm();S.sections[el.dataset.sectionKey]=el.dataset.sectionId;render();root.querySelectorAll('[data-act=section-view]').forEach(b=>{if(b.dataset.sectionKey===el.dataset.sectionKey&&b.dataset.sectionId===el.dataset.sectionId)b.focus()});drawStageEdges();return true}
  if(a==='page-action'){if(S.targetDraft)readTargetForm();S.listPages[el.dataset.pageKey]=Math.max(0,Number(el.dataset.page));const shares=el.closest?.('[data-form=segment-shares]');if(shares){const page=pageItems(cohort().segments,'segments',viewportPageSize(4,3));shares.querySelectorAll('.segment-weight-row').forEach((row,i)=>row.hidden=i<page.start||i>=page.end);const pager=shares.querySelector('.pagination');if(pager)pager.outerHTML=page.controls;shares.querySelector('.page-select')?.focus();return true}render();root.querySelector('h1')?.focus();return true}
  return false;
}
`;

export const NAVIGATION_CSS = `
/* Short task pages; natural overflow remains available for zoom and long content. */
[hidden]{display:none!important}
.shell{padding:14px 24px 16px;max-width:1440px}
.project-navigation{margin-bottom:12px;padding-bottom:10px;gap:12px}
.project-navigation strong{font-size:13px}.project-navigation p{display:none}
.masthead{margin-bottom:14px;align-items:center}.masthead h1{font-size:27px;line-height:1.2;margin:3px 0 5px}.masthead p{font-size:12px;margin:0}.masthead .eyebrow{display:none}
.breadcrumbs{margin-bottom:4px;font-size:11px}.detail-header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 20px;margin-bottom:10px;padding:8px 0;background:var(--paper);position:sticky;top:0;z-index:4}
.detail-header h1{font-size:25px;line-height:1.2;margin:0}.detail-header .detail-toolbar{grid-column:2;grid-row:1 / span 2;display:flex;gap:8px;margin:0;padding:0;border:0;align-self:center}.detail-toolbar .save-state{font-size:10px}.detail-toolbar .button{padding:7px 10px;font-size:11px}.detail-description{font-size:11px;color:var(--muted)}.detail-description summary{cursor:pointer;width:fit-content}.detail-description p{margin:7px 0;max-width:85ch}
.tabs{margin-bottom:14px}.tab{padding-block:9px}.panel{padding:14px;margin-bottom:12px}.panelhead{margin-bottom:10px}.panelhead h2{font-size:15px}.panelhead p{font-size:11px;margin-top:3px}
.cohort-sections,.section-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.cohort-sections .button,.section-tabs .button{padding:7px 10px;font-size:11px}.section-tabs [aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.section-panel{min-width:0}.section-panel>.panel:last-child{margin-bottom:0}.pagination{padding-block:8px;margin:8px 0 0;border-top:1px solid var(--line);font-size:11px;position:sticky;bottom:0;background:var(--surface);z-index:2}.page-select{width:76px;height:29px;padding:3px 6px;font-size:11px}.page-position{font-variant-numeric:tabular-nums;color:var(--muted);font-size:11px}
.persona-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.persona-group{margin:8px 0}.persona-group h3{margin:6px 0}.persona-tile{padding:12px}.persona-tile p{-webkit-line-clamp:2}.persona-tile .persona-avatar{float:left;margin-right:8px}.persona-tile strong{margin:0 0 7px;min-height:32px}.persona-tile .open-cue{margin-top:8px}.explorer-controls{margin-bottom:8px;align-items:center}.explorer-controls p{margin:0 0 6px}
.segment-weights{margin-top:8px}.segment-weight-row{padding:5px 12px;gap:10px}.segment-details{margin:0;padding:0;border:0}.weights-footer{margin-top:10px}.cohort-management{margin:0;padding:7px 10px;position:relative}.cohort-management[open]>.row{position:absolute;right:0;top:100%;width:230px;z-index:6;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:12px;box-shadow:var(--shadow)}.cohort-management[open]>summary{margin:0}.chart-key{font-size:11px;gap:12px}
.pool-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.pool-card{padding:16px}.pool-card h2{font-size:21px}.pool-card p{font-size:12px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.pool-card .pool-cloud,.pool-card .segment-legend{display:none}.pool-metrics{margin:12px 0}.pool-metrics strong{font-size:22px}.pool-card .button{font-size:11px;padding:7px 9px}
.project-card{padding:16px}.project-card h2{font-size:20px}.project-counts{margin:12px 0}.workspace-files{margin-top:12px;padding-top:10px}.project-layout{gap:16px}.phase-inspector{margin-top:0}.phase-canvas{padding:10px 6px;max-height:340px}.phase-picker{width:240px;max-width:100%}.phase-inspector>aside .mini-card~.mini-card{display:none}.phase-inspector>aside .segment-legend{display:none}.phase-picker .field{margin-bottom:8px}.phase-form-tabs .sticky-actions{margin-top:10px}.question-card{margin:0;padding:10px}.question-flat{padding:0;border:0;background:transparent}.phase-picker .field{gap:3px}.phase-picker label{font-size:10px}.question-card textarea{min-height:66px}.phase-select{padding:10px}.phase-input{margin:6px 0;padding:10px}
.brief-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.form-footer{display:flex;justify-content:flex-end;gap:8px;position:sticky;bottom:0;background:var(--surface);padding:10px 0;z-index:2}.connected-provider{padding:10px 12px;margin:10px 0;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:12px}.connected-provider summary{cursor:pointer}.connected-provider[open]>summary{margin-bottom:12px}
[data-theme=sepia] .section-tabs .button[aria-pressed=true]{background:var(--ink);color:var(--paper);border-color:var(--ink)}
@media(max-width:850px){.detail-header{grid-template-columns:1fr}.detail-header .detail-toolbar{grid-column:1;grid-row:auto;justify-content:space-between}.persona-grid{grid-template-columns:repeat(3,minmax(0,1fr))}.brief-grid{grid-template-columns:1fr}.phase-inspector>aside{display:none}}
@media(max-width:600px){.shell{padding:10px 12px 20px}.project-navigation{margin-bottom:8px;padding-bottom:8px}.project-navigation>div{flex-basis:auto}.project-navigation strong{font-size:11px}.detail-header h1{font-size:21px}.detail-header .detail-toolbar{gap:5px}.detail-toolbar .row{gap:5px;flex-wrap:wrap}.detail-toolbar .save-state{max-width:65px}.detail-header{position:static}.persona-grid,.pool-grid{grid-template-columns:1fr}.panel{padding:12px}.masthead h1{font-size:24px}.header-actions{margin-top:8px}.section-tabs,.cohort-sections{gap:5px}.section-tabs .button,.cohort-sections .button{padding:7px 8px}.explorer-controls{grid-template-columns:minmax(0,1fr) auto;gap:8px}.explorer-controls p{display:none}.pagination{gap:6px}.pagination .row{gap:6px}.pool-card h2{font-size:20px}.segment-weight-row{grid-template-columns:minmax(0,1fr) 82px 64px;padding:8px;gap:8px}.segment-weight-row .button{grid-column:3;grid-row:1}.segment-share-input{grid-column:2;grid-row:1}.segment-weight-name strong{font-size:11px}.segment-weight-name small{font-size:10px}.segment-share-input input{padding-inline:5px}.project-layout{grid-template-columns:1fr}.section-panel .layout>.aside{display:none}}
`;
