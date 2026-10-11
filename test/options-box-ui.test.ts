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
  const names = ['S', 'pipeline', 'render', 'stageForm', 'flowInspector', 'flowAction', 'setupAction', 'applyStudySetup', 'setupAudienceForm', 'setupCohortPicker', 'optionsBoxCommit', 'optionsBoxAdd', 'optionsBoxFlush', 'optionsBoxRecords', 'optionsBoxFile', 'optionsBoxKeydown', 'optionsBoxPaste', 'cohortBlockReason', 'draftProviderChoice', 'loadLocalAgents', 'commandEntries', 'commandExecute', 'reviewPage', 'studyNextClick', 'setupWizardKey'];
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
const csv = (text: string, name = 'names.csv') => ({ name, size: Buffer.byteLength(text), text: async () => text });
// A row input as the input listener sees it: its field and the row's option key.
const field = (key: string, name: 'label' | 'description', value: string) => ({ value, dataset: { optionField: name }, matches: (selector: string) => selector === '[data-option-field]', closest: () => ({ dataset: { optionKey: key } }) });
const addRow = (value: string) => ({ value, matches: (selector: string) => selector === '[data-option-add]' });
const labels = (q: any) => Object.entries<any>(q.criteria).map(([key, value]) => value?.label ?? value ?? key);

