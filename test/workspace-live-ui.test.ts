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

// ---- full screen, 14 options, commentary and results --------------------------------------------------------

const fourteen = model.describeQuestions({ pick: { type: 'choice', label: 'Which name?', criteria: Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`o${index}`, { label: `Name ${index}`, description: '' }])) } })[0]!;
const crowd = (count: number, segments = ['strategy', 'casual'], pick = (index: number): number => index % 14): Member[] => Array.from({ length: count }, (_, index) => {
  const chosen = pick(index), probabilities = Object.fromEntries(Array.from({ length: 14 }, (_, option) => [`o${option}`, option === chosen ? 0.7 : 0.3 / 13]));
  return { stage: 'poll', personaId: `p${index}`, label: `P${index}`, segment: segments[index % segments.length]!, age: 30, repeat: 1, status: 'completed' as const, weight: 1, order: index, answers: { pick: { type: 'choice', choice: `o${chosen}`, probabilities } } };
});

test('the full-screen view carries the question, status strip, back and report actions, and shows every option', () => {
  const html = view.html(input({ full: true, studyTitle: 'Which name will sell?', reportUrl: '/report.html', backLabel: 'Back to study', backAct: 'live-back' }));
  assert.match(html, /data-full="true"/);
  assert.match(html, /<h1 tabindex="-1">Which name will sell\?<\/h1>/);
  assert.match(html, /data-act="live-back"[^>]*>Back to study<kbd aria-hidden="true">Esc<\/kbd>/);
  assert.match(html, /<a class="lv-report" href="\/report.html"[^>]*aria-label="Open report \(new tab\)">Open report<\/a>/);
  assert.match(html, /data-lv="strip"/);
  assert.doesNotMatch(view.html(input()), /data-full="true"|lv-back|lv-report/, 'the embedded map has no full-screen chrome');
  const shown = crowd(280), board = model.leaderboard(shown, fourteen);
  const all = view.boardRows(board, fourteen, 'pick');
  assert.equal((all.match(/<li class="lv-row"/g) ?? []).length, 14, 'all fourteen options are listed');
  assert.equal((all.match(/data-hidden="true"/g) ?? []).length, 0);
  assert.match(all, /<span class="lv-rank" aria-hidden="true">1<\/span>/);
  assert.match(all, /data-leader="true"/);
  assert.match(all, /class="lv-pct">\d+\.\d%/, 'one decimal');
  assert.match(all, /data-p="stripes"|data-p="dots"/, 'later options get a pattern as a second cue');
});

test('option colours stay apart for a deuteranope and later options also carry a pattern', () => {
  const simulate = ([r, g, b]: number[]): number[] => {
    const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const gamma = (c: number): number => 255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
    const v = [lin(r!), lin(g!), lin(b!)], M = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]];
    return M.map(row => gamma(Math.max(0, Math.min(1, row[0]! * v[0]! + row[1]! * v[1]! + row[2]! * v[2]!))));
  };
  const lab = (rgb: number[]): number[] => {
    const lin = (c: number): number => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    const [R, G, B] = rgb.map(lin) as [number, number, number];
    const f = (t: number): number => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), y = f(0.2126 * R + 0.7152 * G + 0.0722 * B), z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  };
  const rgb = (hex: string): number[] => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
  const blocks = [WORKSPACE_LIVE_UI_CSS.match(/:root\{([^}]*)\}/)![1]!, WORKSPACE_LIVE_UI_CSS.match(/\[data-theme=dark\]\{([^}]*)\}/)![1]!];
  for (const block of blocks) {
    const colours = Array.from({ length: 14 }, (_, index) => block.match(new RegExp(`--lv-c${index}:(#[0-9a-f]{6})`))![1]!);
    assert.equal(new Set(colours).size, 14);
    let closest = Infinity;
    for (let a = 0; a < 14; a++) for (let b = a + 1; b < 14; b++) {
      const x = lab(simulate(rgb(colours[a]!))), y = lab(simulate(rgb(colours[b]!)));
      closest = Math.min(closest, Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!));
    }
    assert.ok(closest >= 15, `closest pair under deuteranopia is ΔE ${closest.toFixed(1)}`);
  }
  assert.match(WORKSPACE_LIVE_UI_CSS, /\.lv-tile\[data-s=done\]\[data-c="7"\][^{]*\{background-image:(repeating-linear-gradient|radial-gradient)/);
  assert.equal(model.PALETTE, 14);
});

test('tiles fill the viewport: a thousand members reach 22px at 1440 by 900 and bigger screens get bigger tiles', () => {
  const groups = [249, 302, 202, 247];
  const desktop = model.fitLayout(groups, 1087 - 24, 730 - 28, { max: model.fitCap(1000), header: 22, padding: 8, groupGap: 10 });
  assert.ok(desktop.tile >= 22 && desktop.fits, `desktop tile ${desktop.tile}`);
  const large = model.fitLayout(groups, 1900 - 24, 1000 - 28, { max: model.fitCap(1000), header: 22, padding: 8, groupGap: 10 });
  assert.ok(large.tile > desktop.tile, 'computed from the space, not a fixed step');
  assert.ok(model.fitLayout([4], 1000, 700, { max: model.fitCap(4) }).tile <= model.fitCap(4));
});

