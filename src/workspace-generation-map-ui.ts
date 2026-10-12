/** A seat map that fills in while an audience is generated: one seat per persona, grouped by segment when the plan is known. */
export const GENERATION_MAP_CSS = `
.live-map{--seg-0:#1757a5;--seg-1:#0d7568;--seg-2:#a24d12;--seg-3:#7444b0;--seg-4:#a3285f;--seg-5:#5d6b0b;--seg-6:#0b6a8f;--seg-7:#8a5a00;margin-top:20px;padding-top:16px;border-top:1px solid var(--line);display:grid;gap:12px;min-width:0}
:root[data-theme=dark] .live-map{--seg-0:#8fbcff;--seg-1:#6fd3c3;--seg-2:#f2a56b;--seg-3:#c5a4f5;--seg-4:#f59ac0;--seg-5:#c3d36a;--seg-6:#7fd0f0;--seg-7:#e6c071}
.live-map>h3{margin:0;font:600 var(--text-md) var(--body)}
.live-map-groups{display:grid;gap:10px}
.live-map-group h4{margin:0 0 5px;display:flex;align-items:center;gap:8px;font:600 var(--text-xs) var(--body);color:var(--muted);overflow-wrap:anywhere}
.live-map-group h4 i{flex:none;width:8px;height:8px;border-radius:2px;background:var(--seg)}
.live-map-group h4 span{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.live-map-seats{display:flex;flex-wrap:wrap;gap:4px}
.live-seat{--seg:var(--control-line);width:26px;height:26px;flex:none;display:grid;place-items:center;padding:0;border:1px dashed var(--line);border-radius:6px;background:transparent;color:var(--ink);font:600 10px var(--body);cursor:pointer;transition:background-color .35s,border-color .35s}
.live-map-small .live-seat{width:14px;height:14px;border-radius:3px}.live-map-small .live-seat>span{display:none}
.live-seat[data-state=queued]{border-color:color-mix(in srgb,var(--seg) 50%,transparent)}
.live-seat[data-state=writing]{border-style:solid;border-color:color-mix(in srgb,var(--seg) 60%,transparent);background:color-mix(in srgb,var(--seg) 14%,transparent);animation:live-seat-breathe 1.4s ease-in-out infinite}
.live-seat[data-state=checking]{border-style:solid;border-color:var(--seg);background:color-mix(in srgb,var(--seg) 22%,transparent)}
.live-seat[data-state=retry]{border-color:var(--amber);background:var(--amber-soft)}
.live-seat[data-state=done]{border-style:solid;border-color:var(--seg);background:color-mix(in srgb,var(--seg) 30%,var(--surface));animation:live-seat-land .45s cubic-bezier(.2,1.6,.4,1)}
.live-seat:hover{box-shadow:inset 0 0 0 1px var(--seg)}.live-seat[aria-pressed=true]{outline:2px solid var(--ink);outline-offset:1px}
.live-seat:focus-visible{outline:3px solid var(--focus,var(--blue));outline-offset:2px}
.live-map-detail{font-size:var(--text-sm);min-height:64px;overflow-wrap:anywhere}
.live-map-detail h4{margin:0 0 2px;font:600 var(--text-md) var(--body);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.live-map-detail p{margin:0 0 6px;max-width:72ch;line-height:1.5}
.live-map-detail .subtle{margin:0 0 6px}
.live-map-detail dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 12px;margin:0}.live-map-detail dt{color:var(--muted)}.live-map-detail dd{margin:0}
.live-map-chip{font:600 var(--text-xs) var(--body);padding:1px 7px;border-radius:999px;border:1px solid var(--seg);color:var(--ink)}
@keyframes live-seat-breathe{50%{background:color-mix(in srgb,var(--seg) 28%,transparent)}}
@keyframes live-seat-land{0%{transform:scale(.4)}100%{transform:scale(1)}}
@media(prefers-reduced-motion:reduce){.live-seat{animation:none!important;transition:none}}
@media(pointer:coarse){.live-seat,.live-map-small .live-seat{width:32px;height:32px}}
`;

