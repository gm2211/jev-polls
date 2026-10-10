import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderWorkspace } from '../src/workspace-ui.js';

// Runs the served browser client against a one-step study so the Options box, the
// inline drafting-AI choice and the Review run entry points use the real code.
async function harness(engines: any[] = []) {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: '', textContent: '', value: '', hidden: false, inert: false, open: false,
      classList: { add() {}, remove() {}, toggle() {} },
      querySelector: () => null, querySelectorAll: () => [], focus() {}, setAttribute() {}, addEventListener() {},
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return elements.get(id);
  };
  const listeners = new Map<string, Function[]>();
  const timeouts: Function[] = [];
  const responses = new Map<string, unknown>([['/api/local-agents', { engines }], ['/api/chatgpt/status', { connected: false, planEnabled: false }]]);
  const requests: string[] = [];
  const snapshot = { revision: 1, document: { version: 1, cohorts: [], pipelines: [] }, auth: { configured: true, source: 'keychain' }, runs: [], activeRun: null };
  class TestFormData { constructor(private readonly form: any) {} get(name: string) { return this.form.values?.[name] ?? null; } }
  const context: any = {
    location: { origin: 'http://127.0.0.1:4180' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { getElementById: element, querySelectorAll: () => [], visibilityState: 'visible',
      addEventListener: (name: string, fn: Function) => listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    window: { addEventListener() {} },
    fetch: async (path: string, options?: { method?: string }) => {
      requests.push((options?.method ?? 'GET') + ' ' + path);
      const data = responses.get((options?.method ?? 'GET') + ' ' + path) ?? responses.get(path) ?? snapshot;
      return { ok: true, json: async () => JSON.parse(JSON.stringify(data)) };
    },
    setTimeout: (fn: Function) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {}, setInterval: () => 1,
    navigator: {}, URL, URLSearchParams, Blob, TextEncoder, FormData: TestFormData,
  };
  const html = renderWorkspace('options-box', 'token');
  const script = html.match(/<script nonce="options-box">([\s\S]*?)<\/script>/)![1]!;
  const names = ['S', 'pipeline', 'render', 'stageForm', 'flowInspector', 'flowAction', 'setupAction', 'applyStudySetup', 'setupAudienceForm', 'setupCohortPicker', 'optionsBoxCommit', 'optionsBoxFor', 'optionsBoxRecords', 'optionsBoxText', 'optionsBoxFile', 'cohortBlockReason', 'draftProviderChoice', 'loadLocalAgents', 'commandEntries', 'commandExecute', 'reviewPage', 'studyNextClick', 'setupWizardKey'];
  new Script(script.replace(/\}\)\(\);$/, `globalThis.optionsTest={${names.join(',')}};})();`)).runInNewContext(context);
  await new Promise<void>(resolve => setImmediate(resolve));
  const client = context.optionsTest;
  const poll: any = {
    id: 'ask', label: 'First question', kind: 'poll', cohort: 'audience', dependsOn: [], inputs: {},
    questions: { answer: { type: 'choice', label: 'Which name?', instructions: 'Compare options.', criteria: { a: { label: 'Alpha', description: 'Existing description.', note: 'custom' }, b: 'Beta' } } },
  };
  const study: any = { version: 1, id: 'study', name: 'Study', description: 'Which name?', context: {}, cohorts: { audience: 'people' }, stages: [poll] };
  client.S.doc.pipelines = [study];
  client.S.doc.cohorts = [{ id: 'people', name: 'Gamers', personas: [{ id: 'p1', label: 'Gamer' }] }];
  client.S.doc.projects = [{ id: 'project', name: 'Project', description: '', cohortIds: ['people'], pipelineIds: ['study'] }];
  Object.assign(client.S, { projectId: 'project', pipelineId: 'study', stageId: 'ask', tab: 'studies', dirty: false, plan: null, flowPanel: true, localEngine: 'codex' });
  client.S.sections['flow-inspector'] = 'answers';
  const fire = (name: string, event: any) => { for (const fn of listeners.get(name) ?? []) fn(event); };
  const runTimers = () => { for (const fn of timeouts.splice(0)) fn(); };
  return { ...client, study, poll, q: poll.questions.answer, element, fire, runTimers, responses, requests, listeners };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const box = (value: string) => ({ value, matches: (selector: string) => selector === '[data-options-box]' });
