/** Local display preference; never changes or redraws the research document. */
export const THEME_CONTROL = `<button type="button" id="themeToggle" class="button theme-toggle" role="switch" aria-checked="false" aria-label="Dark mode"><span class="theme-track" aria-hidden="true"><span></span></span><span id="themeLabel">Light</span></button>`;

// Runs in the head before first paint. Storage may be disabled in private browsers.
export const THEME_INIT = String.raw`(()=>{
  const key='jev-workspace-theme',root=document.documentElement;
  const normalize=value=>value==='dark'||value==='sepia'?'dark':'light';
  let theme='light';
  try{const saved=localStorage.getItem(key);theme=normalize(saved);if(saved==='sepia')localStorage.setItem(key,theme)}catch{}
  function apply(){
    root.dataset.theme=theme;
    const button=document.getElementById('themeToggle');
    if(button)button.setAttribute('aria-checked',String(theme==='dark'));
    const label=document.getElementById('themeLabel');
    if(label)label.textContent=theme==='dark'?'Dark':'Light';
  }
  apply();
  document.addEventListener('DOMContentLoaded',()=>{
    apply();
    document.getElementById('themeToggle').addEventListener('click',()=>{
      theme=theme==='light'?'dark':'light';apply();
      try{localStorage.setItem(key,theme)}catch{}
    });
  },{once:true});
  window.addEventListener('storage',event=>{
    if(event.key===key||event.key===null){theme=normalize(event.newValue);apply()}
  });
})();`;

/** Colors shared by CSS and contrast checks. Surfaces express their role, not nesting depth. */
export const WORKSPACE_PALETTES = {
  light: {
    paper: '#f3f6f8', surface: '#ffffff', raised: '#edf2f7', field: '#ffffff', hover: '#e4ecf5',
    ink: '#182c3d', muted: '#4d6377', faint: '#566b7e', line: '#c7d3dd', 'control-line': '#74889a',
    blue: '#315fb8', 'blue-dark': '#264b96', 'blue-soft': '#eaf0fb',
    teal: '#15766f', 'teal-soft': '#e5f3f1', amber: '#95651f', 'amber-soft': '#fbf3e4', red: '#a64b4b',
    'button-ink': '#ffffff', 'disabled-ink': '#566b7e', focus: '#315fb8',
  },
  dark: {
    paper: '#111923', surface: '#172332', raised: '#202e3f', field: '#0e1722', hover: '#2b3d53',
    ink: '#f4f7fb', muted: '#b7c9da', faint: '#a2b6ca', line: '#3c5166', 'control-line': '#7590aa',
    blue: '#87b7ff', 'blue-dark': '#aecfff', 'blue-soft': '#233e63',
    teal: '#72dcc5', 'teal-soft': '#183e3b', amber: '#f1c581', 'amber-soft': '#403421', red: '#ffb5ac',
    'button-ink': '#111923', 'disabled-ink': '#a2b6ca', focus: '#87b7ff',
  },
} as const;

function paletteCSS(palette: Record<string, string>): string {
  return Object.entries(palette).map(([key, value]) => `--${key}:${value}`).join(';');
}

