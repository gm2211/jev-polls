import test from 'node:test';
import assert from 'node:assert/strict';
import { createArenaModel } from '../src/workspace-arena-model.js';
import { summarizeVotes } from '../src/analysis.js';
import type { Question, Vote } from '../src/types.js';

const arena = createArenaModel();
type Member = Parameters<typeof arena.tileVisual>[0];

const questions = arena.describeQuestions({
  pick: { type: 'choice', label: 'Pick one', criteria: { a: { label: 'Alpha', description: 'First' }, b: { label: 'Beta', description: 'Second' }, c: { label: 'Gamma', description: 'Third' } } },
  rate: { type: 'score', label: 'Rate it', criteria: ['Poor', 'Fair', 'Good'] },
  buy: { type: 'noul', label: 'Would you buy it?' },
});
const [pick, rate, buy] = questions as [NonNullable<(typeof questions)[number]>, NonNullable<(typeof questions)[number]>, NonNullable<(typeof questions)[number]>];

const choice = (winner: string, top = 0.7): Record<string, unknown> => ({ pick: { type: 'choice', choice: winner, probabilities: Object.fromEntries(['a', 'b', 'c'].map(id => [id, id === winner ? top : (1 - top) / 2])) } });
const member = (id: string, patch: Partial<Member> = {}): Member => ({ stage: 'poll', personaId: id, label: `Member ${id}`, segment: 'gamers', age: 34, repeat: 1, status: 'queued', ...patch });