const csv = (text: string, name = 'names.csv') => ({ name, size: Buffer.byteLength(text), text: async () => text });

test('the Options stop shows the one-step box with its hint, a live count and the secondary actions', async () => {
  const h = await harness();
  const html = h.flowInspector(h.study, h.poll);
  assert.match(html, /<textarea id="optionsBox"[^>]*data-options-box/);
  assert.match(html, /One option per line\. Add a description after a colon or tab, e\.g\. <code>Orbital Empire: an empire, but in orbit<\/code>/);
  assert.match(html, /Alpha: Existing description\.\nBeta<\/textarea>/);
  assert.match(html, /id="optionsBoxStatus"[^>]*>2 options</);
  for (const label of ['Import file', 'Draft with your AI', 'Paste dialog']) assert.match(html, new RegExp(label));
  assert.match(html, /data-act="answer-list-import"/);
  assert.match(html, /data-act="setup-input" data-source="agent"/);
  assert.match(html, /data-act="answer-list-open"/);
  assert.doesNotMatch(html, /Paste or type|class="setup-input-tabs"/);
  assert.match(html, /data-options-list/);
  assert.match(html, /Edit option Alpha/);
});

test('typing is parsed after a pause into the option list, keeping IDs, descriptions and custom fields of matching names', async () => {
  const h = await harness();
  h.S.dirty = false; h.S.plan = { token: 'reviewed' };
  const before = JSON.stringify(h.q);
  h.fire('input', { target: box('Alpha: Brand new description\nBeta\nOrbital Empire: an empire, but in orbit\nStarfall') });
  assert.equal(JSON.stringify(h.q), before, 'nothing is read until the pause ends');
  assert.equal(h.S.dirty, true);
  assert.equal(h.S.plan, null);
  h.runTimers();
  assert.deepEqual(Object.keys(h.q.criteria).slice(0, 2), ['a', 'b']);
  assert.deepEqual(plain(h.q.criteria.a), { label: 'Alpha', description: 'Brand new description', note: 'custom' });
  assert.equal(h.q.criteria.b, 'Beta');
  const rest = Object.values<any>(h.q.criteria).slice(2);
  assert.deepEqual(plain(rest), [{ label: 'Orbital Empire', description: 'an empire, but in orbit' }, 'Starfall']);
  assert.equal(new Set(Object.keys(h.q.criteria)).size, 4);
  assert.match(h.flowInspector(h.study, h.poll), /id="optionsBoxStatus"[^>]*>4 options</);
});

test('a tab separates the description so names may contain a colon, and blank lines are ignored', async () => {
  const h = await harness();
  assert.deepEqual(plain(h.optionsBoxRecords('Mission: Impossible\tA spy name\n\n  Plain  name \nURL http://x.test\nTime 10:30')), [
    { label: 'Mission: Impossible', description: 'A spy name' },
    { label: 'Plain name', description: '' },
    { label: 'URL http://x.test', description: '' },
    { label: 'Time 10:30', description: '' },
  ]);
  h.optionsBoxCommit('Mission: Impossible\tA spy name\nSecond');
  assert.equal(h.q.criteria[Object.keys(h.q.criteria)[0]!].label, 'Mission: Impossible');
  assert.equal(h.optionsBoxText(h.q), 'Mission: Impossible\tA spy name\nSecond');
});

test('removing a description in the box clears it, and an unchanged multi-line description is kept intact', async () => {
  const h = await harness();
  h.q.criteria.b = { label: 'Beta', description: 'Line one\nLine two' };
  h.optionsBoxCommit('Alpha\nBeta: Line one Line two');
  assert.equal(h.q.criteria.a.description, '');
  assert.equal(h.q.criteria.a.note, 'custom');
  assert.equal(h.q.criteria.b.description, 'Line one\nLine two');
});

