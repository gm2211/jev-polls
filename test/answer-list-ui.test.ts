import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { ANSWER_LIST_CLIENT } from '../src/answer-list-ui.js';
import { STUDY_SETUP_CLIENT } from '../src/study-setup-ui.js';

function importerHarness(type = 'choice') {
  const question: any = { type, label: 'Which fits?', instructions: 'Keep custom instructions.', criteria: type === 'choice' ? {
    stable_a: { label: 'Alpha', description: 'Existing Alpha description.', note: 'Keep custom property.' },
    stable_b: { label: 'Beta', description: 'Existing Beta description.' },
  } : ['Low', 'High'] };
  const stage = { id: 'stage', questions: { answer: question } };
  const pipeline = { id: 'study', stages: [stage] };
  const S = { doc: { pipelines: [pipeline] }, projectId: 'project', pipelineId: 'study', stageId: 'stage',
    sections: {}, listPages: {}, dirty: false, plan: { token: 'reviewed' } };
  const elements = new Map<string, any>();
  const listeners = new Map<string, Function>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, { value: '', innerHTML: '', textContent: '', checked: false, hidden: false, disabled: false,
      open: false, showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, click() {},
      setAttribute(name: string, value: string) { this[name] = value; },
      classList: { add() {}, remove() {} },
      addEventListener(name: string, listener: Function) { listeners.set(id + ':' + name, listener); },
    });
    return elements.get(id);
  };
  const requests: unknown[] = [];
  let nextId = 0;
  const context: any = {
    S, TextEncoder, document: { getElementById: element, addEventListener: (name: string, listener: Function) => listeners.set(name, listener) },
    flushForms() {}, pipeline: () => pipeline, selectedStage: () => stage,
    id: () => 'generated_' + ++nextId, render() {}, say() {},
    esc: (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    fetch: (...args: unknown[]) => { requests.push(args); throw Error('Importer must stay local'); },
  };
  new Script(STUDY_SETUP_CLIENT + ANSWER_LIST_CLIENT + '\nglobalThis.importerTest={openAnswerList,readAnswerListFile,applyAnswerList,answerListValues,updateAnswerList,answerListAction,draft:()=>answerListDraft};').runInNewContext(context);
  return { ...context.importerTest, S, question, element, requests, listeners };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const csv = (text: string) => ({ name: 'options.csv', size: Buffer.byteLength(text), text: async () => text });
const json = (value: unknown) => { const text = JSON.stringify(value); return { name: 'options.json', size: Buffer.byteLength(text), text: async () => text }; };

test('CSV recognizes name and description headers, previews full records, and preserves IDs and custom fields', async () => {
  const importer = importerHarness();
  const { question, element, draft, openAnswerList, readAnswerListFile, applyAnswerList, requests, S } = importer;
  openAnswerList();
  const before = JSON.stringify(question);
  await readAnswerListFile(csv('Name,Description\r\nAlpha,"Fresh, precise description"\r\nBeta,"Line one\nLine two"'));
  assert.equal(draft().header, true);
  assert.equal(draft().column, 0);
  assert.equal(draft().descriptionColumn, 1);
  assert.equal(JSON.stringify(question), before, 'preview never commits criteria');
  assert.match(element('answerListPreview').innerHTML, /Fresh, precise description/);
  assert.match(element('answerListPreview').innerHTML, /Line one\nLine two/);
  applyAnswerList(false);
  assert.equal(S.sections['setup-wizard-study-stage-answer'],'options');
  assert.deepEqual(plain(question.criteria), {
    stable_a: { label: 'Alpha', description: 'Fresh, precise description', note: 'Keep custom property.' },
    stable_b: { label: 'Beta', description: 'Line one\nLine two' },
  });
  assert.equal(question.instructions, 'Keep custom instructions.');
  assert.equal(S.dirty, true);
  assert.equal(S.plan, null);
  assert.deepEqual(requests, []);
});

test('CSV maps recognized headers in any order and keeps descriptions when none is selected', async () => {
  const importer = importerHarness();
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('description,title\nFresh Alpha,Alpha\nFresh Beta,Beta'));
  assert.equal(importer.draft().column, 1);
  assert.equal(importer.draft().descriptionColumn, 0);
  importer.draft().descriptionColumn = -1;
  importer.applyAnswerList(false);
  assert.equal(importer.question.criteria.stable_a.description, 'Existing Alpha description.');
  assert.equal(importer.question.criteria.stable_a.note, 'Keep custom property.');
  assert.equal(importer.question.criteria.stable_b.description, 'Existing Beta description.');
});

