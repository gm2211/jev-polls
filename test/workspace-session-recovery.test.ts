import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { startWorkspaceServer } from '../src/workspace.js';
import { emptyWorkspaceDocument } from '../src/workspace-store.js';

const options = (directory: string, port?: number) => ({ directory, port,
  getAuthStatus: async () => ({ configured: false, source: 'none' as const }),
  localAgents: { availability: async () => ({ engines: [] }), start: () => { throw new Error('unused'); }, get: () => undefined, cancel: () => undefined, close: async () => {} } });

/** Runs the served page's client against the live server, sending Origin on POSTs like a browser does. */
function pageClient(html: string, base: string, posts: string[], reloadedPage?: string) {
  const nonce = html.match(/<script nonce="([^"]+)">/)![1]!;
  const client = html.match(new RegExp(`<script nonce="${nonce.replace(/[+/=]/g, '\\$&')}">([\\s\\S]*?)<\\/script>`))![1]!;
  const element = { innerHTML: '', textContent: '', value: '', hidden: false, inert: false,
    classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], focus() {}, addEventListener() {} };
  const context: any = {
    location: { origin: new URL(base).origin },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: () => element, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible' },
    window: { addEventListener() {} }, navigator: {}, URL, URLSearchParams, Blob, TextEncoder, FormData,
    fetch: (path: string, init: any = {}) => {
      if (init.method && init.method !== 'GET') posts.push(init.headers['x-jev-csrf']);
      if (path === '/' && reloadedPage !== undefined) return Promise.resolve(new Response(reloadedPage));
      return fetch(new URL(path, base), { ...init, headers: { ...init.headers, ...(init.method && init.method !== 'GET' ? { origin: new URL(base).origin } : {}) } });
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1,
  };
  new Script(client.replace(/\}\)\(\);$/, 'globalThis.page={api};})();')).runInNewContext(context);
  return context.page.api as (path: string, method?: string, body?: unknown) => Promise<unknown>;
}

test('an open page keeps saving after the local server restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-session-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await startWorkspaceServer(options(directory));
  const port = Number(new URL(first.url).port);
  const html = await (await fetch(first.url)).text();
  await first.close();
  const second = await startWorkspaceServer(options(directory, port));
  t.after(() => second.close());
  const posts: string[] = [];
  const api = pageClient(html, second.url, posts);
  const fresh = (await (await fetch(second.url)).text()).match(/<meta name="jev-csrf" content="([a-f0-9]{64})"/)![1]!;
  assert.ok(await api('/api/validate-draft', 'POST', { document: emptyWorkspaceDocument() }));
  assert.equal(posts.length, 2, 'the stale request is retried exactly once');
  assert.notEqual(posts[0], fresh);
  assert.equal(posts[1], fresh);
  await api('/api/validate-draft', 'POST', { document: emptyWorkspaceDocument() });
  assert.deepEqual(posts.slice(2), [fresh], 'later requests reuse the refreshed token');
});

test('a token that is still rejected after refresh surfaces the expired message instead of looping', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-session-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = await startWorkspaceServer(options(directory));
  t.after(() => server.close());
  const html = await (await fetch(server.url)).text();
  const posts: string[] = [];
  // The page sees a stale token and a reload that still hands out a rejected one, so it retries once and then gives up.
  const api = pageClient(html.replace(/let csrf="[a-f0-9]{64}"/, `let csrf="${'a'.repeat(64)}"`), server.url, posts, `<meta name="jev-csrf" content="${'b'.repeat(64)}">`);
  await assert.rejects(api('/api/validate-draft', 'POST', { document: emptyWorkspaceDocument() }), /page expired/);
  assert.deepEqual(posts, ['a'.repeat(64), 'b'.repeat(64)]);
});
