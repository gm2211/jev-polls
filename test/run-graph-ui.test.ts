import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createRunGraphView, RUN_GRAPH_FACTORY } from '../src/run-graph-ui.js';
import { createArenaModel } from '../src/workspace-arena-model.js';
import { createLiveVotingView } from '../src/workspace-live-ui.js';
import { renderWorkspace } from '../src/workspace-ui.js';

const graph = createRunGraphView();
const example = JSON.parse(readFileSync(new URL('../examples/game-naming/pipeline.json', import.meta.url), 'utf8'));
const audiences = { players: 'Strategy players', reviewers: 'Reviewer panel' };
const stage = (id: string) => example.stages.find((item: any) => item.id === id);

/** A study with explicit hand-offs: a final choice reading every answer in batches, and options taken from an earlier step. */
const handoff = {
  stages: [
    { id: 'ask', kind: 'poll', label: 'Ask <fans>', dependsOn: [], cohort: 'fans', questions: { pick: { type: 'choice', label: 'Favourite', instructions: '', criteria: { a: { label: 'Alpha', description: '' }, b: 'Beta', c: null } } } },
    { id: 'follow', kind: 'poll', label: 'Follow up', dependsOn: ['ask'], cohort: 'fans', inputs: { top: { stage: 'ask', question: 'pick', select: 'winner' } }, questions: { again: { type: 'choice', label: 'Again', instructions: '', criteria: { a: 'Alpha', b: 'Beta' }, optionsFrom: { stage: 'ask', question: 'pick', top: 2 } } } },
    { id: 'final', kind: 'choose', label: 'Decide', dependsOn: ['ask', 'follow'], questions: { name: { type: 'choice', label: 'Name', instructions: '', criteria: { a: 'Alpha', b: 'Beta' } } }, inputs: { all: { stage: 'ask', question: 'pick', select: 'responses', batch: 'auto' }, again: { stage: 'follow', question: 'again', select: 'probabilities' } } },
  ],
};