test('provided empty descriptions clear old descriptions and adding records preserves existing options', async () => {
  const importer = importerHarness();
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('option,description\nAlpha,\nBeta,Replacement Beta'));
  importer.applyAnswerList(false);
  assert.equal(importer.question.criteria.stable_a.description, '');
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('label,description\nGamma,A new option\nDelta,Another option'));
  importer.applyAnswerList(true);
  assert.equal(importer.question.criteria.stable_b.description, 'Replacement Beta');
  assert.deepEqual(plain(Object.values(importer.question.criteria).slice(2)), [
    { label: 'Gamma', description: 'A new option' }, { label: 'Delta', description: 'Another option' },
  ]);
});

test('single-column name header needs no manual mapping and unknown headers are never guessed', async () => {
  const importer = importerHarness();
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('\uFEFFname\nAlpha\nBeta'));
  assert.equal(importer.draft().header, true);
  assert.deepEqual(plain(importer.answerListValues()), ['Alpha', 'Beta']);
  importer.applyAnswerList(false);
  assert.equal(importer.question.criteria.stable_a.description, 'Existing Alpha description.');
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('Alpha,One\nBeta,Two'));
  assert.equal(importer.draft().header, false);
  assert.equal(importer.draft().descriptionColumn, -1);
  assert.deepEqual(plain(importer.answerListValues()), ['Alpha', 'Beta']);
});

test('duplicate or missing names and stale targets reject import without changing criteria', async () => {
  const importer = importerHarness();
  const original = JSON.stringify(importer.question);
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('name,description\nAlpha,First\nAlpha,Duplicate'));
  assert.throws(() => importer.applyAnswerList(false), /different text/);
  assert.equal(JSON.stringify(importer.question), original);
  await importer.readAnswerListFile(csv('name,description\nAlpha,First\n,Missing name'));
  assert.throws(() => importer.applyAnswerList(false), /Every CSV row needs a name/);
  assert.equal(JSON.stringify(importer.question), original);
  await importer.readAnswerListFile(csv('name,description\nAlpha,First\nBeta,Second'));
  importer.question.criteria.stable_a.description = 'Changed elsewhere';
  const changed = JSON.stringify(importer.question);
  assert.throws(() => importer.applyAnswerList(false), /question changed/);
  assert.equal(JSON.stringify(importer.question), changed);
});

test('CSV descriptions stay escaped in preview and ordered scales retain label-only semantics', async () => {
  const importer = importerHarness();
  importer.openAnswerList();
  await importer.readAnswerListFile(csv('name,description\nAlpha,<script>unsafe()</script>\nBeta,<img src=x>'));
  const preview = importer.element('answerListPreview').innerHTML;
  assert.doesNotMatch(preview, /<script>|<img/);
  assert.match(preview, /&lt;script&gt;/);
  const scale = importerHarness('score');
  scale.openAnswerList();
  await scale.readAnswerListFile(csv('name,description\nLow,Details\nHigh,More details'));
  assert.equal(scale.draft().descriptionColumn, -1);
  assert.equal(scale.element('answerListDescriptionMapping').hidden, true);
  scale.applyAnswerList(false);
  assert.deepEqual(plain(scale.question.criteria), ['Low', 'High']);
});

test('file import starts at preview, reveals columns only on request, and preserves separate paste text', async () => {
  const importer = importerHarness();
  importer.openAnswerList(true);
  assert.equal(importer.element('answerListPaste').hidden, true);
  assert.equal(importer.element('answerListMapping').hidden, true);
  await importer.readAnswerListFile(csv('name,description\nAlpha,Fresh Alpha\nBeta,Fresh Beta'));
  assert.equal(importer.element('answerListPaste').hidden, true);
  assert.equal(importer.element('answerListMapping').hidden, true);
  assert.equal(importer.element('answerListColumnsTab').hidden, false);
  importer.answerListAction('answer-list-columns');
  assert.equal(importer.element('answerListMapping').hidden, false);
  assert.equal(importer.element('answerListPreview').hidden, true);
  importer.answerListAction('answer-list-paste');
  assert.equal(importer.element('answerListPaste').hidden, false);
  assert.equal(importer.element('answerListText').value, '');
  importer.element('answerListText').value = 'Gamma, Delta';
  importer.updateAnswerList();
  assert.deepEqual(plain(importer.answerListValues()), ['Gamma', 'Delta']);
  importer.answerListAction('answer-list-preview');
  assert.deepEqual(plain(importer.answerListValues()), ['Alpha', 'Beta']);
  importer.answerListAction('answer-list-paste');
  assert.equal(importer.element('answerListText').value, 'Gamma, Delta');
  assert.equal(importer.question.criteria.stable_a.description, 'Existing Alpha description.');
});

