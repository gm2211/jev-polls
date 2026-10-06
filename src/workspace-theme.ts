/** Local display preference; never changes or redraws the research document. */
export const THEME_CONTROL = `<button type="button" id="themeToggle" class="button theme-toggle" role="switch" aria-checked="false" aria-label="Dark sepia mode"><span class="theme-track" aria-hidden="true"><span></span></span><span id="themeLabel">Light</span></button>`;

// Runs in the head before first paint. Storage may be disabled in private browsers.
export const THEME_INIT = String.raw`(()=>{
  const key='jev-workspace-theme',root=document.documentElement;
  let theme='light';
  try{if(localStorage.getItem(key)==='sepia')theme='sepia'}catch{}
  function apply(){
    root.dataset.theme=theme;
    const button=document.getElementById('themeToggle');
    if(button)button.setAttribute('aria-checked',String(theme==='sepia'));
    const label=document.getElementById('themeLabel');
    if(label)label.textContent=theme==='sepia'?'Sepia':'Light';
  }
  apply();
  document.addEventListener('DOMContentLoaded',()=>{
    apply();
    document.getElementById('themeToggle').addEventListener('click',()=>{
      theme=theme==='light'?'sepia':'light';apply();
      try{localStorage.setItem(key,theme)}catch{}
    });
  },{once:true});
  window.addEventListener('storage',event=>{
    if(event.key===key||event.key===null){theme=event.newValue==='sepia'?'sepia':'light';apply()}
  });
})();`;

export const THEME_CSS = `
.topbar-tools{display:flex;align-items:center;gap:18px;min-width:0}
.theme-toggle{min-height:40px;flex-shrink:0;gap:8px;min-width:102px}
.theme-track{display:flex;align-items:center;width:30px;height:18px;padding:2px;background:var(--muted);border-radius:20px}
.theme-track>span{width:14px;height:14px;border-radius:50%;background:var(--surface)}
.theme-toggle[aria-checked=true] .theme-track{background:var(--blue)}
.theme-toggle[aria-checked=true] .theme-track>span{transform:translateX(12px)}
:root[data-theme=sepia]{color-scheme:dark;--paper:#211c17;--surface:#2c251e;--ink:#f0e3ce;--muted:#c5b59c;--faint:#b6a489;--line:#60503c;--control-line:#927a5c;--blue:#e5b975;--blue-dark:#f2ca8c;--blue-soft:#443421;--teal:#a5c7aa;--teal-soft:#293b2c;--amber:#ecc17c;--amber-soft:#46351f;--red:#f0a69a;--shadow:0 10px 30px #100b0733}
[data-theme=sepia] .topbar,[data-theme=sepia] .sticky-actions{background:var(--surface)}
[data-theme=sepia] .glyph{color:var(--paper)}
[data-theme=sepia] .button{background:var(--surface);color:var(--ink);border-color:var(--control-line)}
[data-theme=sepia] .button:hover{background:#3d3227}
[data-theme=sepia] .button.primary{background:var(--blue);border-color:var(--blue);color:var(--paper)}
[data-theme=sepia] .button.primary:hover{background:var(--blue-dark)}
[data-theme=sepia] .button.soft{background:var(--blue-soft);color:var(--blue)}
[data-theme=sepia] .button.danger{color:var(--red)}
[data-theme=sepia] :is(input,textarea,select,.listrow,.stage-card,.run-card,.auth-dialog,.persona-tile,.project-card){background:var(--surface);border-color:var(--line)}
[data-theme=sepia] :is(input,textarea,select){border-color:var(--control-line)}
[data-theme=sepia] .persona-tile[aria-pressed=true]{border-color:var(--teal)}
[data-theme=sepia] :is(.empty,.mini-card,.question-card,.item-card,.condition,.advanced,.phase-ports,.proposal-diff>div,.review-persona){background:#30281f;border-color:var(--line)}
[data-theme=sepia] :is(.eyebrow,.tab,.field label,.field-label,.stage-deps,.advanced>summary,.phase-port){color:var(--muted)}
[data-theme=sepia] :is(input,textarea)::placeholder{color:var(--faint);opacity:1}
[data-theme=sepia] :is(.stage-deps,.source-line){border-color:var(--line)}
[data-theme=sepia] .tab[aria-selected=true]{color:var(--ink)}
[data-theme=sepia] .badge,[data-theme=sepia] .seg-pill,[data-theme=sepia] .callout{background:#3a3025;color:var(--muted)}
[data-theme=sepia] .badge.blue{background:var(--blue-soft);color:var(--blue)}
[data-theme=sepia] .badge.teal,[data-theme=sepia] .notice{background:var(--teal-soft);color:var(--teal)}
[data-theme=sepia] :is(.badge.amber,.warning,.workspace-sync,.output-tag){background:var(--amber-soft);color:var(--amber);border-color:#a47c43}
[data-theme=sepia] .badge.red,[data-theme=sepia] .workspace-error{background:#4a2b23;color:var(--red);border-color:#a96e5b}
[data-theme=sepia] .phase-input{background:var(--teal-soft);border-color:#58765d}
[data-theme=sepia] :is(.progress,.divider,.composition){background:var(--line)}
[data-theme=sepia] .phase-canvas{background-color:var(--paper);background-image:radial-gradient(var(--line) .7px,transparent .7px)}
[data-theme=sepia] .phase-canvas .stage-card[data-selected=true]{border-color:var(--blue);box-shadow:0 0 0 2px var(--blue-soft)}
[data-theme=sepia] .toast{background:var(--ink);color:var(--paper)}
[data-theme=sepia] .auth-dialog::backdrop{background:#100b07aa}
[data-theme=sepia] :is(button,a,input,textarea,select,summary):focus-visible{outline-color:var(--blue)}
[data-theme=sepia] input{accent-color:var(--blue)}
@media(max-width:600px){.topbar{height:auto;min-height:64px;gap:10px;padding-block:8px;flex-wrap:wrap}.topbar-tools{gap:10px;margin-left:auto}.wordmark i{display:none}.account{max-width:160px}.theme-toggle{min-width:90px}}
@media(max-width:360px){.account{max-width:120px}.topbar-tools{gap:6px}}
`;
