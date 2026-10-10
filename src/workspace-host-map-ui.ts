/** Shared, bounded synthetic-persona maps for study design and live execution. */
export const WORKSPACE_HOST_MAP_CLIENT = String.raw`
function hostMapState(key){S.hostMaps??={};return S.hostMaps[key]??={page:0,selectedId:null}}
function hostMapMember(c,key){return c?.personas?.find(person=>person.id===hostMapState(key).selectedId)||null}
function hostMap(c,options={}){
  if(!c?.personas?.length)return '<p class="subtle">No synthetic members yet. Choose or create a cohort.</p>';
  const key=options.key||c.id,state=hostMapState(key),limit=Math.max(1,Math.min(48,options.limit||48)),pages=Math.ceil(c.personas.length/limit);
  state.page=Math.max(0,Math.min(pages-1,state.page));
  const members=c.personas.slice(state.page*limit,(state.page+1)*limit),groups=[...new Set(members.map(person=>person.segment||'unassigned'))];
  return '<section class="host-map '+(options.compact?'host-map-compact':'')+'" aria-label="'+attr((c.name||'Cohort')+' synthetic member map')+'"><div class="host-map-groups">'+groups.map(segment=>{
    const label=c.segments?.find(item=>item.id===segment)?.label||segment;
    return '<section class="host-map-group"><h4>'+esc(label)+'</h4><div class="host-map-members">'+members.filter(person=>(person.segment||'unassigned')===segment).map(person=>{
      const status=options.statusFor?.(person)||'synthetic',selected=(options.selectedId??state.selectedId)===person.id,description=[person.label||person.id,label,status,person.age?'Age '+person.age:''].filter(Boolean).join(' · ');
      return '<button class="host-member" data-act="'+attr(options.memberAction||'host-member')+'" data-map="'+attr(key)+'" data-id="'+attr(person.id)+'" data-status="'+attr(status)+'" aria-pressed="'+selected+'" aria-label="'+attr(description)+'" title="'+attr(description)+'"><span aria-hidden="true">'+esc((person.label||person.id).split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase())+'</span></button>';
    }).join('')+'</div></section>';
  }).join('')+'</div><footer class="host-map-footer"><span>'+ (state.page*limit+1)+'–'+Math.min((state.page+1)*limit,c.personas.length)+' of '+c.personas.length+' synthetic '+(c.personas.length===1?'member':'members')+'</span>'+(pages>1?'<div class="row"><button class="button small icon-button" data-act="host-page" data-map="'+attr(key)+'" data-page="'+(state.page-1)+'" '+(!state.page?'disabled':'')+' aria-label="Previous members">'+icon('left')+'</button><span>'+(state.page+1)+' / '+pages+'</span><button class="button small icon-button" data-act="host-page" data-map="'+attr(key)+'" data-page="'+(state.page+1)+'" '+(state.page===pages-1?'disabled':'')+' aria-label="Next members">'+icon('right')+'</button></div>':'')+'</footer></section>';
}
function hostMapDetails(c,person,extra=''){
  if(!person)return '<div class="host-member-detail host-member-empty"><strong>Inspect a member</strong><p>Hover for a quick look. Click or press Enter to inspect a synthetic profile.</p></div>';
  const segment=c.segments?.find(item=>item.id===person.segment),sources=(person.sourceIds||[]).map(id=>c.sources?.find(source=>source.id===id)?.title||id);
  return '<article class="host-member-detail" aria-label="Selected synthetic member"><h3>'+esc(person.label||person.id)+'</h3><p class="subtle">Synthetic profile · '+esc(segment?.label||person.segment||'Unassigned')+(person.age?' · Age '+esc(person.age):'')+'</p>'+extra+'<p>'+esc(person.background||'No background provided.')+'</p><dl><dt>Profile weight</dt><dd>'+esc(person.weight??1)+'</dd><dt>Segment weighting</dt><dd>'+esc(segment?.weightBasis||'Unspecified')+'</dd><dt>Sourced references</dt><dd>'+esc(sources.join(', ')||'None recorded')+'</dd><dt>Synthetic fields</dt><dd>'+esc((person.syntheticFields||[]).join(', ')||'Not specified')+'</dd></dl></article>';
}
function hostMapAction(action,el){
  if(!['host-member','host-member-close','host-page'].includes(action))return false;
  const state=hostMapState(el.dataset.map);
  if(action==='host-member')state.selectedId=el.dataset.id;else if(action==='host-member-close')state.selectedId=null;else state.page=Math.max(0,Number(el.dataset.page)||0);
  render();
  if(action==='host-member'&&root.querySelector('[data-act=host-member-close]')){root.querySelector('[data-act=host-member-close]').focus();return true}
  if(action==='host-member-close'){root.querySelector('[data-act=host-member]')?.focus();return true}
  const buttons=[...root.querySelectorAll('[data-act="'+action+'"]')];buttons.find(button=>button.dataset.map===el.dataset.map&&(action==='host-member'?button.dataset.id===el.dataset.id:button.dataset.page===el.dataset.page))?.focus();
  return true;
}
`;

