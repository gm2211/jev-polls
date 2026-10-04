import test from 'node:test';
import assert from 'node:assert/strict';
import { loadProject } from '../src/schema.js';
import { runPipeline } from '../src/engine.js';
import { createProvider } from '../src/provider.js';
import { parseRun } from '../src/run-record.js';

test('saved runs validate snapshots and refuse contradictory success claims', async () => {
  const { pipeline, cohorts } = await loadProject('examples/game-naming/pipeline.json');
  const run = await runPipeline(pipeline, cohorts, { provider: createProvider('mock'), model: 'test', seed: '1', concurrency: 3 });
  assert.equal(parseRun(run).status, 'completed');
  const changed = structuredClone(run); changed.pipeline.name = 'Edited';
  assert.throws(() => parseRun(changed), /hash/);
  const missing = structuredClone(run); delete missing.cohorts.players;
  assert.throws(() => parseRun(missing), /missing cohort/);
  const failed = structuredClone(run); failed.stages.audience.status = 'failed'; failed.stages.audience.summaries = {};
  assert.throws(() => parseRun(failed), /contradicts/);
  const partial = structuredClone(run); partial.status = 'failed'; partial.stages.audience.status = 'failed';
  assert.throws(() => parseRun(partial), /full-panel/);

  const partialVotes = structuredClone(run);
  partialVotes.status = 'failed';
  partialVotes.stages.audience.status = 'failed';
  partialVotes.stages.audience.summaries = {};
  assert.equal(parseRun(partialVotes).stages.audience?.votes.length, run.stages.audience?.votes.length);

  const wrongChoice = structuredClone(run);
  const choiceVote = wrongChoice.stages.audience!.votes[0]!;
  if (choiceVote.answers.favorite?.type !== 'choice') throw new Error('expected choice vote');
  choiceVote.answers.favorite.choice = Object.keys(choiceVote.answers.favorite.probabilities).find(
    key => key !== choiceVote.answers.favorite!.choice,
  )!;
  assert.throws(() => parseRun(wrongChoice), /not a most likely option/);

  const wrongScore = structuredClone(run);
  const scoreVote = wrongScore.stages.audience!.votes[0]!;
  if (scoreVote.answers.appeal?.type !== 'score') throw new Error('expected score vote');
  scoreVote.answers.appeal.score += 0.1;
  assert.throws(() => parseRun(wrongScore), /score is inconsistent/);

  const wrongSummary = structuredClone(run);
  delete wrongSummary.stages.audience!.summaries.favorite!.probabilities!.deepforge;
  assert.throws(() => parseRun(wrongSummary), /mismatched fields/);
});
