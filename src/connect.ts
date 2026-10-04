import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';

export interface ConnectResult {
  model: string;
  reportHtml?: string;
  reportPath?: string;
  message?: string;
}

export interface ConnectServerOptions {
  title?: string;
  detail?: string;
  hasCredential: boolean;
  port?: number;
  connect: (apiKey: string | undefined, progress: (text: string) => void) => Promise<ConnectResult>;
}

export interface ConnectServerHandle { url: string; close: () => Promise<void> }
type ConnectStatus = 'waiting' | 'checking' | 'running' | 'completed' | 'failed';
interface PublicStatus {
  status: ConnectStatus;
  message: string;
  model?: string;
  reportPath?: string;
  reportAvailable: boolean;
}

const MAX_BODY_BYTES = 16 * 1024;
const SAFE_FAILURE = 'Connection setup failed. Retry, or check the local server if this continues.';
const PROVIDER_FAILURES: Record<string, string> = {
  MISSING_TYPESAFE_API_KEY: 'Enter a TypeSafe API key or choose the saved key.',
  TYPESAFE_AUTHENTICATION_FAILED: 'TypeSafe rejected the API key. Check it and try again.',
  TYPESAFE_PERMISSION_DENIED: 'This key cannot access the selected TypeSafe model. Check account and model access.',
  TYPESAFE_RATE_LIMITED: 'TypeSafe is busy or rate limiting. Wait a moment and try again.',
  TYPESAFE_TIMEOUT: 'TypeSafe did not respond in time. Retry the connection.',
  TYPESAFE_CONNECTION_FAILED: 'Could not reach TypeSafe. Check network access and retry.',
  TYPESAFE_SERVICE_UNAVAILABLE: 'TypeSafe is temporarily unavailable. Retry in a moment.',
  TYPESAFE_REQUEST_REJECTED: 'TypeSafe rejected the verification request. Check model access and retry.',
  TYPESAFE_RESPONSE_INVALID: 'TypeSafe returned an unexpected verification response. Retry the connection.',
  TYPESAFE_EVALUATION_FAILED: SAFE_FAILURE,
};

const escapeHtml = (value: unknown): string => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function safeString(value: unknown, secret?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const redacted = secret ? value.replaceAll(secret, '[redacted]') : value;
  return redacted.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2000);
}

function safeReportHtml(value: unknown, secret?: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  return secret ? value.replaceAll(secret, '[redacted]') : value;
}

function failureMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && Object.hasOwn(PROVIDER_FAILURES, error.code)) return PROVIDER_FAILURES[error.code]!;
  return SAFE_FAILURE;
}

