import { readFileSync } from 'node:fs';

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
    paper: '#e4e7e2', surface: '#f6f7f3', raised: '#e8ece6', field: '#ffffff', hover: '#dce4da',
    ink: '#18201b', muted: '#48564b', faint: '#516052', line: '#b9c3b8', 'control-line': '#687865',
    blue: '#ad3514', 'blue-dark': '#8c290e', 'blue-soft': '#fbece1',
    teal: '#236445', 'teal-soft': '#e1eee3', amber: '#765800', 'amber-soft': '#f4edce', red: '#a32b25',
    'button-ink': '#ffffff', 'disabled-ink': '#516052', focus: '#ad3514',
  },
  dark: {
    paper: '#161b18', surface: '#232a25', raised: '#303931', field: '#101612', hover: '#384539',
    ink: '#f3f6ef', muted: '#c2cebf', faint: '#b8c6b5', line: '#4a5a4b', 'control-line': '#9eaf9a',
    blue: '#ff9a73', 'blue-dark': '#ffb396', 'blue-soft': '#4e2b1f',
    teal: '#a9dbaa', 'teal-soft': '#213d29', amber: '#edcf7e', 'amber-soft': '#40351b', red: '#ffb5ac',
    'button-ink': '#161b18', 'disabled-ink': '#b8c6b5', focus: '#ff9a73',
  },
} as const;

function paletteCSS(palette: Record<string, string>): string {
  return Object.entries(palette).map(([key, value]) => `--${key}:${value}`).join(';');
}