test('duplicates keep the previous list, show the error and keep the typed text', async () => {
  const h = await harness();
  const before = JSON.stringify(h.q.criteria);
  const result = h.optionsBoxCommit('Alpha\nBeta\nAlpha');
  assert.match(result.error, /“Alpha” appears more than once/);
  assert.equal(JSON.stringify(h.q.criteria), before);
  const html = h.flowInspector(h.study, h.poll);
  assert.match(html, /Alpha\nBeta\nAlpha<\/textarea>/, 'a re-render keeps what was typed');
  assert.match(html, /id="optionsBoxError"[^>]*role="alert"\s*>[^<]*appears more than once/);
  h.optionsBoxCommit('Alpha\nBeta\nGamma');
  assert.equal(h.optionsBoxFor(h.study, h.poll, 'answer', h.q).error, '');
  assert.equal(Object.keys(h.q.criteria).length, 3);
});

test('more than 255 lines is refused with the limit named', async () => {
  const h = await harness();
  const result = h.optionsBoxCommit(Array.from({ length: 256 }, (_, i) => 'Option ' + i).join('\n'));
  assert.match(result.error, /Use up to 255 options\. This list has 256\./);
  assert.equal(Object.keys(h.q.criteria).length, 2);
});

test('fewer than two options are kept but padded with blanks, so the stop stays unfinished', async () => {
  const h = await harness();
  h.optionsBoxCommit('Only one');
  assert.equal(Object.keys(h.q.criteria).length, 2);
  assert.equal(Object.values<any>(h.q.criteria).filter(v => String(v.label ?? v).trim()).length, 1);
  assert.match(h.flowInspector(h.study, h.poll), />1 option · add at least one more</);
  h.optionsBoxCommit('');
  assert.deepEqual(Object.values(h.q.criteria), ['', '']);
  assert.match(h.flowInspector(h.study, h.poll), />No options yet</);
  assert.doesNotMatch(h.flowInspector(h.study, h.poll), /Unnamed option/, 'blank placeholders are not listed');
});

test('the box mirrors edits made elsewhere, such as removing an option', async () => {
  const h = await harness();
  h.optionsBoxCommit('Alpha\nBeta\nGamma');
  h.setupAction('setup-remove-option', { dataset: { key: 'a' } });
  const html = h.flowInspector(h.study, h.poll);
  assert.match(html, /data-options-box[^>]*>Beta\nGamma<\/textarea>/);
  assert.match(html, />2 options</);
});

test('leaving mid-typing still saves the text: submitting the setup form reads the box immediately', async () => {
  const h = await harness();
  h.fire('input', { target: box('Alpha\nBeta\nPending option') });
  assert.equal(Object.keys(h.q.criteria).length, 2);
  h.applyStudySetup({ dataset: { questionId: 'answer' }, values: { setupPrompt: 'Which name?' }, querySelector: (selector: string) => selector === '[data-options-box]' ? box('Alpha\nBeta\nPending option') : null, querySelectorAll: () => [] });
  assert.equal(Object.keys(h.q.criteria).length, 3);
  assert.equal(Object.values<any>(h.q.criteria).at(-1), 'Pending option');
});

test('a re-render before the pause ends does not discard typed text', async () => {
  const h = await harness();
  h.fire('input', { target: box('Alpha\nBeta\nTyped but unread') });
  assert.match(h.flowInspector(h.study, h.poll), /Typed but unread<\/textarea>/);
});

test('dropping a CSV with Name and Description columns fills the box and the list', async () => {
  const h = await harness();
  await h.optionsBoxFile(csv('Name,Description\nAlpha,"Fresh, precise"\nOrbital Empire,An empire in orbit'));
  assert.deepEqual(plain(h.q.criteria.a), { label: 'Alpha', description: 'Fresh, precise', note: 'custom' });
  assert.equal(Object.keys(h.q.criteria).length, 2);
  assert.deepEqual(plain(Object.values(h.q.criteria).at(-1)), { label: 'Orbital Empire', description: 'An empire in orbit' });
  assert.equal(h.S.dirty, true);
});

test('dropping a JSON file reads names, pairs and objects, and a plain CSV column reads every value', async () => {
  const h = await harness();
  await h.optionsBoxFile(csv(JSON.stringify(['One', ['Two', 'Second'], { name: 'Three', description: 'Third' }]), 'names.json'));
  assert.deepEqual(plain(Object.values(h.q.criteria)), ['One', { label: 'Two', description: 'Second' }, { label: 'Three', description: 'Third' }]);
  await h.optionsBoxFile(csv('Red\nGreen\nBlue'));
  assert.deepEqual(plain(Object.values(h.q.criteria).map((v: any) => v.label ?? v)), ['Red', 'Green', 'Blue']);
});