function securityHeaders(response: ServerResponse, nonce: string, report = false): void {
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Content-Security-Policy', report
    ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    : `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
}

function send(response: ServerResponse, status: number, body: string, contentType: string, nonce: string, report = false): void {
  securityHeaders(response, nonce, report);
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.end(body);
}

function readJsonBody(request: IncomingMessage): Promise<{ value?: unknown; tooLarge: boolean; invalid: boolean }> {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; chunks.length = 0; return; }
      if (!tooLarge) chunks.push(buffer);
    });
    request.on('end', () => {
      if (tooLarge) { resolve({ tooLarge: true, invalid: false }); return; }
      try { resolve({ value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, tooLarge: false, invalid: false }); }
      catch { resolve({ tooLarge: false, invalid: true }); }
    });
    request.on('error', () => resolve({ tooLarge: false, invalid: true }));
  });
}

function pageHtml(options: ConnectServerOptions, csrf: string, nonce: string): string {
  const title = options.title?.trim() || 'Connect to TypeSafe';
  const detail = options.detail?.trim() || 'Use your TypeSafe account to run this research with a live model.';
  const action = options.title?.trim() ? 'Connect and run' : 'Connect';
  const saved = options.hasCredential;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="jev-csrf" content="${escapeHtml(csrf)}"><title>${escapeHtml(title)} · Jev polls</title>
<style nonce="${escapeHtml(nonce)}">
:root{color-scheme:light;--paper:#f4f7fa;--surface:#fff;--ink:#172a3b;--muted:#617385;--line:#d8e1e9;--blue:#315fbd;--blue-soft:#e8eefb;--teal:#177d79;--teal-soft:#e3f2f0;--red:#ad4b4b}*{box-sizing:border-box}body{min-height:100vh;margin:0;padding:32px 18px;display:grid;place-items:center;color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(ellipse at 50% 0,#e4edf5 0,transparent 58%),var(--paper)}main{width:min(100%,510px)}.brand{margin:0 0 16px;color:#425c70;font-size:11px;font-weight:750;letter-spacing:.15em;text-transform:uppercase}.mark{display:inline-block;width:9px;height:9px;margin-right:9px;border-radius:2px;background:var(--teal);transform:rotate(45deg)}.card{padding:30px;background:var(--surface);border:1px solid var(--line);border-radius:13px;box-shadow:0 12px 34px rgba(31,57,81,.08)}.eyebrow{color:#627a8e;text-transform:uppercase;letter-spacing:.13em;font-size:10px;font-weight:750}.card h1{margin:9px 0 8px;font:400 clamp(27px,6vw,36px)/1.1 Georgia,"Times New Roman",serif;letter-spacing:-.025em}.detail{margin:0 0 22px;color:#4c6173}.help{display:flex;align-items:flex-start;gap:10px;padding:12px 13px;margin:0 0 18px;border-radius:8px;background:#f1f6fa;color:#53697c;font-size:12px}.help b{color:var(--ink)}a{color:var(--blue);text-underline-offset:3px}.saved{display:flex;align-items:flex-start;gap:9px;margin:0 0 16px;padding:12px 13px;border:1px solid #dce7e9;border-radius:8px;background:#f5faf9;font-size:12px}.saved input{margin-top:3px;accent-color:var(--teal)}label.key-label{display:block;margin:0 0 6px;font-size:12px;font-weight:700}input[type=password]{width:100%;padding:11px 12px;border:1px solid #cbd8e2;border-radius:7px;color:var(--ink);background:#fff;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #74a5e4;outline-offset:3px}.key-note{margin:7px 0 18px;color:var(--muted);font-size:11px}.primary{width:100%;padding:11px 14px;border:1px solid #274f9f;border-radius:7px;background:var(--blue);color:#fff;font-size:13px;font-weight:700;cursor:pointer}.primary:hover{background:#274f9f}.primary:disabled{cursor:wait;opacity:.7}.billing{margin:13px 0 0;color:#697d8e;text-align:center;font-size:10px}.status{margin:18px 0 0;padding:12px 13px;border-radius:8px;background:#f1f5f8;color:#40596e;font-size:12px}.status[data-state=failed]{background:#faeeee;color:#803f3f}.status[data-state=completed]{background:var(--teal-soft);color:#24645f}.status[hidden]{display:none}.report-link{display:none;margin-top:12px;text-align:center;font-size:12px}.report-link.visible{display:block}.report-link a{font-weight:700}.sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:390px){body{padding:18px 12px}.card{padding:22px 18px}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
</style></head><body><main><p class="brand"><span class="mark" aria-hidden="true"></span>Jev / field notes</p><section class="card" aria-labelledby="title"><div class="eyebrow">Live model connection</div><h1 id="title">${escapeHtml(title)}</h1><p class="detail">${escapeHtml(detail)}</p>
<p class="help"><span aria-hidden="true">↗</span><span>Get an API key in the <a href="https://console.typesafe.ai" target="_blank" rel="noreferrer">TypeSafe console</a>. After TypeSafe verifies it, the key is saved to macOS Keychain.</span></p>
<form id="connectForm"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}">${saved ? '<label class="saved"><input id="useSaved" type="checkbox" checked><span><b>Use configured TypeSafe key</b><br>Reuse your existing TypeSafe credential.</span></label>' : ''}<div id="keyArea"${saved ? ' hidden' : ''}><label class="key-label" for="apiKey">TypeSafe API key</label><input id="apiKey" name="apiKey" type="password" autocomplete="off" spellcheck="false"${saved ? '' : ' required'}><p class="key-note">The key is used only with TypeSafe and is never added to your report.</p></div><button class="primary" id="connectButton" type="submit">${escapeHtml(action)}</button></form>
<p class="billing">Live model requests are billed by TypeSafe.</p><p id="status" class="status" role="status" aria-live="polite" hidden></p><p class="report-link" id="reportLink"><a href="/report">Open report</a></p>
</section></main><script nonce="${escapeHtml(nonce)}">
(()=>{'use strict';const form=document.getElementById('connectForm'),key=document.getElementById('apiKey'),saved=document.getElementById('useSaved'),area=document.getElementById('keyArea'),button=document.getElementById('connectButton'),status=document.getElementById('status'),link=document.getElementById('reportLink'),csrf=document.querySelector('meta[name="jev-csrf"]').content,action=${JSON.stringify(action)};let polling=false;
if(saved)saved.addEventListener('change',()=>{area.hidden=saved.checked;key.required=!saved.checked;if(saved.checked)key.value='';});
function show(state,message){status.hidden=false;status.dataset.state=state;status.textContent=message;}
const offlineMessage='The local connection server is unavailable. Restart jev-polls connect, then reload this page.';
function showStale(){show('failed','This connection page is stale. Reload it and try again.');button.disabled=false;button.textContent=action;}
async function poll(){if(polling)return;polling=true;while(polling){try{const response=await fetch('/status',{cache:'no-store'});if(response.status===403){showStale();polling=false;return;}if(!response.ok)throw Error();const state=await response.json();show(state.status,state.message);if(state.status==='completed'){button.disabled=true;button.textContent='Connection complete';link.classList.toggle('visible',Boolean(state.reportAvailable));polling=false;return;}if(state.status==='failed'){button.disabled=false;button.textContent=action;polling=false;return;}}catch{show('failed',offlineMessage);button.disabled=false;button.textContent=action;polling=false;return;}await new Promise(resolve=>setTimeout(resolve,700));}}
async function restore(){try{const response=await fetch('/status',{cache:'no-store'});if(response.status===403){showStale();return;}if(!response.ok)throw Error();const state=await response.json();if(state.status==='waiting')return;show(state.status,state.message);if(state.status==='checking'||state.status==='running'){button.disabled=true;button.textContent='Connecting…';poll();}else if(state.status==='completed'){button.disabled=true;button.textContent='Connection complete';link.classList.toggle('visible',Boolean(state.reportAvailable));}else{button.disabled=false;button.textContent=action;}}catch{show('failed',offlineMessage);button.disabled=false;button.textContent=action;}}
form.addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;let apiKey=saved?.checked?undefined:key.value.trim();if(!saved?.checked&&!apiKey){key.focus();return;}if(key)key.value='';show('checking','Checking your key with TypeSafe…');button.disabled=true;button.textContent='Connecting…';try{const body=JSON.stringify(apiKey?{apiKey}:{});apiKey=undefined;const response=await fetch('/connect',{method:'POST',headers:{'Content-Type':'application/json','x-jev-csrf':csrf},body,cache:'no-store'});if(response.status===403){showStale();return;}if(response.status===409){show('checking','This connection is already in progress. Reconnecting to its status…');button.disabled=true;poll();return;}if(!response.ok){show('failed',response.status===400?'The connection request was incomplete. Enter a key or choose your configured credential, then try again.':'The connection request could not be accepted. Reload this page and try again.');button.disabled=false;button.textContent=action;return;}show('checking','Checking your key with TypeSafe…');poll();}catch{show('failed',offlineMessage);button.disabled=false;button.textContent=action;}});
restore();
})();
</script></body></html>`;
}