test('questions are described with option labels, score levels and a yes/no for noul', () => {
  assert.deepEqual(pick.options, [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma' }]);
  assert.deepEqual(rate.options.map(option => option.label), ['Poor', 'Fair', 'Good']);
  assert.deepEqual(buy.options.map(option => option.id), ['yes', 'no']);
  // A study that was edited away still replays from the answers themselves.
  const recovered = arena.describeQuestions(undefined, [member('x', { status: 'completed', answers: choice('b') })]);
  assert.deepEqual(recovered[0]?.options.map(option => option.id), ['a', 'b', 'c']);
});

test('tile colours: status is neutral until done, top pick uses the option slot, scores and yes-probability use a scale', () => {
  assert.deepEqual(arena.tileVisual(member('1'), pick, 'pick'), { state: 'queued', fill: 'none', index: 0, value: 0, progress: null });
  assert.equal(arena.tileVisual(member('1', { status: 'failed', reason: 'x' }), pick, 'pick').state, 'failed');
  const done = member('1', { status: 'completed', answers: choice('b') });
  assert.deepEqual(arena.tileVisual(done, pick, 'status'), { state: 'done', fill: 'none', index: 0, value: 0, progress: null });
  assert.deepEqual(arena.tileVisual(done, pick, 'pick'), { state: 'done', fill: 'option', index: 1, value: 0, progress: null });
  const scored = member('2', { status: 'completed', answers: { rate: { type: 'score', score: 2, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 } } } });
  assert.deepEqual(arena.tileVisual(scored, rate, 'pick'), { state: 'done', fill: 'scale', index: 2, value: 1, progress: null });
  const yes = member('3', { status: 'completed', answers: { buy: { type: 'noul', noul: 0.25 } } });
  assert.equal(arena.tileVisual(yes, buy, 'pick').fill, 'scale');
  assert.equal(arena.tileVisual(yes, buy, 'pick').value, 0.25);
  // Confidence: a coin flip between three options is 0, a certain answer is 1.
  assert.ok(Math.abs(arena.tileVisual(member('4', { status: 'completed', answers: choice('a', 1 / 3) }), pick, 'confidence').value) < 1e-9);
  assert.equal(arena.tileVisual(member('5', { status: 'completed', answers: choice('a', 1) }), pick, 'confidence').value, 1);
  assert.equal(arena.optionColor(1), 'var(--lv-c1)');
  assert.match(arena.optionColor(11), /^hsl\(/);
});

test('a batched member fills as its map batches and combine round finish', () => {
  const running = member('board', { status: 'running', batch: { phase: 'map', done: 4, total: 11 } });
  assert.equal(arena.tileVisual(running, pick, 'pick').progress, 4 / 11);
  assert.equal(arena.tileVisual(member('plain', { status: 'running' }), pick, 'pick').progress, null);
});

test('grouping by segment, age, attributes (arrays by their one item or Several), numbers and none', () => {
  const people = [
    { id: 'p1', age: 22, attributes: { platform: 'PC', genres: ['4X'], hours: 10 } },
    { id: 'p2', age: 35, attributes: { platform: 'Console', genres: ['4X', 'RTS'], hours: 200 } },
    { id: 'p3', age: 36, attributes: { platform: 'PC', genres: [], hours: 400 } },
    { id: 'p4', age: 71, attributes: { platform: 'PC', hours: 800 } },
  ];
  const members = people.map((person, index) => member(person.id, { segment: index < 2 ? 'strategy' : 'casual' }));
  const lookup = (m: Member) => people.find(person => person.id === m.personaId);
  const labels = { strategy: 'Strategy / 4X players', casual: 'Casual players' };
  assert.deepEqual(arena.groupMembers(members, 'segment', lookup, labels).map(group => [group.label, group.keys.length]), [['Strategy / 4X players', 2], ['Casual players', 2]]);
  assert.deepEqual(arena.groupMembers(members, 'age', lookup).map(group => group.label), ['18–29', '30–39', '70+']);
  assert.deepEqual(arena.groupMembers(members, 'attributes.platform', lookup).map(group => [group.label, group.keys.length]), [['PC', 3], ['Console', 1]]);
  assert.deepEqual(arena.groupMembers(members, 'attributes.genres', lookup).map(group => [group.label, group.keys.length]).sort(), [['4X', 1], ['Not specified', 2], ['Several', 1]]);
  assert.equal(arena.groupMembers(members, 'none', lookup)[0]?.keys.length, 4);
  const many = Array.from({ length: 60 }, (_, index) => ({ id: `m${index}`, attributes: { hours: index * 17 } }));
  const bucketed = arena.groupMembers(many.map(person => member(person.id)), 'attributes.hours', m => many.find(person => person.id === m.personaId));
  assert.ok(bucketed.length >= 4 && bucketed.length <= 8, `${bucketed.length} numeric groups`);
  assert.equal(bucketed.reduce((sum, group) => sum + group.keys.length, 0), 60);
  // Too many distinct values fold the smallest into Other, and every member stays in exactly one group.
  const wide = Array.from({ length: 40 }, (_, index) => ({ id: `w${index}`, attributes: { city: `City ${index}` } }));
  const folded = arena.groupMembers(wide.map(person => member(person.id)), 'attributes.city', m => wide.find(person => person.id === m.personaId));
  assert.equal(folded.length, arena.GROUP_LIMIT);
  assert.equal(new Set(folded.flatMap(group => group.keys)).size, 40);
  assert.deepEqual(arena.groupFields([{ field: 'attributes.platform' }, { field: 'attributes.hours' }, { field: 'age' }], members, lookup), ['attributes.platform', 'attributes.hours']);
});

test('leaderboard shares equal the report: weighted mean of answer probabilities', () => {
  const votes: Vote[] = [];
  const members: Member[] = [];
  const winners = ['a', 'a', 'b', 'c', 'a', 'b'];
  winners.forEach((winner, index) => {
    const weight = (index + 1) / 21;
    const answers = choice(winner, 0.6 + index * 0.05) as Vote['answers'];
    members.push(member(`m${index}`, { status: 'completed', weight, answers }));
    votes.push({ personaId: `m${index}`, segment: 'gamers', repeat: 1, weight, answers, cacheHit: false, model: 'x' });
  });
  members.push(member('waiting'), member('thinking', { status: 'running' }), member('broken', { status: 'failed', reason: 'x' }));
  const board = arena.leaderboard(members, pick);
  const reported = summarizeVotes({ pick: { type: 'choice', label: 'Pick', instructions: '', criteria: { a: 'A', b: 'B', c: 'C' } } as Question }, votes).pick!;
  assert.equal(board.evaluated, 6);
  assert.equal(board.weighted, true);
  for (const row of board.rows) assert.ok(Math.abs(row.share - reported.probabilities![row.id]!) < 1e-9, `${row.id} ${row.share} vs ${reported.probabilities![row.id]}`);
  assert.equal(board.leader, reported.winner);
  assert.deepEqual(board.rows.map(row => row.id), Object.entries(reported.probabilities!).sort((x, y) => y[1] - x[1]).map(([id]) => id));
  // Runs saved before weights were kept count every member equally, and say so.
  const legacy = arena.leaderboard(members.map(({ weight: _weight, ...rest }) => rest), pick);
  assert.equal(legacy.weighted, false);
  assert.equal(arena.leaderboard([member('only-queued')], pick).rows.length, 0);
  // Yes-probability and scores tally too.
  assert.equal(arena.leaderboard([member('y', { status: 'completed', answers: { buy: { type: 'noul', noul: 0.8 } } })], buy).mean, 0.8);
  const rated = arena.leaderboard([member('s', { status: 'completed', answers: { rate: { type: 'score', score: 2, probabilities: { 0: 0, 1: 0.25, 2: 0.75 } } } })], rate);
  assert.equal(rated.mean, 2); assert.deepEqual(rated.rows.map(row => row.share), [0, 0.25, 0.75]);
});

test('incremental patch plans name only the tiles that changed', () => {
  const before = Array.from({ length: 1000 }, (_, index) => member(`m${index}`));
  const known = new Map(before.map(m => [arena.memberKey(m), arena.signature(m)]));
  assert.deepEqual(arena.patchPlan(known, before), { added: [], changed: [], removed: [] });
  const after = before.map((m, index) => index === 3 ? { ...m, status: 'running' as const } : index === 700 ? { ...m, status: 'completed' as const, answers: choice('a') } : m);
  const plan = arena.patchPlan(known, after);
  assert.deepEqual(plan.changed, ['poll:m3:1', 'poll:m700:1']);
  assert.deepEqual([plan.added.length, plan.removed.length], [0, 0]);
  // A batch layer landing changes the signature; the same layer twice does not.
  const layered = { ...before[5]!, status: 'running' as const, batch: { phase: 'map' as const, done: 1, total: 11 } };
  const next = new Map(known).set('poll:m5:1', arena.signature(layered));
  assert.deepEqual(arena.patchPlan(next, after.map((m, index) => index === 5 ? layered : m)).changed, ['poll:m3:1', 'poll:m700:1']);
  const grown = [...before, member('late')];
  assert.deepEqual(arena.patchPlan(known, grown).added, ['poll:late:1']);
  assert.deepEqual(arena.patchPlan(known, before.slice(1)).removed, ['poll:m0:1']);
});

test('a poll that returns only changed members folds into the known ones by key', () => {
  const known = [member('a'), member('b'), member('c')];
  const merged = arena.mergeMembers(known, [{ ...known[1]!, status: 'completed', answers: choice('c') }, member('d')]);
  assert.deepEqual(merged.map(m => [m.personaId, m.status]), [['a', 'queued'], ['b', 'completed'], ['c', 'queued'], ['d', 'queued']]);
  assert.equal(arena.mergeMembers(known, []), known);
});

test('replay reveals finished members in the order they finished, falling back to saved order', () => {
  const saved = [
    member('slow', { status: 'completed', order: 2, answers: choice('a') }),
    member('fast', { status: 'completed', order: 0, answers: choice('b') }),
    member('mid', { status: 'failed', order: 1, reason: 'no' }),
    member('never'),
  ];
  assert.deepEqual(arena.replayOrder(saved).map(m => m.personaId), ['fast', 'mid', 'slow']);
  const none = arena.replayMembers(saved, 0);
  assert.ok(none.every(m => m.status === 'queued' && !m.answers && !m.reason));
  const two = arena.replayMembers(saved, 2);
  assert.deepEqual(two.map(m => [m.personaId, m.status]), [['slow', 'queued'], ['fast', 'completed'], ['mid', 'failed'], ['never', 'queued']]);
  assert.equal(two[0]!.answers, undefined, 'unrevealed answers are never exposed');
  const legacy = arena.replayOrder(saved.map(({ order: _order, ...rest }) => rest));
  assert.deepEqual(legacy.map(m => m.personaId), ['slow', 'fast', 'mid']);
  // Part-way through a reveal the next member is shown thinking, with its recorded layers filling in.
  const mid = arena.replayMembers(saved, 0.5, { batches: 10, reduceRounds: 1 });
  const thinking = mid.find(m => m.personaId === 'fast')!;
  assert.equal(thinking.status, 'running');
  assert.equal(thinking.batch?.total, 11);
  assert.equal(thinking.batch?.done, Math.floor(0.5 * 12));
  assert.equal(thinking.answers, undefined);
  assert.equal(arena.replayMembers(saved, 0.5)[1]!.batch, undefined);
  assert.ok(arena.replayRate(1000, 1) <= 1000 / 4 && arena.replayRate(1000, 1) >= 1000 / 40);
  assert.ok(Math.abs(arena.replayRate(8, 1) - 2) < 1e-9);
  assert.equal(arena.replayAdvance(10, 25, 400, 1000), 20);
  assert.equal(arena.replayAdvance(999.9, 25, 400, 1000), 1000);
});

test('Fit all packs 1,000 tiles into a desktop map and drops to scrolling only when it must', () => {
  const groups = [249, 300, 201, 250];
  const fit = arena.fitLayout(groups, 800, 440);
  assert.equal(fit.fits, true);
  assert.ok(fit.tile >= 12 && fit.tile <= 22, `tile ${fit.tile}`);
  assert.ok(fit.height <= 440);
  assert.equal(fit.columns.length, 4);
  assert.ok(arena.fitLayout(groups, 800, 900).tile >= 18, 'a taller map earns bigger tiles');
  const tight = arena.fitLayout(groups, 300, 200);
  assert.equal(tight.fits, false);
  assert.equal(tight.tile, 8);
  assert.equal(arena.tileCap(8), 64); assert.equal(arena.tileCap(1000), 22);
  assert.equal(arena.tileFor(1000, '2'), 32);
  assert.deepEqual(arena.fixedLayout([300], 800, 22).columns[0]! * 24 <= 800, true);
  assert.equal(arena.initials('Community and PR lead'), 'CL');
  assert.equal(arena.initials('Ohio Civ veteran'), 'OV');
});

test('throughput is a rolling 20 second rate and time left follows from it', () => {
  const samples = [{ t: 0, done: 0 }, { t: 5000, done: 100 }, { t: 25000, done: 500 }, { t: 30000, done: 600 }];
  assert.equal(arena.rate(samples, 30000, 20000), (600 - 100) / 25, 'only samples within 20s of now count');
  assert.equal(arena.rate([{ t: 0, done: 0 }], 100), null);
  assert.equal(arena.rate([{ t: 0, done: 0 }, { t: 500, done: 10 }], 600), null, 'too short to trust');
  assert.equal(arena.secondsLeft(400, 20), 20);
  assert.equal(arena.secondsLeft(0, null), 0);
  assert.equal(arena.secondsLeft(10, null), null);
  assert.deepEqual([0.4, 12, 100, 6000].map(seconds => arena.duration(seconds)), ['under 1s', '12s', '2 min', '1.7 h']);
});
