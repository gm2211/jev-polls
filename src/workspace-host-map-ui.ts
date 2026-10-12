/** Shared, bounded synthetic-persona maps for study design and live execution. */
export const WORKSPACE_HOST_MAP_CLIENT = String.raw`
function hostMapState(key){S.hostMaps??={};return S.hostMaps[key]??={page:0,selectedId:null}}
function hostMapMember(c,key){return c?.personas?.find(person=>person.id===hostMapState(key).selectedId)||null}
/* Seats per page in a seat map: as many full lines as fit its pane once measured, a screenful of small seats before that. */
function seatPageSize(fit){return S.seatFits?.[fit]?.size||viewportPageSize(240,96)}
/*
 * The next line count for a seat map, as a search between the most lines known to fit (ok) and the fewest known to overflow
 * (over): fewer when its pane overflows (excess>0), more when it is paged and a whole line of room is spare. Never below two.
 */
function seatFitLines(lines,excess,linePitch,paged,fit={}){
  let ok=fit.ok||0,over=fit.over||Infinity;
  if(excess>0){over=Math.min(over,lines);return {lines:Math.max(2,Math.min(lines-1,Math.max(ok,lines-Math.ceil(excess/linePitch)))),ok,over}}
  ok=Math.max(ok,lines);
  return {lines:paged&&-excess>=linePitch?Math.max(lines,Math.min(over-1,lines+Math.floor(-excess/linePitch))):lines,ok,over};
}
function seatPane(node){for(let el=node.parentElement;el&&el!==document.body;el=el.parentElement){const y=getComputedStyle(el).overflowY;if(y==='auto'||y==='scroll')return el}return null}
/* How far the pane's content overflows it, or (negative) how much room is left below the content. Without a scrolling pane, the map alone must fit the window. */
function seatPaneExcess(pane,map){
  if(!pane)return map.getBoundingClientRect().height-(innerHeight-140);
  if(pane.scrollHeight>pane.clientHeight+1)return pane.scrollHeight-pane.clientHeight;
  const box=pane.getBoundingClientRect(),style=getComputedStyle(pane),bottom=Math.max(0,...[...pane.children].map(child=>child.getBoundingClientRect().bottom+parseFloat(getComputedStyle(child).marginBottom||'0')));
  return bottom-box.top+parseFloat(style.paddingBottom||'0')-pane.clientHeight;
}
let seatFitDepth=0;
/* After each render, sizes every seat map's pages to what its pane shows without scrolling, so paging and scrolling never combine. */
function fitSeatMaps(){
  if(typeof document==='undefined'||seatFitDepth>5)return;
  for(const map of root.querySelectorAll('.live-map[data-fit]')){
    const seats=map.querySelector('.live-map-seats'),seat=map.querySelector('.live-seat');if(!seats||!seat)continue;
    const key=map.dataset.fit,pane=seatPane(map),gap=parseFloat(getComputedStyle(seats).columnGap)||4,perLine=Math.max(1,Math.floor((seats.clientWidth+gap)/(seat.offsetWidth+gap))),linePitch=seat.offsetHeight+gap;
    const box=(pane?pane.clientWidth+'x'+pane.clientHeight:innerWidth+'x'+innerHeight)+':'+perLine,size=seatPageSize(key);S.seatFits??={};
    // Segment headers take room too, so a guess can overshoot; the search narrows between sizes seen to fit and to overflow at this pane size.
    const fit=S.seatFits[key]?.box===box?S.seatFits[key]:{},next=seatFitLines(Math.ceil(size/perLine),seatPaneExcess(pane,map),linePitch,!!map.querySelector('.pagination'),fit),lines=next.lines;
    S.seatFits[key]={box,size:perLine*lines,ok:next.ok,over:next.over};
    if(perLine*lines!==size){seatFitDepth++;try{render()}finally{seatFitDepth--}return}
  }
}
/* One member in place of the map, with a way back and to the neighbouring members. */
function hostMapFocus(c,key,person,back){
  const index=c.personas.findIndex(item=>item.id===person.id);
  return '<section class="flow-member-focus"><div class="flow-member-navigation"><button class="button small" data-act="host-member-close" data-map="'+attr(key)+'">'+icon('left')+' '+esc(back)+'</button><div class="row"><button class="button small icon-button" data-act="host-member" data-map="'+attr(key)+'" data-id="'+attr(c.personas[index-1]?.id||'')+'" '+(index===0?'disabled':'')+' aria-label="Previous member">'+icon('left')+'</button><span>'+(index+1)+' / '+c.personas.length+'</span><button class="button small icon-button" data-act="host-member" data-map="'+attr(key)+'" data-id="'+attr(c.personas[index+1]?.id||'')+'" '+(index===c.personas.length-1?'disabled':'')+' aria-label="Next member">'+icon('right')+'</button></div></div>'+hostMapDetails(c,person)+'</section>';
}
/* The same seat map as live generation: one seat per member, in a row per segment, each segment in its own colour, paged. */
function hostMap(c,options={}){
  if(!c?.personas?.length)return '<p class="subtle">No synthetic members yet. Choose or create a cohort.</p>';
  const key=options.key||c.id,state=hostMapState(key),order=(c.segments||[]).map(item=>item.id);
  const groups=[...new Set([...order,...c.personas.map(person=>person.segment||'unassigned')])].map(segment=>({segment,label:c.segments?.find(item=>item.id===segment)?.label||segment,index:order.indexOf(segment),members:c.personas.filter(person=>(person.segment||'unassigned')===segment)})).filter(group=>group.members.length);
  const fit='host:'+key,page=pageItems(groups.flatMap(group=>group.members),'seats:'+key,options.limit||seatPageSize(fit)),shown=new Set(page.items);
  return '<section class="live-map host-map'+(c.personas.length>60?' live-map-small':'')+'"'+(options.limit?'':' data-fit="'+attr(fit)+'"')+' aria-label="'+attr((c.name||'Cohort')+' synthetic member map')+'"><div class="live-map-groups">'+groups.filter(group=>group.members.some(person=>shown.has(person))).map(group=>{
    const style=group.index>=0?'--seg:var(--seg-'+(group.index%8)+')':'';
    return '<section class="live-map-group" style="'+style+'"><h4><i aria-hidden="true"></i>'+esc(group.label)+'<span>'+group.members.length.toLocaleString('en-US')+'</span></h4><div class="live-map-seats">'+group.members.filter(person=>shown.has(person)).map(person=>{
      const status=options.statusFor?.(person)||'synthetic',selected=(options.selectedId??state.selectedId)===person.id,description=[person.label||person.id,group.label,status,person.age?'Age '+person.age:''].filter(Boolean).join(' · ');
      return '<button type="button" class="live-seat" data-state="done" style="'+style+'" data-act="'+attr(options.memberAction||'host-member')+'" data-map="'+attr(key)+'" data-id="'+attr(person.id)+'" data-status="'+attr(status)+'" aria-pressed="'+selected+'" aria-label="'+attr(description)+'" title="'+attr(description)+'"><span aria-hidden="true">'+esc((person.label||person.id).split(/\s+/).slice(0,2).map(word=>word[0]).join('').toUpperCase())+'</span></button>';
    }).join('')+'</div></section>';
  }).join('')+'</div>'+(page.pages>1?page.controls:'<footer class="host-map-footer"><span>'+c.personas.length.toLocaleString('en-US')+' synthetic '+(c.personas.length===1?'member':'members')+'</span></footer>')+'</section>';
}
function hostMapDetails(c,person,extra=''){
  if(!person)return '<div class="host-member-detail host-member-empty"><strong>Inspect a member</strong><p>Hover for a quick look. Click or press Enter to inspect a synthetic profile.</p></div>';
  const segment=c.segments?.find(item=>item.id===person.segment),sources=(person.sourceIds||[]).map(id=>c.sources?.find(source=>source.id===id)?.title||id);
  return '<article class="host-member-detail" aria-label="Selected synthetic member"><h3>'+esc(person.label||person.id)+'</h3><p class="subtle">Synthetic profile · '+esc(segment?.label||person.segment||'Unassigned')+(person.age?' · Age '+esc(person.age):'')+'</p>'+extra+'<p>'+esc(person.background||'No background provided.')+'</p><dl>'+Object.entries(person.attributes||{}).map(([key,value])=>'<dt>'+esc(key)+'</dt><dd>'+esc(typeof value==='string'?value:JSON.stringify(value))+'</dd>').join('')+'<dt>Profile weight</dt><dd>'+esc(person.weight??1)+'</dd><dt>Segment weighting</dt><dd>'+esc(segment?.weightBasis||'Unspecified')+'</dd><dt>Sourced references</dt><dd>'+esc(sources.join(', ')||'None recorded')+'</dd><dt>Synthetic fields</dt><dd>'+esc((person.syntheticFields||[]).join(', ')||'Not specified')+'</dd></dl></article>';
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
.live-map.host-map{margin-top:0;padding-top:0;border-top:0;gap:0}.host-map .live-seat{animation:none}.host-member{width:36px;height:36px;flex:none;display:grid;place-items:center;border:1px solid var(--control-line);border-radius:9px;background:var(--raised);color:var(--ink);font:600 var(--text-xs) var(--body);cursor:pointer}.host-member:hover,.host-member[aria-pressed=true]{background:var(--selection);border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}.host-member:focus-visible{outline:3px solid var(--blue);outline-offset:2px}.host-member[data-status=running]{border-color:var(--blue);background:var(--selection)}.host-member[data-status=completed],.host-member[data-status=cached]{border-color:var(--green,#237747);background:color-mix(in srgb,var(--green,#237747) 12%,var(--surface))}.host-member[data-status=failed]{border-color:var(--red,#b54040);background:color-mix(in srgb,var(--red,#b54040) 12%,var(--surface))}.host-map-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:var(--text-xs);color:var(--muted);margin-top:12px}.host-map-footer .row{gap:6px}.host-member-detail{border-top:1px solid var(--line);padding-top:12px;margin-top:14px;overflow-wrap:anywhere;font-size:var(--text-sm)}.host-member-detail h3{font-size:var(--text-md);margin:0 0 6px}.host-member-detail p{line-height:1.5}.host-member-detail dl{display:grid;grid-template-columns:110px minmax(0,1fr);gap:7px}.host-member-detail dt{color:var(--muted)}.host-member-detail dd{margin:0}.host-member-empty p{color:var(--muted)}.host-map-compact .host-member{width:24px;height:24px;border-radius:6px;font-size:var(--text-xs)}.host-map-compact .host-map-group h4{font-size:var(--text-xs)}.host-map-compact .host-map-groups{gap:8px}.host-map-compact .host-map-footer{font-size:var(--text-xs)}.flow-node-hosts{border-top:1px solid var(--line);padding:8px 12px}.flow-node-hosts>button{font:inherit;font-size:var(--text-xs);border:0;background:transparent;color:var(--blue);cursor:pointer;padding:2px 0;display:flex;align-items:center;gap:8px;width:100%;text-align:left}.flow-host-dots{display:flex;gap:3px;flex-wrap:wrap;max-width:88px}.flow-host-dots i{width:7px;height:7px;border-radius:2px;background:var(--blue);opacity:.55}.flow-cohort-summary{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:var(--text-sm)}.flow-cohort-summary strong{overflow-wrap:anywhere}.flow-cohort-summary button{flex:none}.flow-cohort-map{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.flow-cohort-map>h3{font-size:var(--text-md);margin:0 0 10px}
@media(pointer:coarse){.host-member{width:44px;height:44px}}
`;
