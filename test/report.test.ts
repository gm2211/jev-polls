import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { renderReport, stageAudiences } from '../src/report.js';
import type { Cohort, RunRecord } from '../src/types.js';

const cohort: Cohort = {
  version: 1, id: 'cohort-a', name: 'Early listeners', description: 'People who listen to new releases.',
  population: 'Adults who stream music weekly', createdAt: '2026-10-03T12:00:00.000Z',
  sources: [{ id: 'source-a', title: 'Listening study', url: 'https://example.com/study', retrievedAt: '2026-10-01', notes: 'Background material' }],
  segments: [{ id: 'regulars', label: 'Regular listeners', description: 'Weekly streaming', weight: 0.6, weightBasis: 'assumed', sourceIds: ['source-a'] }],
  personas: [{ id: 'person-a', label: 'Mira', segment: 'regulars', age: 32, background: 'Works in audio', attributes: { region: 'Northeast', interests: ['pop', 'jazz'] }, sourceIds: ['source-a'], syntheticFields: ['background'], weight: 1 }],
  assumptions: ['Segment weights are planning assumptions.'],
};

const fixture = (): RunRecord => ({
  version: 1, id: 'run-17', createdAt: '2026-10-03T12:00:00.000Z', finishedAt: '2026-10-03T12:01:00.000Z',
  pipeline: {
    version: 1, id: 'pipeline-a', name: 'Album title study', description: 'Compare two title directions with a simulated panel.',
    context: { brief: 'Independent record label' }, cohorts: { listeners: 'cohort-a' },
    stages: [
      { id: 'concept', kind: 'poll', label: 'Concept check', dependsOn: [], cohort: 'listeners', repeats: 2, questions: { title: { type: 'choice', label: 'Which title fits?', instructions: 'Choose one.', criteria: { north: 'North', room: 'Room' } } } },
      { id: 'decision', kind: 'decision', label: 'Select direction', dependsOn: ['concept'], when: { stage: 'concept', question: 'title', metric: 'topProbability', op: 'gte', value: 0.5 }, from: { stage: 'concept', question: 'title' }, outputQuestion: 'selected' },
    ],
  },
  pipelineHash: 'hash-abc', provider: 'mock', model: 'jev-test', seed: 'seed-3', status: 'completed', cohorts: { 'cohort-a': cohort },
  stages: {
    concept: { id: 'concept', kind: 'poll', label: 'Concept check', status: 'completed', dependsOn: [], votes: [{ personaId: 'person-a', segment: 'regulars', repeat: 1, weight: 1, answers: { title: { type: 'choice', choice: 'north', probabilities: { north: 0.7, room: 0.3 }, confidence: 0.7 } }, cacheHit: false, model: 'jev-test' }], summaries: { title: { type: 'choice', label: 'Which title fits?', probabilities: { north: 0.7, room: 0.3 }, winner: 'north', margin: 0.4, topProbability: 0.7, meanConfidence: 0.7, respondentCount: 1, totalWeight: 1, bySegment: { regulars: { type: 'choice', probabilities: { north: 0.7, room: 0.3 }, winner: 'north', respondentCount: 1, totalWeight: 1 } }, byRepeat: { '1': { type: 'choice', probabilities: { north: 0.7, room: 0.3 }, winner: 'north', respondentCount: 1, totalWeight: 1 } } } }, startedAt: '2026-10-03T12:00:00.000Z', finishedAt: '2026-10-03T12:00:30.000Z' },
    decision: { id: 'decision', kind: 'decision', label: 'Select direction', status: 'skipped', reason: 'Condition did not pass.', dependsOn: ['concept'], votes: [], summaries: {}, startedAt: '2026-10-03T12:00:30.000Z', finishedAt: '2026-10-03T12:00:30.000Z' },
  },
  warnings: ['Mock answers are simulated.'], usage: { inputTokens: 50, outputTokens: 12, requests: 1, cacheHits: 0 },
});