export async function startConnectServer(options: ConnectServerOptions): Promise<ConnectServerHandle> {
  if (!Number.isInteger(options.port ?? 0) || (options.port ?? 0) < 0 || (options.port ?? 0) > 65535) throw new Error('port must be an integer from 0 through 65535');
  const csrf = randomBytes(32).toString('hex');
  const nonce = randomBytes(18).toString('base64');
  const state: PublicStatus = { status: 'waiting', message: 'Waiting for a TypeSafe connection.', reportAvailable: false };
  let reportHtml: string | undefined;
  let accepted = false;
  let inFlight = false;
  let baseUrl = '';
  let expectedHost = '';
  let closePromise: Promise<void> | undefined;

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 500, 'Request could not be completed.', 'text/plain; charset=utf-8', nonce);
      else response.destroy();
    });
  });

  const isLoopback = (request: IncomingMessage): boolean => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '');
  const originOk = (request: IncomingMessage, required: boolean): boolean => {
    const origin = request.headers.origin;
    return required ? origin === baseUrl.slice(0, -1) : origin === undefined || origin === baseUrl.slice(0, -1);
  };
  const hostOk = (request: IncomingMessage): boolean => request.headers.host === expectedHost && isLoopback(request);

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const pathname = new URL(request.url ?? '/', baseUrl || 'http://127.0.0.1/').pathname;
    if (!hostOk(request)) { send(response, 403, 'Forbidden.', 'text/plain; charset=utf-8', nonce); return; }

    if (request.method === 'GET' && pathname === '/') {
      if (!originOk(request, false)) { send(response, 403, 'Forbidden.', 'text/plain; charset=utf-8', nonce); return; }
      send(response, 200, pageHtml(options, csrf, nonce), 'text/html; charset=utf-8', nonce);
      return;
    }
    if (request.method === 'GET' && pathname === '/status') {
      if (!originOk(request, false)) { send(response, 403, 'Forbidden.', 'text/plain; charset=utf-8', nonce); return; }
      send(response, 200, JSON.stringify(state), 'application/json; charset=utf-8', nonce);
      return;
    }
    if (request.method === 'GET' && pathname === '/report') {
      if (!originOk(request, false)) { send(response, 403, 'Forbidden.', 'text/plain; charset=utf-8', nonce); return; }
      if (state.status !== 'completed') { send(response, 404, 'Report is not ready.', 'text/plain; charset=utf-8', nonce); return; }
      if (reportHtml) { send(response, 200, reportHtml, 'text/html; charset=utf-8', nonce, true); return; }
      if (state.reportPath) {
        const content = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Report saved</title><body style="font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:680px;margin:10vh auto;padding:24px;color:#172a3b"><h1>Report saved</h1><p>Open the report file from your terminal or file manager:</p><pre>${escapeHtml(state.reportPath)}</pre><a href="/">Return to connection</a></body></html>`;
        send(response, 200, content, 'text/html; charset=utf-8', nonce);
        return;
      }
      send(response, 404, 'No report was produced.', 'text/plain; charset=utf-8', nonce);
      return;
    }
    if (request.method !== 'POST' || pathname !== '/connect') { send(response, 404, 'Not found.', 'text/plain; charset=utf-8', nonce); return; }
    if (!originOk(request, true) || request.headers['x-jev-csrf'] !== csrf) { send(response, 403, 'Forbidden.', 'text/plain; charset=utf-8', nonce); return; }
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) { send(response, 415, 'Expected JSON.', 'text/plain; charset=utf-8', nonce); return; }
    const parsed = await readJsonBody(request);
    if (parsed.tooLarge) { send(response, 413, 'Request body is too large.', 'text/plain; charset=utf-8', nonce); return; }
    if (parsed.invalid || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) { send(response, 400, 'Invalid request.', 'text/plain; charset=utf-8', nonce); return; }
    const body = parsed.value as Record<string, unknown>;
    if (Object.keys(body).some((key) => key !== 'apiKey') || (body.apiKey !== undefined && typeof body.apiKey !== 'string')) { send(response, 400, 'Invalid request.', 'text/plain; charset=utf-8', nonce); return; }
    const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() || undefined : undefined;
    if (inFlight || accepted) { send(response, 409, 'Connection already accepted.', 'text/plain; charset=utf-8', nonce); return; }
    if (!options.hasCredential && !apiKey) { send(response, 400, 'Enter a TypeSafe API key.', 'text/plain; charset=utf-8', nonce); return; }
    inFlight = true;
    accepted = true;
    state.status = 'checking';
    state.message = 'Checking TypeSafe access…';
    send(response, 202, JSON.stringify({ accepted: true }), 'application/json; charset=utf-8', nonce);
    void runConnection(apiKey);
  }

  async function runConnection(apiKey?: string): Promise<void> {
    const redact = (value: unknown): string | undefined => safeString(value, apiKey);
    try {
      const result = await options.connect(apiKey, (text) => {
        const progress = redact(text);
        if (progress) { state.status = 'running'; state.message = progress; }
      });
      state.model = redact(result.model);
      state.message = redact(result.message) || 'Live run completed.';
      state.reportPath = redact(result.reportPath);
      reportHtml = safeReportHtml(result.reportHtml, apiKey);
      state.reportAvailable = Boolean(reportHtml || state.reportPath);
      state.status = 'completed';
    } catch (error) {
      state.status = 'failed';
      state.message = failureMessage(error);
      state.reportAvailable = false;
      reportHtml = undefined;
      state.reportPath = undefined;
      state.model = undefined;
    } finally {
      inFlight = false;
      if (state.status === 'failed') accepted = false;
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('Could not bind loopback server.')); return; }
      expectedHost = `127.0.0.1:${address.port}`;
      baseUrl = `http://${expectedHost}/`;
      resolve();
    });
  });

  return {
    url: baseUrl,
    close: () => {
      if (!closePromise) closePromise = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      return closePromise;
    },
  };
}