test('the Options stop is one light list of rows once options exist, and the ways to fill it as exclusive choices', async () => {
  const h = await harness();
  const html = h.flowInspector(h.study, h.poll);
  assert.doesNotMatch(html, /<textarea[^>]*optionsBox/, 'no free-text box');
  assert.equal((html.match(/class="options-row" data-option-key=/g) || []).length, 2);
  assert.match(html, /data-option-key="a"><input data-option-field="label" value="Alpha"[^>]*><input data-option-field="description" value="Existing description\."/);
  assert.match(html, /data-option-key="b"><input data-option-field="label" value="Beta"[^>]*><input data-option-field="description" value=""/);
  assert.match(html, /data-act="setup-remove-option" data-key="a" aria-label="Remove Alpha"[^>]*disabled/, 'two options cannot shrink further');
  assert.match(html, /<input data-option-add value="" placeholder="Add an option, or paste a list"/);
  assert.match(html, /id="optionsBoxStatus"[^>]*>2 options</);
  assert.doesNotMatch(html, /Probabilities 0–1|totaling 1/, 'the output format is not part of filling in options');
  assert.doesNotMatch(html, /Edit option Alpha|Paste dialog|data-act="answer-list-open"|options-source"|list-pager|listPage/, 'the options show once, unpaged');
  assert.match(html, /class="button small" data-act="answer-list-import"><svg[^]*?<\/svg> Import</, 'importing is a small icon button, not a text link');
  assert.match(html, /class="button small" data-act="setup-input" data-source="agent"><svg[^]*?<\/svg> Draft with AI</, 'drafting is a small icon button, not a text link');
  h.S.sections['setup-input-study-ask-answer'] = 'choose';
  const choose = h.flowInspector(h.study, h.poll);
  assert.match(choose, /How do you want to add options\?/);
  assert.equal((choose.match(/class="setup-type-card" data-act="setup-input"/g) || []).length, 3);
  assert.match(choose, /data-source="manual" aria-pressed="true"><strong>Type a list/);
  h.S.sections['setup-input-study-ask-answer'] = 'file';
  const file = h.flowInspector(h.study, h.poll);
  assert.match(file, /data-source="file" aria-pressed="true"/);
  assert.match(file, /data-act="answer-list-import"/);
  assert.doesNotMatch(file, /data-options-box/, 'only the chosen way shows its input');
  h.S.sections['setup-input-study-ask-answer'] = 'manual';
  assert.match(h.flowInspector(h.study, h.poll), /data-options-box/);
});

test('typing in a row edits that option at once, keeping its ID and custom fields', async () => {
  const h = await harness();
  h.S.dirty = false; h.S.plan = { token: 'reviewed' };
  h.fire('input', { target: field('a', 'label', 'Alpha Prime') });
  assert.deepEqual(plain(h.q.criteria.a), { label: 'Alpha Prime', description: 'Existing description.', note: 'custom' });
  assert.equal(h.S.dirty, true);
  assert.equal(h.S.plan, null);
  h.fire('input', { target: field('b', 'description', 'Second letter') });
  assert.deepEqual(plain(h.q.criteria.b), { label: 'Beta', description: 'Second letter' });
  h.fire('input', { target: field('b', 'label', 'Bravo') });
  assert.deepEqual(plain(h.q.criteria.b), { label: 'Bravo', description: 'Second letter' });
  assert.deepEqual(Object.keys(h.q.criteria), ['a', 'b']);
  assert.match(h.flowInspector(h.study, h.poll), /value="Bravo"/);
});

test('a plain name stays a plain string until it gets a description', async () => {
  const h = await harness();
  h.fire('input', { target: field('b', 'label', 'Bravo') });
  assert.equal(h.q.criteria.b, 'Bravo');
});

test('the add row adds one option, or one per line of a pasted list, splitting “Name: description”', async () => {
  const h = await harness();
  h.optionsBoxAdd('Gamma: Third letter');
  assert.deepEqual(labels(h.q), ['Alpha', 'Beta', 'Gamma']);
  assert.deepEqual(plain(Object.values(h.q.criteria).at(-1)), { label: 'Gamma', description: 'Third letter' });
  h.optionsBoxAdd('Mission: Impossible\tA spy name\n\n  Delta  \nEcho');
  assert.deepEqual(labels(h.q), ['Alpha', 'Beta', 'Gamma', 'Mission: Impossible', 'Delta', 'Echo']);
  assert.equal(new Set(Object.keys(h.q.criteria)).size, 6);
  assert.match(h.flowInspector(h.study, h.poll), /id="optionsBoxStatus"[^>]*>6 options</);
});

test('a list pasted into a row name lands right after that row', async () => {
  const h = await harness();
  h.optionsBoxAdd('One\nTwo', 'a');
  assert.deepEqual(labels(h.q), ['Alpha', 'One', 'Two', 'Beta']);
});

test('pasting several lines is intercepted; a single line pastes normally', async () => {
  const h = await harness();
  let prevented = 0;
  const paste = (text: string) => ({ target: { matches: (selector: string) => selector.includes('[data-option-add]'), closest: () => null }, clipboardData: { getData: () => text }, preventDefault() { prevented++; } });
  h.optionsBoxPaste(paste('Just one'));
  assert.equal(prevented, 0);
  assert.equal(Object.keys(h.q.criteria).length, 2);
  h.optionsBoxPaste(paste('Gamma\nDelta\n'));
  assert.equal(prevented, 1);
  assert.deepEqual(labels(h.q), ['Alpha', 'Beta', 'Gamma', 'Delta']);
});

test('Enter in the add row adds it; Enter in a row moves to the add row instead of submitting', async () => {
  const h = await harness();
  let prevented = 0;
  const key = (target: any) => ({ key: 'Enter', target, preventDefault() { prevented++; } });
  h.optionsBoxKeydown(key({ value: 'Gamma', matches: (selector: string) => selector.includes('[data-option-add]') }));
  assert.deepEqual(labels(h.q), ['Alpha', 'Beta', 'Gamma']);
  h.optionsBoxKeydown(key({ value: 'Alpha', matches: (selector: string) => selector.includes('[data-option-field]') }));
  assert.equal(prevented, 2);
  assert.equal(Object.keys(h.q.criteria).length, 3);
});

test('blank placeholder rows give way to the first options added', async () => {
  const h = await harness();
  h.q.criteria = { option_1: '', option_2: '' };
  assert.match(h.flowInspector(h.study, h.poll), />No options yet</);
  h.optionsBoxAdd('Only one');
  assert.equal(Object.keys(h.q.criteria).length, 2, 'padded back to two rows');
  assert.deepEqual(labels(h.q)[0], 'Only one');
  assert.match(h.flowInspector(h.study, h.poll), />1 option · add at least one more</);
  h.optionsBoxAdd('Second');
  assert.deepEqual(labels(h.q), ['Only one', 'Second']);
});

test('duplicate names show the problem until one is renamed', async () => {
  const h = await harness();
  h.fire('input', { target: field('b', 'label', 'Alpha') });
  assert.match(h.flowInspector(h.study, h.poll), /id="optionsBoxError"[^>]*role="alert"\s*>“Alpha” appears more than once/);
  h.fire('input', { target: field('b', 'label', 'Beta') });
  assert.match(h.flowInspector(h.study, h.poll), /id="optionsBoxError"[^>]*hidden/);
});

test('more than 255 options is refused with the limit named', async () => {
  const h = await harness();
  const result = h.optionsBoxAdd(Array.from({ length: 254 }, (_, i) => 'Option ' + i).join('\n'));
  assert.match(result.error, /Use up to 255 options\. This list would have 256\./);
  assert.equal(Object.keys(h.q.criteria).length, 2);
  assert.match(h.optionsBoxCommit(Array.from({ length: 256 }, (_, i) => 'Option ' + i).join('\n')).error, /This list has 256\./);
});

test('removing an option drops its row', async () => {
  const h = await harness();
  h.optionsBoxAdd('Gamma');
  h.setupAction('setup-remove-option', { dataset: { key: 'a' } });
  const html = h.flowInspector(h.study, h.poll);
  assert.doesNotMatch(html, /value="Alpha"/);
  assert.match(html, />2 options</);
});

test('leaving with text in the add row still adds it', async () => {
  const h = await harness();
  h.fire('input', { target: addRow('Pending option') });
  assert.match(h.flowInspector(h.study, h.poll), /data-option-add value="Pending option"/, 'a re-render keeps the unsent text');
  h.applyStudySetup({ dataset: { questionId: 'answer' }, values: { setupPrompt: 'Which name?' }, querySelector: (selector: string) => selector === '[data-options-box]' ? {} : null, querySelectorAll: () => [] });
  assert.deepEqual(labels(h.q), ['Alpha', 'Beta', 'Pending option']);
  assert.match(h.flowInspector(h.study, h.poll), /data-option-add value=""/);
});

test('dropping a CSV with Name and Description columns replaces the list, keeping matching IDs', async () => {
  const h = await harness();
  await h.optionsBoxFile(csv('Name,Description\nAlpha,"Fresh, precise"\nOrbital Empire,An empire in orbit'));
  assert.deepEqual(plain(h.q.criteria.a), { label: 'Alpha', description: 'Fresh, precise', note: 'custom' });
  assert.equal(Object.keys(h.q.criteria).length, 2);
  assert.deepEqual(plain(Object.values(h.q.criteria).at(-1)), { label: 'Orbital Empire', description: 'An empire in orbit' });
  assert.equal(h.S.dirty, true);
});

test('an imported list of 14 options shows as 14 rows with no pager', async () => {
  const h = await harness();
  await h.optionsBoxFile(csv('Name\n' + Array.from({ length: 14 }, (_, i) => 'Option ' + (i + 1)).join('\n')));
  const html = h.flowInspector(h.study, h.poll);
  assert.equal((html.match(/class="options-row" data-option-key=/g) || []).length, 14);
  assert.doesNotMatch(html, /listPage|1–4 of/);
});

test('dropping a JSON file reads names, pairs and objects, and a plain CSV column reads every value', async () => {
  const h = await harness();
  await h.optionsBoxFile(csv(JSON.stringify(['One', ['Two', 'Second'], { name: 'Three', description: 'Third' }]), 'names.json'));
  assert.deepEqual(plain(Object.values(h.q.criteria)), ['One', { label: 'Two', description: 'Second' }, { label: 'Three', description: 'Third' }]);
  await h.optionsBoxFile(csv('Red\nGreen\nBlue'));
  assert.deepEqual(labels(h.q), ['Red', 'Green', 'Blue']);
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

test('Draft with your AI swaps the list for the drafting panel and Back to options returns', async () => {
  const h = await harness();
  h.setupAction('setup-input', { dataset: { source: 'agent' } });
  let html = h.flowInspector(h.study, h.poll);
  assert.match(html, /id="optionAgentPrompt"/);
  assert.doesNotMatch(html, /data-options-box/);
  h.setupAction('setup-input', { dataset: { source: 'manual' } });
  html = h.flowInspector(h.study, h.poll);
  assert.match(html, /data-options-box/);
});

test('the Options tab turns done as soon as two options are named', async () => {
  const h = await harness();
  h.q.criteria = { option_1: '', option_2: '' };
  assert.match(h.flowInspector(h.study, h.poll), /data-section="answers" aria-selected="true" data-todo="true"/);
  h.optionsBoxAdd('Alpha\nBeta');
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

test('the audience form stays compact: hint as placeholder, count beside a ready AI with no extra status line', async () => {
  const h = await harness();
  h.S.localEngines = [{ id: 'claude', label: 'Claude Code', available: true, message: 'Ready with your existing Claude Code login.' }];
  h.S.localEngine = 'claude'; h.S.draftProviderInline = true;
  const html = h.setupAudienceForm(h.study, h.poll, false, false);
  assert.match(html, /<textarea placeholder="Their context, habits and how they differ\. A few sentences are enough\." id="f-cohortPrompt-audience"/);
  assert.match(html, /<div class="setup-audience-row">[\s\S]*?name="cohortSize"[\s\S]*?data-inline-provider/);
  assert.doesNotMatch(html, /Ready with your existing Claude Code login|Refresh connections/);
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