test('schema: polls read their audience, earlier results and conditions; outputs carry the answer shape', () => {
  const first = graph.schemaOf(example, stage('audience'), audiences);
  assert.deepEqual(first.inputs.map(read => [read.kind, read.label, read.form]), [['audience', 'Strategy players', 'audience']]);
  assert.deepEqual(first.outputs.map(field => [field.label, field.short]), [['Name preference', 'Choice · 3'], ['Concept appeal', 'Scale · 4'], ['Would explore further', 'Yes / no']]);
  assert.match(first.outputs[0]!.detail, /choice of 3 options \(Deepforge, Orbital Foundry, Iron Meridian\)/);
  assert.match(first.outputs[1]!.detail, /ordered scale, 4 levels \(0 Uninterested/);

  // A poll without explicit inputs reads every result of each step it follows, and runs only when its condition holds.
  const close = graph.schemaOf(example, stage('close-review'), audiences);
  assert.deepEqual(close.inputs.map(read => [read.kind, read.from, read.form]), [['audience', undefined, 'audience'], ['step', 'audience', 'all results'], ['step', 'blind-review', 'all results'], ['condition', undefined, 'if']]);
  assert.equal(close.inputs[3]!.label, 'Name preference lead < 15 pts in Audience preferences');
  assert.match(close.inputs[1]!.detail, /Every result of Audience preferences: Name preference, Concept appeal, Would explore further/);
});

test('schema: combine and final-answer steps resolve their type through the step that asked', () => {
  const combine = graph.schemaOf(example, stage('review-result'));
  assert.deepEqual(combine.inputs.map(read => [read.from, read.question, read.form]), [['close-review', 'favorite', '×1'], ['clear-review', 'favorite', '×1']]);
  assert.deepEqual(combine.outputs.map(field => [field.label, field.short]), [['Reviewer conclusion', 'Choice · 3']]);
  const decision = graph.schemaOf(example, stage('recommendation'));
  assert.deepEqual(decision.inputs.map(read => [read.from, read.label, read.form]), [['review-result', 'Reviewer conclusion', 'top option']]);
  assert.deepEqual(decision.outputs.map(field => [field.short, field.type]), [['Top option', 'decision']]);
  assert.match(decision.outputs[0]!.detail, /one of Deepforge, Orbital Foundry, Iron Meridian/);
});

test('schema: explicit hand-offs name the field and how it is read', () => {
  const follow = graph.schemaOf(handoff, handoff.stages[1]);
  assert.deepEqual(follow.inputs.map(read => [read.label, read.form]), [['fans', 'audience'], ['Favourite', 'top option']]);
  assert.equal(follow.outputs[0]!.short, 'Choice · from 1');
  assert.match(follow.outputs[0]!.detail, /taken from step 1, top 2/);
  const final = graph.schemaOf(handoff, handoff.stages[2]);
  assert.deepEqual(final.inputs.map(read => [read.from, read.label, read.form]), [['ask', 'Favourite', 'every answer · in batches'], ['follow', 'Again', 'shares']]);
  assert.match(final.inputs[0]!.detail, /Favourite \(every answer · in batches\) from Ask <fans> · choice of 3 options \(Alpha, Beta, c\)/);
  assert.equal(graph.summaryOf(final), '2 inputs → Choice · 2');
  assert.equal(graph.summaryOf(follow), 'Audience + 1 step → Choice · from 1');
  assert.equal(graph.summaryOf(graph.schemaOf(example, stage('audience'))), 'Audience → 3 answers');
  assert.equal(graph.summaryOf(graph.schemaOf(example, stage('recommendation'))), 'Reviewer conclusion → Top option');
});

test('layout: one column per depth, so wires run left to right', () => {
  assert.deepEqual(graph.columnsOf(example.stages).map(column => column.map((item: any) => item.id)), [['audience', 'blind-review'], ['close-review', 'clear-review'], ['review-result'], ['recommendation']]);
});

test('full graph: every input row has a port wired to the output it reads', () => {
  const html = graph.html({ pipeline: example, audiences, mode: 'full', statuses: { 'clear-review': 'skipped', audience: 'completed' }, notes: { audience: 'Asked 24 people.' } });
  assert.match(html, /class="rg" data-mode="full"/);
  assert.equal(html.match(/class="rg-node"/g)?.length, 6);
  assert.equal(html.match(/class="rg-row rg-out"/g)?.length, 3 + 1 + 1 + 1 + 1 + 1);
  // 2 + 2 'all results' wires into the two follow-ups, 2 into the combine step, 1 into the final answer.
  assert.equal(html.match(/<path /g)?.length, 7);
  assert.match(html, /data-stage-id="clear-review" data-state="skipped"/);
  assert.match(html, /<span class="rg-kind">Asked 24 people.<\/span>/);
  assert.match(html, /<title>Reviewer conclusion → Suggested name: Reviewer conclusion \(top option\)<\/title>/);
  assert.match(html, /data-stage-id="audience" data-state="completed" data-feeds-all=""/);
  assert.doesNotMatch(html, /<button/);
});

test('compact graph: selectable steps with a one-line schema and escaped text', () => {
  const html = graph.html({ pipeline: handoff, mode: 'compact', act: 'live-stage', selected: 'follow' });
  assert.match(html, /<button class="rg-node" data-stage-id="follow" data-state=""[^>]*type="button" data-act="live-stage" data-stage="follow" aria-pressed="true"/);
  assert.match(html, /Ask &lt;fans&gt;/);
  assert.doesNotMatch(html, /Ask <fans>/);
  assert.match(html, /<span class="rg-sum">2 inputs → Choice · 2<\/span>/);
  // One wire per connected pair, however many fields it carries.
  assert.equal(html.match(/<path /g)?.length, 3);
  assert.equal(graph.html({ pipeline: { stages: [] } }), '');
});

test('the serialized factory renders the same markup in a browser context', () => {
  const browserGraph = runInNewContext(RUN_GRAPH_FACTORY);
  const input = { pipeline: example, audiences, mode: 'full' as const, statuses: { audience: 'running' } };
  assert.equal(browserGraph.html(input), graph.html(input));
});

test('live view shows the study graph with a summary / fields switch when it is given one', () => {
  const view = createLiveVotingView(createArenaModel());
  const nav = (view as any).html;
  const markup = graph.html({ pipeline: example, act: 'live-stage', selected: 'audience' });
  const html = nav({ runId: 'r', status: 'completed', title: 'T', stageId: 'audience', stages: [], members: [], groups: [], layout: { tile: 18, columns: [] }, segmentLabels: {}, questions: [], question: undefined, colorBy: 'pick', groupBy: 'segment', zoom: 'fit', groupOptions: [], selectedKey: '', tabKey: '', board: { rows: [], evaluated: 0 }, stats: { queued: 0, running: 0, done: 0, failed: 0, total: 0 }, replay: null, emptyReason: '', graphHtml: markup, stepsView: 'fields' });
  assert.match(html, /<div class="lv-graph">/);
  assert.match(html, /data-act="lv-steps" data-value="fields" aria-pressed="true"/);
  assert.ok(html.includes(markup));
});

test('workspace page ships the graph factory and its styles', () => {
  const page = renderWorkspace('n', 'c');
  assert.match(page, /window\.runGraph=\(\(\) =>/);
  assert.match(page, /\.rg-node\{position:absolute/);
});