export const GENERATION_MAP_CLIENT = String.raw`
/* Per-job seat map state: checked personas fetched by batch, and the seat being inspected. */
function liveMapState(job){if(!S.liveAudience||S.liveAudience.jobId!==job.id)S.liveAudience={jobId:job.id,members:{},loading:{},selected:null};return S.liveAudience}
/*
 * Every seat's state, segment and persona, derived from the job's progress, in rows by segment. Null when the job is not an
 * audience. Seats of groups still being written follow the plan; a checked group's personas sit in the rows of the segments
 * they were actually written for, since the AI may write a slightly different mix than planned.
 */
function liveMapView(job){
  const p=job.progress||{},m=p.audienceMap,total=job.cohort?.size||p.totalPersonas||0;
  if(!job.cohort||!total||total>1000)return null;
  const st=liveMapState(job),segments=m?.segments||[],plan=m?.plan&&m.plan.length===total?m.plan:'';
  const details=new Map((Array.isArray(p.batchDetails)?p.batchDetails:[]).map(d=>[d.index-1,d])),accepted=new Set(m?.acceptedBatches||[]);
  const seats=[],sizes=m?.batchSizes||[];let start=0;
  sizes.forEach((n,b)=>{
    const d=details.get(b),done=accepted.has(b)||d?.state==='accepted',streamed=d?.streamingPersonas||0,members=done?st.members[b]:null;
    if(members)members.forEach((member,k)=>seats.push({key:b+':'+k,position:start+k,batch:b,k,size:n,detail:d,state:'done',segment:segments.findIndex(s=>s.id===member.segment),member}));
    else for(let k=0;k<n&&start+k<total;k++)seats.push({key:b+':'+k,position:start+k,batch:b,k,size:n,detail:d,member:null,segment:plan?parseInt(plan[start+k],36):-1,
      state:done?'done':!d?'empty':d.state==='checking'?'checking':d.state==='writing'&&k<streamed?'writing':d.state==='retrying'||d.attempt>1?'retry':'queued'});
    start+=n;
  });
  for(let i=start;i<total;i++)seats.push({key:'p:'+i,position:i,batch:-1,k:0,state:'empty',segment:plan?parseInt(plan[i],36):-1,member:null});
  let rows;
  if(plan){
    rows=segments.map((segment,index)=>({index,label:segment.label,seats:[]}));
    const other={index:-1,label:'Other segments',seats:[]};
    for(const seat of seats)(rows[seat.segment]||other).seats.push(seat);
    rows=rows.concat(other).filter(row=>row.seats.length);
  }else rows=[{index:-1,label:'',seats}];
  return {job,total,segments,plan,rows,seats:rows.flatMap(row=>row.seats),st};
}
function liveMapSignature(job){const v=liveMapView(job);return v?(v.plan?'plan':'flat')+':'+v.total+':'+v.rows.map(row=>row.index+'='+row.seats.length).join(','):''}
function liveSeatLabel(v,seat){
  const segment=v.segments[seat.segment]?.label,who=seat.member?.label||'Seat '+(seat.position+1);
  const status={empty:'not started',queued:'its group is getting ready',writing:'being written',checking:'being checked',retry:'being rewritten',done:seat.member?'checked and saved':'checked, loading profile'}[seat.state];
  return [who,segment,status].filter(Boolean).join(', ');
}
function liveSeatInitials(seat){return seat.member?String(seat.member.label).split(/\s+/).slice(0,2).map(word=>word[0]||'').join('').toUpperCase():''}
function liveSeatStyle(seat){return seat.segment>=0?'--seg:var(--seg-'+(seat.segment%8)+')':''}
function liveSeat(v,seat){return '<button type="button" class="live-seat" data-act="live-seat" data-key="'+attr(seat.key)+'" data-state="'+seat.state+'" style="'+liveSeatStyle(seat)+'" aria-pressed="'+(v.st.selected===seat.key)+'" aria-label="'+attr(liveSeatLabel(v,seat))+'"><span aria-hidden="true">'+esc(liveSeatInitials(seat))+'</span></button>'}
function liveMapCount(v,index){const mine=v.rows.find(row=>row.index===index)?.seats||[];return mine.filter(seat=>seat.state==='done').length+' of '+mine.length}
function liveMapDetail(v){
  const seat=v.seats.find(seat=>seat.key===v.st.selected);
  if(!seat)return '<p class="subtle">Select a seat to inspect who sits there. Seats fill in as personas are checked and saved.</p>';
  const segment=v.segments[seat.segment],chip=segment?'<span class="live-map-chip" style="'+liveSeatStyle(seat)+'">'+esc(segment.label)+'</span>':'',group=seat.batch>=0?'group '+(seat.batch+1):'';
  if(seat.member){
    const person=seat.member,attributes=Object.entries(person.attributes||{}).slice(0,4);
    return '<h4>'+esc(person.label)+' '+chip+'</h4><p class="subtle">Synthetic profile · Age '+esc(person.age)+' · Checked and saved</p><p>'+esc(person.background||'')+'</p>'+(attributes.length?'<dl>'+attributes.map(([key,value])=>'<dt>'+esc(key)+'</dt><dd>'+esc(typeof value==='string'?value:JSON.stringify(value))+'</dd>').join('')+'</dl>':'');
  }
  const d=seat.detail,message=seat.state==='done'?'Checked and saved. Loading the profile…'
    :seat.state==='empty'?(group?'Waiting. Its '+group+' has not started yet.':'Waiting while the audience is planned.')
    :seat.state==='queued'?(d?.wait?'Its '+group+' paused briefly and picks up again on its own.':'Its '+group+' is getting ready to write. This is persona '+(seat.k+1)+' of '+seat.size+' in it.')
    :seat.state==='writing'?'Being written now in '+group+' ('+(d?.streamingPersonas||0)+' of '+seat.size+' so far).'
    :seat.state==='checking'?'Written. Its '+group+' is being checked.'
    :'Its '+group+' did not pass a check and is being rewritten.';
  return '<h4>Seat '+(seat.position+1)+' '+chip+'</h4><p class="subtle">'+esc(message)+'</p><p class="subtle">The full profile opens here once it is checked.</p>';
}
/* Fetches checked personas for accepted batches once each, then updates the seats in place. */
function liveMapFetch(v){
  const job=v.job,st=v.st;if(typeof api!=='function'||!job.id)return;
  for(const b of job.progress?.audienceMap?.acceptedBatches||[]){
    if(st.members[b]||st.loading[b])continue;
    st.loading[b]=true;
    api('/api/agent/jobs/'+encodeURIComponent(job.id)+'/members?batch='+b).then(result=>{
      if(S.liveAudience!==st)return;st.members[b]=result.personas;
      const current=S.localJob?.id===job.id?S.localJob:null;
      if(current?.status==='running'&&!patchLiveMap(current))render();
    }).catch(()=>{});
  }
}
function liveMap(job){
  const v=liveMapView(job);if(!v)return '';
  Promise.resolve().then(()=>liveMapFetch(v));
  const small=v.total>60?' live-map-small':'';
  const groups=v.rows;
  return '<section class="live-map'+small+'" aria-label="Who is in the audience" data-live-map="'+attr(liveMapSignature(job))+'"><h3>Who answers</h3><div class="live-map-groups">'+groups.map(group=>'<section class="live-map-group" style="'+(group.index>=0?'--seg:var(--seg-'+(group.index%8)+')':'')+'">'+(group.label?'<h4><i aria-hidden="true"></i>'+esc(group.label)+'<span data-live-count="'+group.index+'">'+liveMapCount(v,group.index)+'</span></h4>':'')+'<div class="live-map-seats">'+group.seats.map(seat=>liveSeat(v,seat)).join('')+'</div></section>').join('')+'</div><div class="live-map-detail" aria-live="polite">'+liveMapDetail(v)+'</div></section>';
}
/* Updates seats, counts and the inspected seat in place. Returns false when the map needs a full render. */
function patchLiveMap(job){
  const node=root.querySelector('.live-map'),v=liveMapView(job);
  if(!node||!v||node.dataset.liveMap!==liveMapSignature(job))return false;
  liveMapFetch(v);
  const buttons=node.querySelectorAll('.live-seat');if(buttons.length!==v.total)return false;
  if([...buttons].some((button,j)=>button.dataset.key!==v.seats[j].key))return false;
  buttons.forEach((button,j)=>{
    const seat=v.seats[j];
    if(button.dataset.state!==seat.state)button.dataset.state=seat.state;
    const style=liveSeatStyle(seat);if((button.getAttribute('style')||'')!==style)button.setAttribute('style',style);
    const label=liveSeatLabel(v,seat);if(button.getAttribute('aria-label')!==label)button.setAttribute('aria-label',label);
    const text=liveSeatInitials(seat);if(button.firstElementChild&&button.firstElementChild.textContent!==text)button.firstElementChild.textContent=text;
    const pressed=String(v.st.selected===seat.key);if(button.getAttribute('aria-pressed')!==pressed)button.setAttribute('aria-pressed',pressed);
  });
  node.querySelectorAll('[data-live-count]').forEach(count=>{const text=liveMapCount(v,Number(count.dataset.liveCount));if(count.textContent!==text)count.textContent=text});
  const detail=node.querySelector('.live-map-detail'),html=liveMapDetail(v);if(detail&&detail.liveHtml!==html){detail.innerHTML=html;detail.liveHtml=html}
  return true;
}
function liveMapAction(action,el){
  if(action!=='live-seat')return false;
  const job=S.localJob;if(!job)return true;
  const st=liveMapState(job),key=el.dataset.key;st.selected=st.selected===key?null:key;
  if(!patchLiveMap(job))render();
  return true;
}
`;