export const WORKSPACE_HOST_MAP_CSS = `
.host-map{min-width:0}.host-map-groups{display:grid;gap:12px}.host-map-group h4{font-size:11px;font-weight:600;color:var(--muted);margin:0 0 7px;overflow-wrap:anywhere}.host-map-members{display:flex;flex-wrap:wrap;gap:6px}.host-member{width:36px;height:36px;flex:none;display:grid;place-items:center;border:1px solid var(--control-line);border-radius:9px;background:var(--raised);color:var(--ink);font:600 10px var(--body);cursor:pointer}.host-member:hover,.host-member[aria-pressed=true]{background:var(--selection);border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}.host-member:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.host-member[data-status=running]{border-color:var(--blue);background:var(--selection)}.host-member[data-status=completed],.host-member[data-status=cached]{border-color:var(--green,#237747);background:color-mix(in srgb,var(--green,#237747) 12%,var(--surface))}.host-member[data-status=failed]{border-color:var(--red,#b54040);background:color-mix(in srgb,var(--red,#b54040) 12%,var(--surface))}.host-map-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--muted);margin-top:12px}.host-map-footer .row{gap:6px}.host-member-detail{border-top:1px solid var(--line);padding-top:12px;margin-top:14px;overflow-wrap:anywhere;font-size:12px}.host-member-detail h3{font-size:14px;margin:0 0 6px}.host-member-detail p{line-height:1.5}.host-member-detail dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:7px}.host-member-detail dt{color:var(--muted)}.host-member-detail dd{margin:0}.host-member-empty p{color:var(--muted)}.host-map-compact .host-member{width:24px;height:24px;border-radius:6px;font-size:8px}.host-map-compact .host-map-group h4{font-size:10px}.host-map-compact .host-map-groups{gap:8px}.host-map-compact .host-map-footer{font-size:9px}.flow-node-hosts{border-top:1px solid var(--line);padding:8px 12px}.flow-node-hosts>button{font:inherit;font-size:10px;border:0;background:transparent;color:var(--blue);cursor:pointer;padding:2px 0;display:flex;align-items:center;gap:8px;width:100%;text-align:left}.flow-host-dots{display:flex;gap:3px;flex-wrap:wrap;max-width:88px}.flow-host-dots i{width:7px;height:7px;border-radius:2px;background:var(--blue);opacity:.55}.flow-cohort-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}.flow-cohort-summary strong{overflow-wrap:anywhere}.flow-cohort-summary button{flex:none}.flow-cohort-map{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.flow-cohort-map>h3{font-size:13px;margin:0 0 10px}
@media(pointer:coarse){.host-member{width:44px;height:44px}}
`;
