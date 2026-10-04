import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderWorkspace } from '../src/workspace-ui.js';

test('the served workspace client parses and embeds its session token safely', () => {
  const csrf = 'session-token</script><script>unsafe()</script>';
  const html = renderWorkspace('nonce-test', csrf);
  const scripts = [...html.matchAll(/<script nonce="nonce-test">([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new Script(scripts[0]![1]!));
  assert.doesNotMatch(html, /<script>unsafe/);
  assert.match(html, /session-token\\u003c/);
  assert.match(html, /name="jev-csrf" content="session-token&lt;/);
  assert.doesNotMatch(html, /<script[^>]+src=/);
});

function browserHarness() {
  const documentValue = { version: 1, cohorts: [{ id: 'cohort', name: 'Original cohort', population: 'Adults', description: '', assumptions: [], sources: [], segments: [], personas: [{ id: 'person' }] }], pipelines: [{ id: 'study', name: 'Original study', description: '', stages: [{ id: 'panel' }], cohorts: {} }] };
  let snapshot = { revision: 1, document: documentValue, auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null };
  const elements = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const intervals: Function[] = [];
  const requests: string[] = [];
  function element(id: string) {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', value: '', hidden: false, inert: false, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], focus() {}, select() {}, open: false, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(id);
  }
  const context = {
    document: { getElementById: element, querySelectorAll: () => [], visibilityState: 'visible', addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    window: { addEventListener: (name: string, fn: Function) => listeners.set(name, fn) },
    fetch: async (path: string) => { requests.push(path); return { ok: true, json: async () => JSON.parse(JSON.stringify(snapshot)) }; },
    setTimeout: () => 1, clearTimeout() {}, setInterval: (fn: Function) => { intervals.push(fn); return 1; },
    navigator: {}, confirm: () => { throw new Error('Unexpected native confirmation'); },
  };
  const html = renderWorkspace('test', 'token');
  const script = html.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1]!;
  const exposed = script.replace(/\}\)\(\);$/, 'globalThis.clientTest={S,refresh,reloadSaved,applySnapshot,agents,copyAgentText,act};})();');
  const sandbox = new Script(exposed).runInNewContext(context) as undefined;
  void sandbox;
  return {
    client: (context as typeof context & { clientTest: any }).clientTest,
    element, listeners, intervals, requests,
    setSnapshot: (value: typeof snapshot) => { snapshot = value; },
    snapshot: () => structuredClone(snapshot),
    document: context.document,
  };
}

const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('agent saves refresh clean drafts and preserve valid editor selection without redrawing unchanged forms', async () => {
  const browser = browserHarness();
  await settle();
  const { S, refresh } = browser.client;
  S.tab = 'agents'; S.cohortId = 'cohort'; S.personId = 'person'; S.pipelineId = 'study'; S.stageId = 'panel';
  const snapshot = browser.snapshot();
  snapshot.revision = 2; snapshot.document.cohorts[0]!.name = 'Agent edited cohort';
  browser.setSnapshot(snapshot);
  await refresh();
  assert.equal(S.doc.cohorts[0].name, 'Agent edited cohort');
  assert.equal(S.revision, 2);
  assert.equal(S.cohortId, 'cohort'); assert.equal(S.personId, 'person');
  assert.equal(S.pipelineId, 'study'); assert.equal(S.stageId, 'panel');
  browser.element('app').innerHTML = 'current DOM including cursor and input state';
  await refresh();
  assert.equal(browser.element('app').innerHTML, 'current DOM including cursor and input state');
  snapshot.revision = 3; snapshot.document.cohorts = []; snapshot.document.pipelines = [];
  browser.setSnapshot(snapshot);
  await refresh();
  assert.equal(S.cohortId, null); assert.equal(S.personId, null);
  assert.equal(S.pipelineId, null); assert.equal(S.stageId, null);
});

test('agent saves preserve unsaved browser edits and require confirmation before replacing them', async () => {
  const browser = browserHarness();
  await settle();
  const { S, refresh, reloadSaved } = browser.client;
  S.dirty = true; S.doc.cohorts[0].name = 'My unsaved cohort';
  browser.element('app').innerHTML = 'typed fields not yet applied';
  const snapshot = browser.snapshot();
  snapshot.revision = 2; snapshot.document.cohorts[0]!.name = 'Agent edited cohort';
  browser.setSnapshot(snapshot);
  await refresh();
  assert.equal(S.revision, 1); assert.equal(S.doc.cohorts[0].name, 'My unsaved cohort');
  assert.equal(browser.element('app').innerHTML, 'typed fields not yet applied');
  assert.equal(browser.element('workspaceSync').hidden, false);
  assert.match(browser.element('workspaceSyncMessage').textContent, /Export your draft/);
  await reloadSaved();
  assert.equal(S.dirty, true); assert.equal(S.doc.cohorts[0].name, 'My unsaved cohort');
  assert.equal(browser.element('reloadDialog').open, true);
  browser.client.act(null, { dataset: { act: 'reload-saved-close' } });
  assert.equal(browser.element('reloadDialog').open, false);
  assert.equal(S.dirty, true); assert.equal(S.doc.cohorts[0].name, 'My unsaved cohort');
  await reloadSaved();
  browser.client.act(null, { dataset: { act: 'reload-saved-confirm' } });
  await settle();
  assert.equal(browser.element('reloadDialog').open, false);
  assert.equal(S.dirty, false); assert.equal(S.revision, 2);
  assert.equal(S.doc.cohorts[0].name, 'Agent edited cohort');
  assert.equal(browser.element('workspaceSync').hidden, true);
});

test('background sync pauses while hidden and agent configuration remains escaped and selectable', async () => {
  const browser = browserHarness();
  await settle();
  const requests = browser.requests.length;
  browser.document.visibilityState = 'hidden';
  browser.intervals[0]!();
  await settle();
  assert.equal(browser.requests.length, requests);
  browser.document.visibilityState = 'visible';
  browser.intervals[0]!();
  await settle();
  assert.equal(browser.requests.length, requests + 1);
  browser.client.S.agentConfig = { codexCommand: 'codex mcp add jev -- node </textarea><script>bad()</script>', claudeCommand: 'claude setup', mcpConfig: { mcpServers: {} }, guidePrompt: 'Prepare <personas> with sources.' };
  const html = browser.client.agents();
  assert.match(html, /Your agent prepares\. Jev evaluates\./);
  assert.match(html, /&lt;\/textarea&gt;&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>bad/);
  const field = browser.element('agentSetup');
  field.value = 'setup command'; let selected = false;
  field.select = () => { selected = true; };
  await browser.client.copyAgentText('agentSetup');
  assert.equal(selected, true, 'clipboard-denied fallback selects the setup text');
});
