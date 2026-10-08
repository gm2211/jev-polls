import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { liveRunMembers, WORKSPACE_LIVE_UI_CLIENT } from '../src/workspace-live-ui.js';
import type { WorkspaceRun } from '../src/workspace-types.js';

const run: WorkspaceRun = {
  id: 'run', projectId: 'project', pipelineId: 'pipeline', pipelineName: 'Study', status: 'running', createdAt: '2026-10-08T12:00:00Z', message: 'Running',
  liveMembers: Array.from({ length: 50 }, (_, index) => ({ stage: 'poll', personaId: `member-${index}`, label: index === 0 ? '<Ada>' : `Member ${index}`, segment: 'buyers', age: 30, repeat: 1, status: index === 0 ? 'completed' as const : index === 1 ? 'running' as const : 'queued' as const, ...(index === 0 ? { answers: { preference: { type: 'choice', choice: 'A & B', probabilities: { 'A & B': 0.8, Other: 0.2 } } }, model: 'jev-1.13.0' } : {}) })),
};

test('live cohort map bounds pages, keeps status and exposes actual selected answers safely', () => {
  const first = liveRunMembers(run, 'poll:member-0:1');
  assert.match(first, /Page 1 of 2/);
  assert.match(first, /queued: 48/);
  assert.match(first, /running: 1/);
  assert.match(first, /completed: 1/);
  assert.match(first, /&lt;Ada&gt;/);
  assert.match(first, /Selected: A &amp; B/);
  assert.match(first, /80%/);
  assert.match(first, /jev-1\.13\.0/);
  assert.match(first, /Model answers/);
  assert.match(first, /Synthetic profile; model output is not observed human behavior/);
  assert.match(first, /live-probability/);
  assert.match(first, /title="poll · &lt;Ada&gt; · completed · repeat 1"/);
  assert.doesNotMatch(first, /Member 49/);
  const second = liveRunMembers(run, '', 1);
  assert.match(second, /Page 2 of 2/);
  assert.match(second, /Member 49/);
  assert.match(second, /data-act="live-page" data-page="0"/);
});

test('inline browser client is standalone and renders same live evidence', () => {
  const context = { window: {} as Record<string, unknown> };
  runInNewContext(WORKSPACE_LIVE_UI_CLIENT, context);
  const renderer = context.window.liveRunMembersClient as (run: WorkspaceRun, selected: string, page: number, size: number) => string;
  const html = renderer(run, 'poll:member-0:1', 0, 48);
  assert.match(html, /Selected: A &amp; B/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /live-probability/);
  const scoreRun: WorkspaceRun = { ...run, liveMembers: [{ stage: 'rate', personaId: 'scorer', label: 'Scorer', segment: 'buyers', age: 30, repeat: 1, status: 'completed', answers: { fit: { type: 'score', score: 4, probabilities: { low: 0.1, high: 0.9 } } } }] };
  const score = liveRunMembers(scoreRun, '', 0, 48, 'rate');
  const browserScore = renderer(scoreRun, '', 0, 48, 'rate');
  assert.match(score, /Score: 4[\s\S]*90%/);
  assert.match(browserScore, /Score: 4[\s\S]*90%/);
});

test('live map reports empty run without inventing activity', () => {
  const empty = liveRunMembers({ ...run, liveMembers: undefined });
  assert.match(empty, /Member activity appears when poll phase starts/);
  assert.match(empty, /queued: 0/);
  assert.doesNotMatch(empty, /Observed answers|choice|answer recorded/);
});

test('terminal arena replay reveals saved members in order and hides unrevealed answers', () => {
  const replayRun: WorkspaceRun = {
    ...run,
    status: 'completed',
    liveMembers: [
      { stage: 'poll', personaId: 'one', label: 'Ada', segment: 'buyers', age: 30, repeat: 1, status: 'completed', answers: { preference: { type: 'choice', choice: 'A', probabilities: { A: 0.8, B: 0.2 } } } },
      { stage: 'poll', personaId: 'two', label: 'Bo', segment: 'buyers', age: 40, repeat: 1, status: 'completed', answers: { preference: { type: 'choice', choice: 'SECRET', probabilities: { SECRET: 1 } } } },
      { stage: 'poll', personaId: 'three', label: 'Cal', segment: 'buyers', age: 50, repeat: 1, status: 'failed', reason: 'Saved failure' },
    ],
  };
  const first = liveRunMembers(replayRun, 'poll:two:1', 0, 48, '', { replayCursor: 1, replaySpeed: 2 });
  assert.match(first, /Illustrative replay/);
  assert.match(first, /Saved member order · no timing implied/);
  assert.match(first, /1 of 3 members revealed/);
  assert.match(first, /Evaluated/);
  assert.match(first, /queued: 2/);
  assert.match(first, /This member’s saved result appears when the replay reaches them/);
  assert.doesNotMatch(first, /SECRET|Saved failure/);
  assert.match(first, /data-act="arena-step"/);
  assert.match(first, /data-act="arena-play"/);
  assert.match(first, /data-act="arena-reset"/);
  assert.match(first, /data-act="arena-live"/);
  assert.match(first, /data-act="arena-speed" data-speed="2" aria-pressed="true"/);

  const second = liveRunMembers(replayRun, 'poll:two:1', 0, 48, '', { replayCursor: 2 });
  assert.match(second, /Selected: SECRET/);
  assert.doesNotMatch(liveRunMembers({ ...replayRun, status: 'running' }, '', 0, 48, '', { replayCursor: 1 }), /Illustrative replay/);
  // With no explicit cursor, terminal results keep complete results and offer replay explicitly.
  const complete = liveRunMembers(replayRun, 'poll:two:1');
  assert.match(complete, /Selected: SECRET/);
  assert.match(complete, /data-act="arena-replay"/);
  assert.doesNotMatch(complete, /Illustrative replay controls/);
});

test('stage metadata includes empty pipeline stages and preserves live stage filtering', () => {
  const staged = {
    ...run,
    stages: [
      { id: 'first', label: 'First vote', kind: 'poll', dependsOn: [], status: 'completed' },
      { id: 'combine', label: 'Combine answers', kind: 'aggregate', dependsOn: ['first'], status: 'skipped', reason: 'Branch did not run' },
    ],
  } as WorkspaceRun;
  const html = liveRunMembers(staged, '', 0, 48, 'combine');
  assert.match(html, /First vote/);
  assert.match(html, /Combine answers/);
  assert.match(html, /data-stage="combine" aria-pressed="true"/);
  assert.match(html, /aggregate stage · skipped · Branch did not run/);
  assert.match(html, /Entry stage/);
  assert.match(html, /Depends on First vote/);
  assert.doesNotMatch(html, /arena-stage-number/);
});

test('serialized browser renderer stays in parity for replay privacy and stages', () => {
  const context = { window: {} as Record<string, unknown> };
  runInNewContext(WORKSPACE_LIVE_UI_CLIENT, context);
  const renderer = context.window.liveRunMembersClient as (run: WorkspaceRun, selected: string, page: number, size: number, stage: string, options: { replayCursor?: number }) => string;
  const replayRun = { ...run, status: 'completed' as const, liveMembers: [{ stage: 'poll', personaId: 'hidden', label: 'Hidden person', segment: 'buyers', age: 30, repeat: 1, status: 'completed' as const, answers: { q: { type: 'choice', choice: 'PRIVATE', probabilities: { PRIVATE: 1 } } } }] };
  const html = renderer(replayRun, '', 0, 48, '', { replayCursor: 0 });
  assert.match(html, /Illustrative replay/);
  assert.doesNotMatch(html, /PRIVATE/);
});