test('a dropped file with a problem shows it and leaves the list alone', async () => {
  const h = await harness();
  const before = JSON.stringify(h.q.criteria);
  await h.optionsBoxFile(csv('not json', 'broken.json'));
  assert.match(h.element('optionsBoxError').textContent, /JSON is invalid/);
  assert.equal(h.element('optionsBoxError').hidden, false);
  await h.optionsBoxFile({ name: 'big.csv', size: 300 * 1024, text: async () => '' });
  assert.match(h.element('optionsBoxError').textContent, /too large/);
  assert.equal(JSON.stringify(h.q.criteria), before);
});

test('the drop listener takes one file at a time and ignores drops elsewhere', async () => {
  const h = await harness();
  const target = { classList: { remove() {} } };
  const event = (files: any[]) => ({ target: { closest: (selector: string) => selector === '[data-options-box]' ? target : null }, dataTransfer: { files }, preventDefault() { (event as any).prevented = true; } });
  h.fire('drop', event([csv('a'), csv('b')]));
  assert.match(h.element('optionsBoxError').textContent, /one file at a time/);
  h.fire('drop', { target: { closest: () => null }, dataTransfer: { files: [csv('x')] }, preventDefault() { throw Error('must not intercept other drops'); } });
});

test('Draft with your AI swaps the box for the drafting panel and Back to options returns', async () => {
  const h = await harness();
  h.setupAction('setup-input', { dataset: { source: 'agent' } });
  let html = h.flowInspector(h.study, h.poll);
  assert.match(html, /id="optionAgentPrompt"/);
  assert.doesNotMatch(html, /data-options-box/);
  h.setupAction('setup-input', { dataset: { source: 'manual' } });
  html = h.flowInspector(h.study, h.poll);
  assert.match(html, /data-options-box/);
});

test('the Options tab turns done as soon as two options are read', async () => {
  const h = await harness();
  h.optionsBoxCommit('');
  assert.match(h.flowInspector(h.study, h.poll), /data-section="answers" aria-selected="true" data-todo="true"/);
  h.optionsBoxCommit('Alpha\nBeta');
  assert.match(h.flowInspector(h.study, h.poll), /data-section="answers" aria-selected="true" data-done="true"/);
});

test('Who answers says the drafting AI writes the people and Jev only answers', async () => {
  const h = await harness([{ id: 'codex', label: 'Codex', available: true }]);
  h.S.doc.cohorts = [];
  h.S.localEngines = [{ id: 'codex', label: 'Codex', available: true }];
  const html = h.setupAudienceForm(h.study, h.poll, false, false);
  assert.match(html, /Your drafting AI writes the people; Jev only answers as them\./);
  assert.doesNotMatch(html, /Jev drafts|Jev generates/);
});

test('with no usable drafting AI the audience form offers the same choice and labels in place', async () => {
  const h = await harness();
  h.S.localEngines = [{ id: 'claude', label: 'Claude Code', available: false, message: 'Sign in with claude login.' }, { id: 'codex', label: 'Codex', available: true }];
  h.S.localEngine = 'claude'; h.S.cohortPrompt = 'Gamers'; h.S.cohortSize = 5;
  const html = h.setupAudienceForm(h.study, h.poll, false, false);
  assert.match(html, /data-inline-provider/);
  assert.match(html, /<select id="f-localEngine-inline" name="localEngine">/);
  assert.match(html, /<option value="claude" selected>Claude Code · unavailable<\/option>/);
  assert.match(html, /<option value="codex" >Codex · ready<\/option>/);
  assert.match(html, /Sign in with claude login\./);
  assert.match(html, /Choose an available drafting AI above\./);
  assert.doesNotMatch(html, /AI settings above/);
  assert.match(html, /data-act="flow-audience-generate"[^>]*disabled/);
});

test('with no drafting AI ready at all the form says to sign in and refresh', async () => {
  const h = await harness();
  h.S.localEngines = [{ id: 'claude', label: 'Claude Code', available: false }, { id: 'codex', label: 'Codex', available: false }];
  h.S.cohortPrompt = 'Gamers'; h.S.cohortSize = 5;
  assert.match(h.setupAudienceForm(h.study, h.poll, false, false), /No drafting AI is ready\. Sign in to one, then refresh connections\./);
  assert.match(h.setupAudienceForm(h.study, h.poll, false, false), /data-act="assistant-refresh"/);
});

