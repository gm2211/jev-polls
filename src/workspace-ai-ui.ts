/** Shared AI connection controls, outside project editors. No credentials enter workspace data. */
export const AI_SETTINGS_CSS = `
.generation-workspace{max-width:880px}.generation-note{margin:12px 0}.generation-help{margin-top:12px;font-size:12px;color:var(--muted)}.generation-help summary{cursor:pointer}
.ai-pill{border-radius:99px;max-width:350px;min-width:100px}.ai-pill #aiLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ai-pill .pulse{flex:none}.ai-dialog{width:min(620px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto}.ai-dialog .section-tabs{margin:16px 0}.ai-dialog .mini-card{border:0;padding:0;background:transparent}.ai-dialog .toolbar{gap:8px;justify-content:flex-start}.ai-dialog .toolbar .button{font-size:11px}.ai-dialog .field:last-child{margin-bottom:0}.ai-dialog .ai-status{margin:12px 0}.ai-dialog .connection-extra{margin:14px 0}.ai-dialog .close-dialog{color:var(--muted)}
@media(max-width:600px){.ai-pill{max-width:160px}.topbar{padding-inline:12px}.topbar .wordmark i{display:none}.ai-dialog{padding:16px}.ai-dialog h2{font-size:22px}.ai-dialog .section-tabs .button{font-size:11px}.ai-dialog .toolbar{margin:8px 0}}
`;

export const AI_SETTINGS_CLIENT = String.raw`
function savedAISelection(){try{return JSON.parse(localStorage.getItem('jev-ai-selection')||'null')}catch{return null}}
function rememberAISelection(){try{localStorage.setItem('jev-ai-selection',JSON.stringify({provider:S.localEngine,accountId:S.chatgpt?.account?.id,model:S.chatgptModel,custom:S.chatgptCustomModel}))}catch{}}
function restoreAIModel(){const saved=savedAISelection();if(S.chatgpt?.connected&&saved?.accountId===S.chatgpt.account?.id&&typeof saved?.model==='string'){S.chatgptModel=saved.model;S.chatgptCustomModel=!!saved.custom}}
{const saved=savedAISelection();if(['chatgpt','codex','claude'].includes(saved?.provider))S.localEngine=saved.provider}
function updateAIPill(){
  const provider=S.localEngines?.find(e=>e.id===S.localEngine),name=S.localEngine==='chatgpt'?'ChatGPT':provider?.label||S.localEngine;
  const label=!S.localEngines||S.chatgptLoading&&S.localEngine==='chatgpt'?'AI · Connecting…':draftReady()?'AI · '+name+(S.localEngine==='chatgpt'?' · '+S.chatgptModel:''):'AI · Set up';
  document.getElementById('aiLabel').textContent=label;
  document.getElementById('aiDot').classList.toggle('good',!!draftReady());
  document.getElementById('aiSettingsPill').disabled=S.loading||S.localStarting;
}
function aiSettingsContent(){
  const options=(S.localEngines||[]).map(e=>({value:e.id,label:(e.label||e.id)+(e.available?' · ready':' · unavailable')}));
  const provider=S.localEngines?.find(e=>e.id===S.localEngine),busy=S.localLoading||S.localStarting||S.localJob?.status==='running';
  const nav='<nav class="section-tabs" aria-label="AI settings sections">'+[['drafting','Drafting'],['evaluations','Study evaluations'],['external','External agents']].map(([id,label])=>'<button class="button" data-act="ai-section" data-section="'+id+'" aria-pressed="'+(S.aiSection===id)+'">'+label+'</button>').join('')+'</nav>';
  let content;
  if(S.aiSection==='evaluations')content='<h3>TypeSafe</h3><p class="subtle">Jev evaluates your personas when you run a study.</p><p class="ai-status">'+esc(S.snap?.auth?.configured?'Connected · '+S.snap.auth.source:'Not connected')+'</p><button class="button" data-act="auth-open">'+(S.snap?.auth?.configured?'Update API key':'Connect TypeSafe')+'</button>';
  else if(S.aiSection==='external')content=mcpSetup();
  else content='<fieldset '+(busy?'disabled':'')+' style="border:0;margin:0;padding:0;min-width:0">'+select('localEngine',options.length?options:[{value:S.localEngine,label:'Checking providers…'}],S.localEngine,'Drafting provider')+(S.localEngine==='chatgpt'?chatGptControlsBody():'<p class="subtle ai-status">'+esc(provider?.message||'Uses your existing CLI sign-in.')+'</p>')+'<div class="toolbar"><button class="button small" data-act="assistant-refresh" '+(S.localLoading?'disabled':'')+'>Refresh connections</button></div></fieldset>';
  return nav+content+(S.localError?'<p class="warning" role="alert">'+esc(S.localError)+'</p>':'');
}
function updateAISettings(){
  updateAIPill();const dialog=document.getElementById('aiSettingsDialog');if(!dialog.open)return;
  const body=document.getElementById('aiSettingsBody'),active=document.activeElement,focused=body.contains?.(active),name=active?.name,action=active?.dataset?.act,section=active?.dataset?.section;
  body.innerHTML=aiSettingsContent();
  if(focused){const next=[...body.querySelectorAll('[name],[data-act]')].find(el=>name?el.name===name:action&&el.dataset.act===action&&el.dataset.section===section);next?.focus()}
}
function aiSettingsAction(action,el){
  if(action==='ai-open'){document.getElementById('aiSettingsBody').innerHTML=aiSettingsContent();document.getElementById('aiSettingsDialog').showModal();void loadLocalAgents();return true}
  if(action==='ai-close'){document.getElementById('aiSettingsDialog').close();return true}
  if(action==='ai-section'){S.aiSection=el.dataset.section;updateAISettings();if(S.aiSection==='external'&&!S.agentConfig)void loadAgentConfig();return true}
  return false;
}
`;