// Embedded open-source fonts keep the local workspace usable without a CDN.
const fontData = (name: string) => readFileSync(new URL('../assets/fonts/' + name + '-latin.woff2', import.meta.url)).toString('base64');
export const THEME_CSS = `
@font-face{font-family:Jev Display;src:url(data:font/woff2;base64,${fontData('space-grotesk')}) format('woff2');font-style:normal;font-weight:400 700;font-display:swap}
@font-face{font-family:Jev Sans;src:url(data:font/woff2;base64,${fontData('ibm-plex-sans')}) format('woff2');font-style:normal;font-weight:400 700;font-display:swap}
:root{${paletteCSS(WORKSPACE_PALETTES.light)};--shadow:none;--display:'Jev Display',Arial,sans-serif;--body:'Jev Sans',Arial,sans-serif;--numeric:'Jev Display',ui-monospace,monospace}
:root[data-theme=dark]{color-scheme:dark;${paletteCSS(WORKSPACE_PALETTES.dark)}}
/* One chassis, task surfaces, inset controls. No nested elevation. */
body{font-family:var(--body);background:var(--paper)}
.topbar{height:64px;padding:0 24px;background:var(--surface);border-bottom:2px solid var(--ink)}
.wordmark{font-family:var(--display);font-size:20px;letter-spacing:-.04em;gap:12px}.wordmark i{font-family:var(--body);font-size:12px;letter-spacing:.02em}
.glyph{width:32px;height:32px;border-radius:3px;background:var(--ink);color:var(--paper);font:600 21px var(--display)}
.topbar-tools{display:flex;align-items:center;gap:8px;min-width:0}
.theme-toggle{min-height:44px;flex-shrink:0;gap:8px;min-width:102px}
.theme-track{display:flex;align-items:center;width:26px;height:16px;padding:2px;background:var(--muted);border-radius:3px}.theme-track>span{width:12px;height:12px;border-radius:1px;background:var(--surface)}
.theme-toggle[aria-checked=true] .theme-track{background:var(--blue)}.theme-toggle[aria-checked=true] .theme-track>span{transform:translateX(10px);background:var(--button-ink)}
.shell{max-width:1500px;padding:18px 24px 24px}
.project-navigation{padding:0 0 12px;margin-bottom:18px}.project-navigation strong{font:600 14px var(--display)}
.masthead{align-items:center;margin-bottom:18px}.masthead h1,.detail-header h1{font:600 clamp(22px,2.4vw,30px)/1.16 var(--display);letter-spacing:-.035em}.masthead p{font-size:13px}
.detail-header{position:static;padding:0 0 12px;margin-bottom:0;border-bottom:1px solid var(--line)}.cohort-detail-page{max-width:none}
.detail-header .detail-toolbar{padding-top:10px;margin-top:10px}.detail-description{font-size:12px}.detail-description summary{min-height:28px}
.eyebrow,.section-kicker{color:var(--muted);font:600 11px var(--body);letter-spacing:.08em}.subtle{font-size:12px;color:var(--muted)}
.panel,.card,.pool-card,.project-card{border-radius:3px;border:1px solid var(--line);box-shadow:none;background:var(--surface)}
.panel{padding:18px}.panelhead{margin-bottom:16px}.panel h2,.panelhead h2{font:600 17px var(--display);letter-spacing:-.025em}.panelhead p{font-size:12px;max-width:75ch}
.panel :is(.panel,.mini-card,.question-card,.item-card,.advanced,.condition,.proposal-diff>div){border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none}.panel .panel{padding-inline:0}.question-flat{border:0!important}
.button,.button.small,.tab{min-height:44px;border-radius:3px;font-family:var(--body);font-size:13px;font-weight:600;padding:9px 13px}
.button{background:var(--surface);color:var(--ink);border-color:var(--control-line);box-shadow:0 1px 0 var(--control-line)}.button:hover{background:var(--hover)}
.button.primary{background:var(--blue);border-color:var(--blue);color:var(--button-ink);box-shadow:0 1px 0 var(--blue-dark)}.button.primary:hover{background:var(--blue-dark)}
.button.soft{color:var(--blue);background:var(--blue-soft);border-color:var(--blue)}.button.danger{color:var(--red)}
.button:disabled,.button:disabled:hover{opacity:1;background:var(--raised);color:var(--disabled-ink);border-color:var(--control-line);box-shadow:none;cursor:not-allowed}
:is(button,a,input,textarea,select,summary):focus-visible{outline:3px solid var(--focus);outline-offset:3px}
:is(input,textarea,select){font-family:var(--body);font-size:14px;line-height:1.45;background:var(--field);color:var(--ink);border:1px solid var(--control-line);border-radius:2px;padding:10px 11px}.field>input,.field>select{height:44px}.field label,.field-label{color:var(--muted);font-size:12px}.field small{color:var(--faint);font-size:11px}
:is(input,textarea)::placeholder{color:var(--faint);opacity:1}:is(input,textarea,select):disabled{opacity:1;background:var(--raised);color:var(--disabled-ink)}
input{accent-color:var(--blue)}input[type=number],.weight-summary,.distribution-number,.weights-total,.pool-metrics strong{font-family:var(--numeric);font-variant-numeric:tabular-nums}
.tabs,.section-tabs,.cohort-sections{gap:0;border-bottom:1px solid var(--line);margin:12px 0 18px}.tabs{flex-wrap:wrap}.tab{color:var(--muted);border-bottom:3px solid transparent}.tab[aria-selected=true]{color:var(--ink);border-color:var(--blue);background:var(--surface)}
.section-tabs .button,.cohort-sections .button{border:0;border-bottom:3px solid transparent;border-radius:0;box-shadow:none;background:transparent;color:var(--muted);padding:10px 14px;font-size:13px}
.section-tabs .button[aria-pressed=true],.cohort-sections .button[aria-pressed=true]{background:var(--surface);border-color:var(--blue);color:var(--ink)}
/* A cohort is one console: local channel selector beside its active work area. */
.cohort-console{display:grid;grid-template-columns:182px minmax(0,1fr);gap:24px;margin-top:16px}.cohort-console>.cohort-sections{display:flex;flex-direction:column;align-self:start;position:sticky;top:80px;margin:0;border:0;gap:4px}.cohort-console>.cohort-sections .button{justify-content:flex-start;text-align:left;border:0;border-left:3px solid transparent;min-height:48px;padding:10px 13px}.cohort-console>.cohort-sections .button[aria-pressed=true]{border-color:var(--blue)}.cohort-console-body{min-width:0}.cohort-console-body>.panel{margin:0}
.chart-key{padding:12px 0;border-bottom:1px solid var(--line);font-size:12px;gap:24px}.chart-key span{font-variant-numeric:tabular-nums}
/* Library records and persona rows use alignment, not decorative containers. */
.project-grid,.pool-grid{display:grid;grid-template-columns:1fr;gap:0;border-top:1px solid var(--line)}
.project-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 30px;padding:22px 18px;border:0;border-bottom:1px solid var(--line);border-radius:0}.project-card h2{font:600 23px var(--display);margin:2px 0}.project-card p{margin:0;color:var(--muted)}.project-card .section-kicker,.project-card h2,.project-card p{grid-column:1}.project-card .project-counts{grid-column:2;grid-row:1 / span 2;margin:0;align-self:center}.project-card>.button{grid-column:2;justify-self:end;grid-row:3 / span 2}.project-counts{font:500 13px var(--numeric)}
.pool-card{display:grid;grid-template-columns:minmax(220px,1fr) minmax(170px,.7fr) auto;gap:10px 26px;align-items:center;border:0;border-bottom:1px solid var(--line);border-radius:0;padding:20px}.pool-card h2{font:600 23px/1.15 var(--display);margin:5px 0}.pool-card p{margin:0;font-size:13px}.pool-card .pool-metrics{margin:0;gap:20px}.pool-card .pool-metrics strong{font-size:27px}.pool-card .pool-actions{display:grid;gap:8px}.pool-card .composition{margin:12px 0 0;height:5px;min-height:5px;border-radius:0}.pool-card .section-kicker{display:none}
.persona-grid{grid-template-columns:1fr;gap:0}.persona-group{margin:0}.persona-group h3{padding:10px 12px;background:var(--raised);margin:0;font-size:12px}
.persona-tile{display:grid;grid-template-columns:36px minmax(0,1fr) 110px 24px;gap:4px 14px;align-items:center;padding:14px 12px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;box-shadow:none;min-height:78px}.persona-tile:hover{background:var(--hover)}.persona-tile[aria-pressed=true]{background:var(--teal-soft);box-shadow:inset 3px 0 var(--teal)}.persona-tile .persona-avatar{grid-column:1;grid-row:1 / span 2;margin:0;float:none;border-radius:2px;background:var(--raised);color:var(--muted);font:600 12px var(--display);width:32px;height:34px}.persona-tile strong{grid-column:2;grid-row:1;min-height:0;margin:0;font-size:14px;font-weight:600}.persona-tile .persona-meta{grid-column:2;grid-row:2;font-size:12px}.persona-tile .persona-share{grid-column:3;grid-row:1 / span 2;text-align:right;font:500 20px var(--numeric);color:var(--ink)}.persona-share span{display:block;font:11px var(--body);color:var(--muted)}.persona-tile .open-cue{grid-column:4;grid-row:1 / span 2;font-size:20px;margin:0;color:var(--blue)}
.explorer-controls{grid-template-columns:minmax(180px,1fr) minmax(0,1fr);padding-bottom:14px;border-bottom:1px solid var(--line);gap:24px}.explorer-controls .button{float:right}.persona-story{font-size:15px;line-height:1.7}.persona-facts{gap:18px}.weight-summary{font-size:38px;margin:10px 0}.segment-weights{border:0;border-radius:0;margin-top:10px}.segment-weight-row{grid-template-columns:minmax(0,1fr) 115px 90px;padding:10px 0;gap:16px}.segment-weight-row .button{min-width:80px}.segment-share-input input{height:44px;font-size:18px}.segment-weight-name strong{font-size:14px}.segment-weight-name small{font-size:12px}
.pagination{background:var(--surface);padding:12px 0 0;margin:12px 0 0;font-size:12px}.page-select{height:44px;width:88px;font-size:13px}.form-footer,.sticky-actions{background:var(--surface);border-radius:0}
.distribution-row{min-height:44px;border-bottom:1px solid var(--line);font-size:13px}.distribution-track{height:14px;background:var(--raised);border-radius:0}.distribution-fill{background:var(--teal)}.distribution-chart{gap:0}.target-summary{font-size:13px}.source-empty{background:var(--teal-soft);color:var(--ink)}
.phase-canvas{background:var(--raised);border-block:1px solid var(--line);padding:20px 12px}.stage-card,.phase-canvas .stage-card{background:var(--surface);border:1px solid var(--control-line);border-radius:3px}.stage-card:before{border-radius:0}.phase-ports{background:var(--raised);border-radius:0}.phase-select{border-radius:0}.phase-port{color:var(--muted)}.phase-port button{min-height:44px;padding:5px 7px;border:1px solid var(--control-line);border-radius:2px;color:var(--ink);background:var(--surface)}.phase-input{background:var(--teal-soft);border-color:var(--teal);border-radius:2px}.phase-canvas .stage-card[data-selected=true],.stage-card[aria-pressed=true]{border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue)}
:is(.badge,.seg-pill,.output-tag){border-radius:2px;font-weight:500}.badge{background:var(--raised);color:var(--muted)}.badge.blue{background:var(--blue-soft);color:var(--blue)}.badge.teal,.notice{background:var(--teal-soft);color:var(--teal)}.badge.amber,.warning,.workspace-sync,.output-tag{background:var(--amber-soft);color:var(--amber)}.badge.red,.workspace-error{background:var(--surface);color:var(--red);border-color:var(--red)}.notice,.warning,.workspace-sync,.workspace-error{border-radius:0}.empty,.callout{background:var(--surface);border-color:var(--line);border-radius:2px;color:var(--muted)}.empty{padding:24px;text-align:left}.empty p{margin:6px 0 12px}.empty strong,.empty-pool strong{font:600 20px var(--display)}
.auth-dialog{border-radius:4px;background:var(--surface);border-color:var(--control-line);box-shadow:0 16px 60px #0005}.auth-dialog h2{font:600 25px var(--display)}.auth-dialog::backdrop{background:#101713aa}.close-dialog{width:44px;height:44px}.ai-pill,.data-pill{border-radius:3px}.back-link{min-height:44px;border:1px solid var(--control-line);border-radius:3px;padding:8px 12px;background:var(--surface);color:var(--ink)}.back-link:hover{text-decoration:none;background:var(--hover)}
.listrow,.run-card,.review-persona{background:var(--surface);border-radius:2px;border-color:var(--line)}.toast{background:var(--ink);color:var(--paper);border-radius:3px}.pulse.good{background:var(--teal);box-shadow:none}.busy{opacity:1}
/* Real telemetry is the signature display; all numbers come from job state. */
.panel.draft-progress{padding:20px;border:1px solid var(--control-line);border-top:4px solid var(--blue);border-radius:3px;background:var(--surface)}.draft-progress h2{font:600 20px var(--display)}.draft-metrics{margin:20px 0 0;padding:20px;background:var(--field);border:1px solid var(--line);border-bottom:0}.draft-count strong{font:600 clamp(40px,5vw,64px)/1 var(--numeric);letter-spacing:-.05em}.draft-count strong span{font-size:.5em}.draft-count{font-size:12px}.draft-estimate strong{font-family:var(--numeric);font-size:23px}.draft-progress progress{height:8px}.draft-steps{padding:0;margin-top:14px;gap:0;border:1px solid var(--line)}.draft-steps li{padding:12px;border-right:1px solid var(--line);font-size:12px}.draft-steps li:last-child{border-right:0}.draft-steps li[data-state=current]{background:var(--blue-soft);color:var(--blue)}.draft-live{padding:16px 0;margin:0 0 12px;border-top:0}.draft-inspect-tabs .button{min-height:44px}.draft-inspect-tabs{margin-bottom:12px}.draft-progress-status{font-size:16px}.draft-inspect{padding:12px 0 0}.draft-recent{gap:14px}
.cohort-detail-page .detail-header{grid-template-columns:minmax(0,1fr) auto;column-gap:28px;padding-bottom:14px}.cohort-detail-page .detail-header h1{font-size:26px}.cohort-detail-page .detail-header .detail-toolbar{grid-column:2;grid-row:1 / span 2;display:flex;flex-direction:column;align-items:flex-end;align-self:center;border:0;padding:0;margin:0;gap:6px}.detail-toolbar .cohort-actions{order:-1}.cohort-console .explorer-controls{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:0;padding:0 0 14px}.cohort-console .explorer-controls .field{width:320px;max-width:70%}.cohort-console .explorer-controls .button{float:none;flex-shrink:0}.personas-panel{padding-top:14px}
@media(max-width:1050px){.pool-card{grid-template-columns:minmax(0,1fr) auto}.pool-card .pool-actions{grid-column:1 / -1;display:flex;flex-wrap:wrap}.cohort-console{grid-template-columns:160px minmax(0,1fr);gap:16px}.topbar{padding-inline:16px}}
@media(max-width:800px){.cohort-detail-page .detail-header{display:block}.cohort-detail-page .detail-header .detail-toolbar{align-items:flex-start;margin-top:10px}.detail-toolbar .cohort-actions{order:0}.cohort-detail-page .detail-header h1{font-size:23px}.cohort-console{display:block}.cohort-console>.cohort-sections{position:static;flex-direction:row;flex-wrap:wrap;margin:0 0 14px;border-bottom:1px solid var(--line);gap:0}.cohort-console>.cohort-sections .button{border-left:0;border-bottom:3px solid transparent}.project-card .project-counts{grid-column:1;grid-row:auto}.project-card>.button{grid-column:2;grid-row:1 / span 4;align-self:center}.topbar-tools{gap:6px}.wordmark i{display:none}}
@media(max-width:600px){.topbar{height:auto;min-height:64px;padding:10px 12px;gap:10px;flex-wrap:wrap}.topbar-tools{flex:1;justify-content:flex-end}.topbar-tools .ai-pill{flex:initial;max-width:180px}.topbar-tools .theme-toggle{min-width:44px}.wordmark{font-size:18px}.shell{padding:12px}.panel{padding:14px}.project-navigation{gap:8px}.project-navigation strong{font-size:12px}.project-navigation .button{padding-inline:8px}.pool-card,.project-card{display:block;padding:18px 12px}.pool-card .pool-metrics{margin:16px 0}.pool-card .pool-actions{display:flex;flex-wrap:wrap}.project-card .project-counts{margin:12px 0}.cohort-console>.cohort-sections .button{font-size:12px;padding:8px 10px}.persona-tile{grid-template-columns:28px minmax(0,1fr) 66px;gap:4px 10px;padding:14px 0;min-height:94px}.persona-tile .persona-avatar{width:26px;height:28px;font-size:11px}.persona-tile strong{font-size:13px}.persona-tile .persona-meta{font-size:11px}.persona-tile .persona-share{font-size:18px}.persona-tile .open-cue{display:none}.explorer-controls{grid-template-columns:minmax(0,1fr) auto;gap:12px}.explorer-controls .button{float:none}.segment-weight-row{grid-template-columns:minmax(0,1fr) 84px 72px;gap:8px}.segment-weight-row .button{min-width:0;font-size:12px;padding-inline:8px;grid-column:3;grid-row:1}.segment-share-input{grid-column:2;grid-row:1}.segment-weight-name strong{font-size:12px}.segment-weight-name small{font-size:11px}.segment-share-input input{font-size:16px;padding-inline:6px}.pagination .row{width:100%;justify-content:space-between}.pagination .button{padding-inline:8px;font-size:12px}.panel.draft-progress{padding:14px}.draft-metrics{padding:16px;gap:16px}.draft-steps li{padding:10px 7px;font-size:11px}.draft-progress-heading{gap:12px}.draft-progress-actions{justify-content:space-between}.draft-recent{grid-template-columns:1fr}.draft-count strong{font-size:44px}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{transition:none!important;animation:none!important;scroll-behavior:auto!important}}
`;