test('a ready drafting AI hides the inline choice until one was needed, and the choice then stays', async () => {
  const h = await harness();
  h.S.localEngines = [{ id: 'codex', label: 'Codex', available: true }];
  h.S.localEngine = 'codex';
  assert.doesNotMatch(h.setupAudienceForm(h.study, h.poll, false, false), /data-inline-provider/);
  h.S.localEngines = [{ id: 'codex', label: 'Codex', available: false }];
  assert.match(h.setupAudienceForm(h.study, h.poll, false, false), /data-inline-provider/);
  h.S.localEngines = [{ id: 'codex', label: 'Codex', available: true }];
  assert.match(h.setupAudienceForm(h.study, h.poll, false, false), /data-inline-provider/, 'choosing a provider does not make the select vanish');
});

test('exactly one ready provider is preselected when connections load', async () => {
  const h = await harness();
  h.S.localEngine = 'claude';
  h.responses.set('/api/local-agents', { engines: [{ id: 'claude', label: 'Claude Code', available: false }, { id: 'codex', label: 'Codex', available: true }] });
  await h.loadLocalAgents();
  assert.equal(h.S.localEngine, 'codex');
});

test('two ready providers leave the selection alone, and an unknown selection takes the first ready one', async () => {
  const h = await harness();
  h.S.localEngine = 'claude';
  h.responses.set('/api/local-agents', { engines: [{ id: 'claude', label: 'Claude Code', available: true }, { id: 'codex', label: 'Codex', available: true }] });
  await h.loadLocalAgents();
  assert.equal(h.S.localEngine, 'claude');
  h.S.localEngine = 'gone';
  await h.loadLocalAgents();
  assert.equal(h.S.localEngine, 'claude');
});

test('outside the audience form the reason still points at AI settings', async () => {
  const h = await harness();
  h.S.localEngines = [{ id: 'claude', label: 'Claude Code', available: false }, { id: 'codex', label: 'Codex', available: true }];
  h.S.localEngine = 'claude';
  h.S.cohortPrompt = 'Gamers'; h.S.cohortSize = 5;
  assert.equal(h.cohortBlockReason(), 'Choose an available provider in AI settings above.');
  assert.equal(h.cohortBlockReason(true), 'Choose an available drafting AI above.');
});

test('the step wizard\'s final Review run opens the review panel action, not the full page', async () => {
  const h = await harness();
  h.S.sections['flow-inspector'] = 'question';
  h.S.sections[h.setupWizardKey(h.study, h.poll, 'answer')] = 'review';
  const html = h.stageForm(h.study, h.poll);
  assert.match(html, /<button type="button" class="button primary" data-act="next-review" >Review run<\/button>/);
  assert.doesNotMatch(html, /data-act="review"/);
});

test('Review run in the command palette opens the same slide-over as the header action', async () => {
  const h = await harness();
  assert.deepEqual(plain(h.commandEntries().filter((row: any) => row.id === 'review-run')), [{ id: 'review-run', label: 'Review run', detail: 'Current study · opens the review panel', action: 'next-review' }]);
  h.responses.set('POST /api/plan', { pipelineId: 'study', provider: 'typesafe', model: 'jev', maxRequests: 8, stages: [{ id: 'ask', label: 'Ask', requests: 8 }], warnings: [], revision: 1, planToken: 't' });
  h.S.tab = 'cohorts'; h.S.sections.pipeline = 'advanced';
  h.commandExecute('review-run');
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(h.S.tab, 'studies');
  assert.equal(h.S.reviewPanel, true);
  assert.equal(h.reviewPage(), false, 'the full review page stays closed');
  assert.equal(h.requests.filter((r: string) => r === 'POST /api/plan').length, 1);
  assert.match(h.element('app').innerHTML, /aria-label="Review run"/);
});

test('the palette offers no Review run without a study that has steps', async () => {
  const h = await harness();
  h.S.pipelineId = null;
  assert.equal(h.commandEntries().some((row: any) => row.id === 'review-run'), false);
});