export const THEME_CSS = `
:root{${paletteCSS(WORKSPACE_PALETTES.light)}}
.topbar-tools{display:flex;align-items:center;gap:18px;min-width:0}
.theme-toggle{min-height:40px;flex-shrink:0;gap:8px;min-width:102px}
.theme-track{display:flex;align-items:center;width:30px;height:18px;padding:2px;background:var(--muted);border-radius:20px}
.theme-track>span{width:14px;height:14px;border-radius:50%;background:var(--surface)}
.theme-toggle[aria-checked=true] .theme-track{background:var(--blue)}
.theme-toggle[aria-checked=true] .theme-track>span{transform:translateX(12px);background:var(--button-ink)}
.button,:is(input,textarea,select){border-color:var(--control-line)}
.button.primary{color:var(--button-ink)}
.button:disabled,.button:disabled:hover{opacity:1;background:var(--raised);color:var(--disabled-ink);border-color:var(--control-line)}
.busy{opacity:1}
:is(input,textarea,select):disabled{opacity:1;background:var(--raised);color:var(--disabled-ink)}
:is(input,textarea)::placeholder{color:var(--faint);opacity:1}
:is(button,a,input,textarea,select,summary):focus-visible{outline-color:var(--focus)}
:root[data-theme=dark]{color-scheme:dark;${paletteCSS(WORKSPACE_PALETTES.dark)};--shadow:none}
/* Slate: structural panels recede, interactive surfaces rise, fields are inset. */
[data-theme=dark] :is(.topbar,.sticky-actions,.form-footer,.pagination){background:var(--surface)}
[data-theme=dark] .glyph{color:var(--paper)}
[data-theme=dark] :is(.panel,.card,.pool-card){border-radius:6px;border-color:var(--line);box-shadow:none}
[data-theme=dark] .panelhead{padding-bottom:12px;border-bottom:1px solid var(--line)}
[data-theme=dark] :is(.panel,.card) :is(.panel,.mini-card,.question-card,.item-card,.advanced,.condition,.proposal-diff>div){background:transparent;border:0;border-top:1px solid var(--line);border-radius:0;box-shadow:none}
[data-theme=dark] .panel .panel{padding-inline:0}
[data-theme=dark] .question-flat{border:0!important}
[data-theme=dark] .button{background:var(--raised);color:var(--ink);border-color:var(--control-line)}
[data-theme=dark] .button:hover{background:var(--hover)}
[data-theme=dark] .button.primary{background:var(--blue);border-color:var(--blue);color:var(--button-ink)}
[data-theme=dark] .button.primary:hover{background:var(--blue-dark)}
[data-theme=dark] .button.soft{background:var(--blue-soft);border-color:var(--blue);color:var(--blue)}
[data-theme=dark] .button.danger{color:var(--red)}
[data-theme=dark] .button:disabled,[data-theme=dark] .button:disabled:hover{background:var(--raised);color:var(--disabled-ink);border-color:var(--control-line)}
[data-theme=dark] :is(input,textarea,select){background:var(--field);border-color:var(--control-line)}
[data-theme=dark] :is(input,textarea,select):disabled{background:var(--raised);color:var(--disabled-ink)}
[data-theme=dark] :is(.listrow,.stage-card,.run-card,.persona-tile,.project-card){background:var(--raised);border-color:var(--control-line);border-radius:6px}
[data-theme=dark] :is(.listrow,.persona-tile,.project-card):hover{background:var(--hover);border-color:var(--blue)}
[data-theme=dark] .auth-dialog{background:var(--surface);border-color:var(--control-line)}
[data-theme=dark] .persona-tile[aria-pressed=true]{background:var(--teal-soft);border-color:var(--teal)}
[data-theme=dark] :is(.empty,.callout){background:var(--surface);border-color:var(--line);border-radius:4px}
[data-theme=dark] .review-persona{background:transparent;border:0;border-top:1px solid var(--line);border-radius:0}
[data-theme=dark] :is(.eyebrow,.tab,.field label,.field-label,.stage-deps,.advanced>summary,.phase-port){color:var(--muted)}
[data-theme=dark] :is(.stage-deps,.source-line){border-color:var(--line)}
[data-theme=dark] .tab[aria-selected=true]{background:var(--blue-soft);color:var(--ink);border-color:var(--blue)}
[data-theme=dark] :is(.section-tabs,.cohort-sections) .button[aria-pressed=true]{background:var(--blue);color:var(--button-ink);border-color:var(--blue)}
[data-theme=dark] :is(.badge,.seg-pill,.callout){background:var(--raised);color:var(--muted)}
[data-theme=dark] .badge.blue{background:var(--blue-soft);color:var(--blue)}
[data-theme=dark] :is(.badge.teal,.notice){background:var(--teal-soft);color:var(--teal)}
[data-theme=dark] :is(.badge.amber,.warning,.workspace-sync,.output-tag){background:var(--amber-soft);color:var(--amber);border-color:var(--amber)}
[data-theme=dark] :is(.badge.red,.workspace-error){background:#482b32;color:var(--red);border-color:var(--red)}
[data-theme=dark] .phase-input{background:var(--teal-soft);border-color:var(--teal);border-radius:4px}
[data-theme=dark] .phase-ports{background:var(--surface);border-color:var(--line);border-radius:0 0 5px 5px}
[data-theme=dark] :is(.progress,.divider,.composition){background:var(--line)}
[data-theme=dark] .phase-canvas{background-color:var(--paper);background-image:radial-gradient(var(--line) .7px,transparent .7px)}
[data-theme=dark] :is(.phase-canvas .stage-card[data-selected=true],.stage-card[aria-pressed=true]){border-color:var(--blue);box-shadow:0 0 0 2px var(--blue)}
[data-theme=dark] .toast{background:var(--ink);color:var(--paper)}
[data-theme=dark] .auth-dialog::backdrop{background:#080e17bb}
[data-theme=dark] input{accent-color:var(--blue)}
@media(max-width:600px){.topbar{height:auto;min-height:64px;gap:10px;padding-block:8px;flex-wrap:wrap}.topbar-tools{gap:10px;margin-left:auto}.wordmark i{display:none}.account{max-width:160px}.theme-toggle{min-width:90px}}
@media(max-width:360px){.account{max-width:120px}.topbar-tools{gap:6px}}
`;