test('commentary is derived from counts only, replays in order and hits 25, 50, 75 and 100 percent', () => {
  const shown = crowd(200, ['strategy', 'casual'], index => index < 40 ? 0 : 1);
  const labels = { strategy: 'Strategy players', casual: 'Casual players' };
  const lines = model.commentary(shown, fourteen, labels);
  assert.deepEqual(lines.filter(line => line.kind === 'milestone').map(line => line.n), [50, 100, 150, 200]);
  assert.match(lines.find(line => line.n === 100 && line.kind === 'milestone')!.text, /^Half of the 200 evaluations are in · Name \d+ leads at \d+(\.\d)?%$/);
  assert.match(lines.find(line => line.kind === 'lead')!.text, /^Name 0 leads early at/);
  assert.ok(lines.some(line => /takes the lead/.test(line.text)), 'a lead change is reported');
  assert.ok(lines.every((line, index) => index === 0 || line.n >= lines[index - 1]!.n), 'lines are in finishing order');
  assert.deepEqual(model.commentary(model.replayMembers(shown, 120), fourteen, labels), lines.filter(line => line.n <= 120), 'a replay at any point shows the same lines the live run did');
  assert.ok(model.commentary(shown, undefined).every(line => line.kind === 'milestone' && !line.text.includes(' · ')), 'no question means no invented lead');
  assert.equal(model.commentary([], fourteen).length, 0);
  const html = view.newsHtml([...lines].reverse().slice(0, 6).map(line => ({ ...line, time: `vote ${line.n}` })));
  assert.equal((html.match(/<li /g) ?? []).length, 4, 'only the last four lines are kept');
  assert.match(html, /<ol data-lv="news"[^>]*><li data-kind="milestone"><time>vote 200<\/time>/, 'newest first, stamped');
});

test('a finished run turns into results: final ranking, top three per segment and one factual summary line', () => {
  const shown = crowd(280, ['strategy', 'casual', 'sim'], index => index % 3 === 0 ? 0 : index % 3 === 1 ? 3 : 7);
  const labels = { strategy: 'Strategy players', casual: 'Casual players', sim: 'Sim players' };
  const board = model.leaderboard(shown, fourteen), tops = model.segmentTops(shown, fourteen, labels);
  assert.equal(tops.length, 3);
  assert.ok(tops.every(entry => entry.top.length === 3));
  assert.equal(tops[0]!.top[0]!.label, 'Name 0');
  const summary = model.resultSummary(board, tops);
  assert.match(summary, /^Name \d+ leads overall at \d+(\.\d)?%, but each segment prefers a different option\.$/);
  assert.match(model.resultSummary(board, tops.slice(0, 1)), /leads overall at \d+(\.\d)?%\.$/);
  assert.match(model.resultSummary(board, tops.map(entry => ({ ...entry, top: [{ id: board.leader!, label: '', share: 1 }] }))), /and tops every segment\.$/);
  assert.equal(model.resultSummary({ rows: [], leader: null, evaluated: 0 }, []), '');
  const done = view.html(input({ status: 'completed', members: shown, groups: model.groupMembers(shown, 'segment', () => undefined, labels), question: fourteen, board, results: { summary, segments: tops }, full: true }, shown));
  assert.match(done, /<h3>Final ranking<\/h3>/);
  assert.match(done, /<section class="lv-results" aria-label="Results"><h3>Results<\/h3><p class="lv-summary">Name \d+ leads overall/);
  assert.equal((done.match(/class="lv-seg-row"/g) ?? []).length, 3);
  assert.doesNotMatch(done, /aria-label="Commentary"/, 'results replace the ticker once the run is done');
  const replaying = view.html(input({ status: 'completed', question: fourteen, board, results: { summary, segments: tops }, replay: { cursor: 10, total: 280, playing: false, speed: 1, ordered: true }, news: [] }, shown));
  assert.match(replaying, /aria-label="Commentary"/); assert.doesNotMatch(replaying, /lv-results/);
});

test('motion cues: new tiles brighten for about a second, groups pulse, ranks flash, and reduced motion removes them', () => {
  assert.match(WORKSPACE_LIVE_UI_CSS, /\.lv-tile\.is-pop\{animation:lv-pop \.4s[^}]*,lv-fresh 1\.2s/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /\.lv-group\.is-wave\{animation:lv-wave/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /\.lv-row\.is-moved/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /transition:transform \.6s cubic-bezier/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /\.live-voting\[data-full=true\]\{position:fixed;inset:0/);
  assert.match(WORKSPACE_LIVE_UI_CSS, /max-width:900px\)\{[^@]*\.live-voting\[data-full=true\] \.lv-side\{display:flex/, 'phones stack the leaderboard under the map');
});
