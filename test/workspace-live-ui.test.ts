import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createArenaModel } from '../src/workspace-arena-model.js';
import { createLiveVotingView, WORKSPACE_LIVE_UI_CLIENT, WORKSPACE_LIVE_UI_CSS } from '../src/workspace-live-ui.js';

const model = createArenaModel();
const view = createLiveVotingView(model);
type Member = Parameters<typeof model.tileVisual>[0];

const questions = model.describeQuestions({ pick: { type: 'choice', label: 'Which name?', criteria: { a: { label: 'Alpha <b>', description: '' }, b: { label: 'Beta', description: '' } } } });
const answer = (winner: string): Record<string, unknown> => ({ pick: { type: 'choice', choice: winner, probabilities: { a: winner === 'a' ? 0.8 : 0.2, b: winner === 'b' ? 0.8 : 0.2 } } });
const members: Member[] = [
  { stage: 'poll', personaId: 'ada', label: '<Ada>', segment: 'gamers', age: 30, repeat: 1, status: 'completed', weight: 0.5, order: 0, model: 'jev-1', answers: answer('a') },
  { stage: 'poll', personaId: 'bo', label: 'Bo', segment: 'gamers', age: 41, repeat: 2, status: 'completed', weight: 0.25, order: 1, answers: answer('b') },
  { stage: 'poll', personaId: 'cal', label: 'Cal', segment: 'board', age: 52, repeat: 1, status: 'running', batch: { phase: 'map', done: 3, total: 11 } },
  { stage: 'poll', personaId: 'dee', label: 'Dee', segment: 'board', age: 29, repeat: 1, status: 'failed', reason: 'Request failed' },
  { stage: 'poll', personaId: 'eli', label: 'Eli', segment: 'board', age: 33, repeat: 1, status: 'queued' },
];
function input(overrides: Record<string, unknown> = {}, shown: Member[] = members): Parameters<typeof view.html>[0] {
  const groups = model.groupMembers(shown, 'segment', () => undefined, { gamers: 'Gamers', board: 'Board' });
  const question = questions[0];
  const stats = { queued: 1, running: 1, done: 2, failed: 1, total: 5, rateText: '12/s', leftText: '~3s' };
  return {
    runId: 'run-1', status: 'running', message: 'poll: 2 of 5 evaluations processed', reportUrl: undefined, title: 'Gamer research', stageId: 'poll',
    stages: [{ id: 'poll', label: 'Gamer research', status: 'running', kind: 'poll', dependsOn: [] }], members: shown, groups, layout: { tile: 18, columns: groups.map(() => 5) },
    segmentLabels: { gamers: 'Gamers', board: 'Board' }, questions, question, colorBy: 'pick', groupBy: 'segment', zoom: 'fit',
    groupOptions: [['segment', 'Segment'], ['age', 'Age'], ['attributes.platform', 'Platform'], ['none', 'None']], selectedKey: '', tabKey: 'poll:ada:1', selected: undefined, selectedHidden: false,
    board: model.leaderboard(shown, question), stats, replay: null, emptyReason: '', ...overrides,
  } as never;
}

test('live voting shows one focusable tile per evaluation, grouped with counts, plus a weighted leaderboard', () => {
  const html = view.html(input());
  assert.match(html, /Live voting/);
  assert.equal((html.match(/class="lv-tile[" ]/g) ?? []).length, 5);
  assert.match(html, /<h3 title="Gamers"><span>Gamers<\/span><b>2<\/b>/);
  assert.match(html, /<h3 title="Board"><span>Board<\/span><b>3<\/b>/);
  assert.match(html, /aria-label="&lt;Ada&gt;, Gamers, voted, top pick Alpha &lt;b&gt; 80%"/);
  assert.match(html, /aria-label="Bo, Gamers, voted, repeat 2, top pick Beta 80%"/);
  assert.match(html, /aria-label="Cal, Board, thinking, reading batches, 3 of 11 steps"/);
  assert.match(html, /data-s="failed"/);
  assert.match(html, /data-s="queued"/);
  assert.match(html, /<button type="button" class="lv-tile" data-act="live-member"/);
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1, 'one tab stop; arrows move between tiles');
  assert.match(html, /style="--p:0\.273;--n:11"/);
  assert.match(html, /Weighted share of 2 evaluated/);
  assert.match(html, /data-opt="a"[^>]*data-leader="true"/);
  assert.match(html, /Alpha &lt;b&gt;/);
  assert.match(html, /Tiles count evaluations, not audience share/);
  assert.match(html, /repeats are separate tiles/);
  assert.match(html, /role="tooltip"/);
  assert.match(html, /Evaluated<\/span><strong data-lv="done">3 \/ 5/);
  assert.match(html, /Speed<\/span><strong data-lv="rate">12\/s/);
  assert.match(html, /Time left<\/span><strong data-lv="left">~3s/);
  assert.doesNotMatch(html, /<Ada>|Cohort Arena|host map|Illustrative replay/i);
  for (const control of ['lv-color', 'lv-zoom']) assert.match(html, new RegExp(`data-act="${control}"`));
  assert.match(html, /<select data-lv-group/);
  assert.match(html, /<option value="attributes\.platform">Platform/);
  assert.match(html, /data-value="status" aria-pressed="false"/);
  assert.match(html, /data-value="pick" aria-pressed="true"/);
});