test('JSON imports string names, description tuples and objects without executing or dropping details', async () => {
  const importer = importerHarness();
  importer.openAnswerList(true);
  await importer.readAnswerListFile(json(['Alpha', ['Beta', 'New Beta description'], { name: 'Gamma', description: 'A new choice' }, { label: 'Delta', description: '<script>unsafe()</script>' }]));
  assert.equal(importer.element('answerListColumnsTab').hidden, true);
  assert.equal(importer.element('answerListPaste').hidden, true);
  assert.match(importer.element('answerListPreview').innerHTML, /New Beta description/);
  assert.doesNotMatch(importer.element('answerListPreview').innerHTML, /<script>/);
  importer.applyAnswerList(false);
  assert.equal(importer.question.criteria.stable_a.description, 'Existing Alpha description.');
  assert.equal(importer.question.criteria.stable_b.description, 'New Beta description');
  assert.deepEqual(plain(Object.values(importer.question.criteria).slice(2)), [
    { label: 'Gamma', description: 'A new choice' }, { label: 'Delta', description: '<script>unsafe()</script>' },
  ]);
  assert.deepEqual(importer.requests, []);
});

test('JSON rejects malformed shapes, non-text fields, duplicate names and oversized content atomically', async () => {
  for (const value of [{ name: 'Not an array' }, [42, 'Beta'], [['Alpha'], 'Beta'], [{ name: 'Alpha', description: 10 }, 'Beta'], [' ', 'Beta'], null]) {
    const importer = importerHarness();
    importer.openAnswerList(true);
    const before = JSON.stringify(importer.question);
    await importer.readAnswerListFile(json(value));
    assert.equal(importer.element('answerListError').hidden, false);
    assert.equal(JSON.stringify(importer.question), before);
    assert.equal(importer.element('answerListReplace').disabled, true);
  }
  const importer = importerHarness();
  importer.openAnswerList(true);
  await importer.readAnswerListFile(json(['Alpha', 'Alpha']));
  assert.throws(() => importer.applyAnswerList(false), /different text/);
  const before = JSON.stringify(importer.question);
  await importer.readAnswerListFile({ name: 'huge.json', size: 1, text: async () => JSON.stringify(['a'.repeat(262144), 'Beta']) });
  assert.match(importer.element('answerListError').textContent, /maximum size/);
  assert.equal(JSON.stringify(importer.question), before);
});

test('main-editor and dialog dropzones accept one file into local preview without applying it', async () => {
  const importer = importerHarness();
  const before = JSON.stringify(importer.question);
  let prevented = 0;
  importer.listeners.get('drop')!({ target: { closest: () => ({}) }, dataTransfer: { files: [json([['Alpha', 'Fresh'], ['Beta', 'Other']])] }, preventDefault() { prevented++; } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(importer.element('answerListDialog').open, true);
  assert.match(importer.element('answerListPreview').innerHTML, /Fresh/);
  assert.equal(JSON.stringify(importer.question), before);
  importer.listeners.get('answerListDrop:drop')!({ dataTransfer: { files: [csv('name\nGamma\nDelta')] }, preventDefault() { prevented++; } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(plain(importer.answerListValues()), ['Gamma', 'Delta']);
  assert.equal(JSON.stringify(importer.question), before);
  importer.listeners.get('answerListDrop:drop')!({ dataTransfer: { files: [csv('One'), csv('Two')] }, preventDefault() {} });
  assert.match(importer.element('answerListError').textContent, /one file/);
  assert.equal(prevented, 2);
  assert.deepEqual(importer.requests, []);
});
