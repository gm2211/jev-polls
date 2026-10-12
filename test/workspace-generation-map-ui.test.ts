import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { GENERATION_MAP_CLIENT } from '../src/workspace-generation-map-ui.js';

function harness() {
  const escape = (value: unknown) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  const calls: string[] = [];
  const context: any = { S: {}, esc: escape, attr: escape, render() {}, root: { querySelector: () => null }, calls,
    api: async (path: string) => { calls.push(path); return { personas: Array.from({ length: 4 }, (_, k) => ({ id: 'p' + k, label: 'Ada <Lovelace> ' + k, age: 30 + k, segment: k % 2 ? 'transit' : 'car', background: 'Drives to work.', attributes: { budget: 'low' } })) }; } };
  new Script(GENERATION_MAP_CLIENT + ';globalThis.t={liveMap,liveMapView,liveMapSignature,liveMapFetch,liveMapAction,liveMapDetail}').runInNewContext(context);
  return context;
}
const segments = [{ id: 'car', label: 'Car commuters' }, { id: 'transit', label: 'Train riders' }];
function job(progress: object) { return { id: 'job-1', status: 'running', cohort: { id: 'c', size: 12 }, progress: { totalPersonas: 12, ...progress } }; }
const shaped = (extra: object = {}) => job({ audienceMap: { segments, plan: '010101010101', batchSizes: [4, 4, 4], acceptedBatches: [0] }, batchDetails: [{ index: 2, size: 4, state: 'writing', attempt: 1, streamingPersonas: 2 }, { index: 3, size: 4, state: 'retrying', attempt: 2, streamingPersonas: 0 }], ...extra });

test('seats show every persona before it is written, grouped by planned segment, with live states', () => {
  const { t } = harness();
  const view = t.liveMapView(shaped());
  assert.deepEqual([...view.seats.map((seat: any) => seat.state)], ['done', 'done', 'done', 'done', 'writing', 'writing', 'queued', 'queued', 'retry', 'retry', 'retry', 'retry']);
  assert.deepEqual([...view.seats.map((seat: any) => seat.segment)], [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]);
  const html = t.liveMap(shaped());
  assert.equal((html.match(/class="live-seat"/g) || []).length, 12);
  assert.match(html, /Car commuters<span data-live-count="0">2 of 6<\/span>/);
  assert.match(html, /Train riders<span data-live-count="1">2 of 6<\/span>/);
  assert.match(html, /Select a seat to inspect/);
  assert.equal(t.liveMapSignature(shaped()), 'plan:12:2');
});

test('without a plan or batch sizes the seats are one ungrouped row of placeholders', () => {
  const { t } = harness();
  const html = t.liveMap(job({}));
  assert.equal((html.match(/data-state="empty"/g) || []).length, 12);
  assert.doesNotMatch(html, /data-live-count/);
  assert.equal(t.liveMapSignature(job({})), 'flat:12:0');
  assert.equal(t.liveMap({ id: 'x', status: 'running', progress: {} }), '', 'only audience jobs get a map');
  assert.equal(t.liveMap({ id: 'big', status: 'running', cohort: { id: 'c', size: 1001 }, progress: {} }), '', 'audiences over 1,000 get no map');
});

test('checked batches are fetched once and selected seats show the escaped profile or why it is not ready', async () => {
  const context = harness(), { t, calls, S } = context;
  S.localJob = shaped();
  t.liveMapFetch(t.liveMapView(S.localJob)); t.liveMapFetch(t.liveMapView(S.localJob));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual([...calls], ['/api/agent/jobs/job-1/members?batch=0']);
  t.liveMapAction('live-seat', { dataset: { i: '1' } });
  const detail = t.liveMapDetail(t.liveMapView(S.localJob));
  assert.match(detail, /Ada &lt;Lovelace> 1/); assert.match(detail, /Age 31/); assert.match(detail, /budget/); assert.match(detail, /Train riders/);
  assert.match(t.liveMap(S.localJob), /aria-pressed="true" aria-label="Ada &lt;Lovelace> 1, Train riders, checked and saved"><span aria-hidden="true">A&lt;<\/span>/);
  t.liveMapAction('live-seat', { dataset: { i: '5' } });
  assert.match(t.liveMapDetail(t.liveMapView(S.localJob)), /Being written now in group 2 \(2 of 4 so far\)/);
  t.liveMapAction('live-seat', { dataset: { i: '9' } });
  assert.match(t.liveMapDetail(t.liveMapView(S.localJob)), /did not pass a check and is being rewritten/);
  S.localJob = { ...shaped(), id: 'job-2' };
  assert.equal(t.liveMapView(S.localJob).st.selected, null, 'a new job starts with no seat selected');
});

test('checked personas take seats planned for their own segment, whatever order they were written in', () => {
  const { t, S } = harness();
  S.localJob = shaped();
  t.liveMapView(S.localJob).st.members[0] = ['transit', 'transit', 'car', 'car'].map((segment, k) => ({ id: 'p' + k, label: 'P' + k, age: 40, segment, background: '', attributes: {} }));
  const seats = t.liveMapView(S.localJob).seats.slice(0, 4);
  assert.deepEqual([...seats.map((seat: any) => seat.member.id)], ['p2', 'p0', 'p3', 'p1']);
  assert.deepEqual([...seats.map((seat: any) => seat.segment)], [0, 1, 0, 1]);
});