test('a finished run is a voting replay and never leaks answers that have not been revealed', () => {
  const finished = members.map(member => ({ ...member, status: member.status === 'running' || member.status === 'queued' ? 'completed' as const : member.status, answers: member.status === 'failed' ? undefined : answer('b'), batch: undefined }));
  const revealed = model.replayMembers(finished.map((member, index) => ({ ...member, order: index, answers: index === 1 ? { pick: { type: 'choice', choice: 'SECRET', probabilities: { a: 0.01, b: 0.99 } } } : member.answers })), 1);
  const html = view.html(input({ status: 'completed', message: 'Study complete.', replay: { cursor: 1, total: 4, playing: false, speed: 2, ordered: true }, selectedKey: 'poll:bo:2', selected: revealed[1], selectedHidden: true }, revealed));
  assert.match(html, /Voting replay/);
  assert.doesNotMatch(html, /Live voting/);
  assert.match(html, /1 of 4 members revealed/);
  assert.match(html, /data-act="arena-play"[^>]*>Play/);
  for (const action of ['arena-step', 'arena-reset', 'arena-live']) assert.match(html, new RegExp(`data-act="${action}"`));
  assert.match(html, /data-act="arena-speed" data-speed="2" aria-pressed="true"/);
  assert.match(html, /in the order their evaluations finished/);
  assert.match(html, /illustrative, not the real timing/);
  assert.match(html, /Not revealed yet/);
  assert.doesNotMatch(html, /SECRET|Request failed/);
  assert.doesNotMatch(html, /data-lv="rate"/, 'speed and time left belong to a live run');
  const legacy = view.html(input({ status: 'completed', replay: { cursor: 0, total: 4, playing: false, speed: 1, ordered: false }, selected: undefined }));
  assert.match(legacy, /in saved order/);
  const idle = view.html(input({ status: 'completed', replay: null }));
  assert.match(idle, /data-act="arena-replay">Replay voting/);
  assert.doesNotMatch(idle, /data-act="arena-step"/);
});

test('detail shows the full answer, the model and the synthetic-profile note', () => {
  const html = view.html(input({ selectedKey: 'poll:ada:1', selected: members[0] }));
  assert.match(html, /<h3>&lt;Ada&gt;<\/h3>/);
  assert.match(html, /Selected: Alpha &lt;b&gt;/);
  assert.match(html, /80%/);
  assert.match(html, /Model: jev-1/);
  assert.match(html, /Synthetic profile; model output is not observed human behavior/);
  assert.match(html, /aria-pressed="true"/);
  const running = view.detailHtml(members[2], { question: questions[0], questions, segmentLabel: 'Board' });
  assert.match(running, /Reading the responses in batches: 3 of 11 steps done/);
  assert.match(view.detailHtml(members[3], { question: questions[0], questions, segmentLabel: 'Board' }), /role="alert">Request failed/);
  assert.match(view.detailHtml(undefined, { question: questions[0], questions, segmentLabel: '' }), /Pick a tile/);
});

test('colourings, legends and tooltips follow the chosen question type', () => {
  const status = view.html(input({ colorBy: 'status' }));
  assert.match(status, /data-lv="count-queued">1<\/b>/);
  assert.match(status, /data-lv="count-done">2<\/b>/);
  assert.match(view.html(input({ colorBy: 'confidence' })), /Unsure[\s\S]*Certain/);
  const buy = model.describeQuestions({ buy: { type: 'noul', label: 'Buy?' } });
  const yes: Member = { ...members[0]!, answers: { buy: { type: 'noul', noul: 0.8 } } };
  const noul = view.html(input({ question: buy[0], questions: buy, board: model.leaderboard([yes], buy[0]) }, [yes]));
  assert.match(noul, /Likelihood of yes/);
  assert.match(noul, /data-c="s" style="--v:0\.8"/);
  assert.match(noul, /Unlikely[\s\S]*Likely/);
  const tooltip = view.tooltipHtml(members[0]!, { question: questions[0], segmentLabel: 'Gamers' });
  assert.match(tooltip, /&lt;Ada&gt;/);
  assert.match(tooltip, /Alpha &lt;b&gt; · 80%/);
  assert.match(view.tooltipHtml(members[2]!, { question: questions[0], segmentLabel: 'Board' }), /Thinking · step 3 of 11/);
  assert.match(view.tooltipHtml(members[4]!, { question: questions[0], segmentLabel: 'Board' }), /Waiting for a turn/);
});

test('big tiles get initials and an empty step says why there is nothing to show', () => {
  const big = view.html(input({ layout: { tile: 44, columns: [2, 3] } }));
  assert.match(big, /data-big="true"/);
  assert.match(big, /data-i="B"/);
  const empty = view.html(input({ emptyReason: 'decision step · skipped · No member evaluations in this step.' }, []));
  assert.match(empty, /class="lv-empty"/);
  assert.match(empty, /No member evaluations in this step/);
  assert.doesNotMatch(empty, /lv-tile/);
});

test('the serialized browser build renders exactly what the tests see, and styles respect reduced motion', () => {
  const context = { window: {} as Record<string, unknown> };
  runInNewContext(WORKSPACE_LIVE_UI_CLIENT, context);
  const browser = context.window.liveVoting as { model: typeof model; view: typeof view };
  assert.equal(browser.view.html(input()), view.html(input()));
  assert.equal(JSON.stringify(browser.model.fitLayout([300, 200], 800, 400)), JSON.stringify(model.fitLayout([300, 200], 800, 400)));
  assert.match(WORKSPACE_LIVE_UI_CSS, /prefers-reduced-motion:reduce\)\{\.live-voting \*\{animation:none!important;transition:none!important\}/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /\[data-theme=dark\]\{--lv-c0/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /@media\(max-width:900px\)\{\.lv-body\{grid-template-columns:1fr\}/);
});