test('renders a one-page report: answer first, then results, people, and how the run was made', () => {
  const html = renderReport(fixture());
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /id="answer"/);
  assert.match(html, /<h2 id="resultsHeading">Results</);
  assert.match(html, /<h2 id="peopleHeading">Who answered</);
  assert.match(html, /<h2 id="methodHeading">How this was made</);
  assert.doesNotMatch(html, /role="tablist"/);
  assert.doesNotMatch(html, /Repeat-level comparison/i);
  assert.doesNotMatch(html, /within-segment weight/);
  assert.match(html, /Lead over #2: /);
  assert.match(html, /Each person answered once\./);
  assert.match(html, /each person answered '\+r\+' times/);
  assert.match(html, /Repeats are not counted as extra people/);
  assert.match(html, /Ask the audience/);
  assert.match(html, /Runs only if /);
  assert.match(html, /runGraph.html\(\{pipeline,statuses,notes,audiences:cohortNames,mode:'full'/);
  assert.match(html, /Download run JSON/);
  assert.match(html, /application\/json/);
  assert.match(html, /https:\/\/example\.com\/study/);
  assert.match(html, /MOCK SIMULATION/);
  assert.match(html, /Demo data, not real people/);
  assert.match(html, /"status":"skipped"/);
  assert.match(html, /function choiceLabel\(question,key\)/);
  assert.match(html, /Probability of yes/);
  assert.match(html, /function questionFor\(stage,qid,seen=new Set\(\)\)/);
  assert.match(html, /stage.kind==='aggregate'&&stage.outputQuestion===qid/);
  assert.match(html, /Individual profiles are available on the source poll stages/);
  assert.match(html, /function reasonHeadline\(reason,status\)/);
  assert.match(html, /status==='failed'&&reason\.length>120/);
  assert.match(html, /Failure details/);
  assert.match(html, /--c13:/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  assert.doesNotMatch(html, /<link[^>]+stylesheet/i);
  const clientScript = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(clientScript);
  assert.doesNotThrow(() => new Script(clientScript));
});

test('escapes executable markup from run, stage, persona, and source strings in embedded JSON', () => {
  const run = fixture();
  run.id = '</script><script>alert("run")</script>';
  run.pipeline.name = '<img src=x onerror=alert(1)>';
  run.pipeline.stages[0].label = '</script><script>alert("stage")</script>';
  run.cohorts['cohort-a'].personas[0].label = '<svg onload=alert(1)>';
  run.cohorts['cohort-a'].sources[0].title = '</script><script>alert("source")</script>';
  run.cohorts['cohort-a'].sources[0].url = 'javascript:alert(1)';
  const html = renderReport(run);
  assert.match(html, /\\u003c\/script\\u003e\\u003cscript\\u003e/);
  assert.doesNotMatch(html, /<img src=x onerror=/i);
  assert.doesNotMatch(html, /<svg onload=/i);
  assert.doesNotMatch(html, /<script>alert\("run"\)/i);
  assert.doesNotMatch(html, /href="javascript:alert\(1\)"/i);
  const payload = html.match(/<script id="reportData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(payload);
  const decoded = JSON.parse(payload) as { run: RunRecord };
  assert.equal(decoded.run.id, '</script><script>alert("run")</script>');
  assert.equal(decoded.run.pipeline.name, '<img src=x onerror=alert(1)>');
  assert.equal(decoded.run.cohorts['cohort-a'].sources[0].url, 'javascript:alert(1)');
});

test('keeps branch outcomes faithful when a conditional stage is skipped or failed', () => {
  const run = fixture();
  run.status = 'failed';
  run.stages.decision.status = 'failed';
  run.stages.decision.reason = '47 of 48 persona requests failed: ' + Array.from({ length: 47 }, (_, index) => 'profile-' + index).join(', ');
  const html = renderReport(run);
  const payload = html.match(/<script id="reportData" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(payload);
  const decoded = JSON.parse(payload) as { run: RunRecord };
  assert.equal(decoded.run.stages.decision.status, 'failed');
  assert.equal(decoded.run.stages.decision.reason, '47 of 48 persona requests failed: ' + Array.from({ length: 47 }, (_, index) => 'profile-' + index).join(', '));
  assert.match(html, /47 of 48 persona requests failed/);
  assert.equal(decoded.run.pipeline.stages[1].when?.stage, 'concept');
  assert.match(html, /Run ended with failures/);
});


test('structured criteria use editable names in findings and retain full descriptions in report data', () => {
  const run=fixture();const question=run.pipeline.stages[0];assert.equal(question.kind,'poll');
  if(question.kind!=='poll')return;
  const q=question.questions.title;assert.equal(q.type,'choice');if(q.type!=='choice')return;q.criteria={north:{label:'Northern Light',description:'A reflective album about hope.'},room:{label:'Small Room',description:'An intimate acoustic collection.'}};
  const html=renderReport(run),script=html.match(/<script>\s*([\s\S]*?)<\/script>/)![1];
  const fn=script.match(/function choiceLabel\(question,key\)\{[^\n]+/ )![0];
  const label=new Script('('+fn+')').runInNewContext();
  assert.equal(label(question.questions.title,'north'),'Northern Light');
  assert.equal(label({type:'choice',criteria:{legacy:'Legacy name'}},'legacy'),'Legacy name');
  const data=JSON.parse(html.match(/<script id="reportData" type="application\/json">([\s\S]*?)<\/script>/)![1]);
  assert.equal(data.run.pipeline.stages[0].questions.title.criteria.north.description,'A reflective album about hope.');
  assert.doesNotMatch(html,/\[object Object\]/);
});


test('report provenance uses actual run provider and recorded model identifiers', () => {
  const run = fixture();
  assert.match(renderReport(run), /Demo data only/);
  run.provider = 'typesafe';
  run.stages.concept.votes[0].model = 'jev-returned-revision';
  const html = renderReport(run);
  assert.match(html, /Recorded TypeSafe model results for synthetic profiles/);
  assert.match(html, /Returned models: jev-returned-revision/);
  assert.doesNotMatch(html, /Demo data only/);
  run.provider = 'gliner';
  assert.match(renderReport(run), /Recorded GLiNER model results/);
});


test('workspace reports offer a direct return link without browser history', () => {
  assert.match(renderReport(fixture(), { workspace: true }), /<a class="button report-back" href="\/">← Back to workspace<\/a>/);
  assert.doesNotMatch(renderReport(fixture()), /href="\/"/);
});

test('How this was made describes the cohort each audience step asked', () => {
  const run = fixture();
  run.cohorts['cohort-a'] = { ...cohort, generationPrompt: 'Weekly streamers', distributionTargets: [{ field: 'attributes.region', kind: 'categorical', buckets: [{ label: 'Northeast', value: 'Northeast', percent: 100 }] }] };
  const concept = run.pipeline.stages[0];
  if (concept?.kind === 'poll') concept.inputs = { earlier: { stage: 'decision', question: 'selected', select: 'winner' } };
  const audience = stageAudiences(run).concept;
  assert.deepEqual(audience, {
    cohortId: 'cohort-a', name: 'Early listeners', profiles: 1, asked: 1, ages: [32, 32],
    segments: [{ label: 'Regular listeners', percent: 100 }],
    breakdowns: [{ label: 'Region', buckets: [{ label: 'Northeast', percent: 100 }] }],
    origin: 'Synthetic profiles drafted by AI from a description', sources: 1,
  });
  const html = renderReport(run, { workspace: true, projectId: 'project-1' });
  assert.match(html, /"cohortLink":"\/#project=project-1\\u0026tab=cohorts"/);
  assert.match(html, /function audienceBlock\(stage,a\)/);
  assert.match(html, /No earlier answers\./);
  assert.doesNotMatch(renderReport(run), /"cohortLink":"/);
});

test('steps saved with the old Final choice name read as Final answer', () => {
  const html = renderReport(fixture());
  assert.match(html, /\['Final choice','Final result'\]\.includes\(stage\.label\)\?'Final answer'/);
  assert.match(html, /KIND\[stage\.kind\]\?\?'Step'/);
});

test('the Saw line lists finished steps a step follows when it has no explicit inputs', () => {
  const run = fixture();
  run.pipeline.stages.push({ id: 'follow', kind: 'poll', label: 'Follow-up', dependsOn: ['concept', 'decision'], cohort: 'listeners', questions: {} });
  run.stages.follow = { ...run.stages.concept!, id: 'follow', label: 'Follow-up', dependsOn: ['concept', 'decision'] };
  const html = renderReport(run);
  assert.match(html, /upstream=stage\.inputs\?\[\]:\(stage\.dependsOn\?\?\[\]\)\.filter\(id=>stageResult\(id\)\?\.status==='completed'\)/);
  assert.match(html, /'Results from '\+upstream\.map\(label\)/);
});

