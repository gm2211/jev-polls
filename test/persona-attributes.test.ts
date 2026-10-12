import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createAttributeFormat, PERSONA_ATTRIBUTES_CLIENT } from '../src/persona-attributes.js';

const attrs = createAttributeFormat();
const games = [{ game: 'Solitaire Grand Harvest', lifetimeHours: 300, costUsd: 5 }, { game: 'Candy <Crush>', lifetimeHours: 1400, costUsd: 0 }];

test('keys read as plain words, with units and acronyms kept', () => {
  assert.equal(attrs.label('Top10Games'), 'Top 10 games');
  assert.equal(attrs.label('currentGames'), 'Current games');
  assert.equal(attrs.label('costUsd'), 'Cost (USD)');
  assert.equal(attrs.label('hoursSinceLatestStreak'), 'Hours since latest streak');
  assert.equal(attrs.label('income_band'), 'Income band');
  assert.equal(attrs.label('NPSScore'), 'NPS score');
  assert.equal(attrs.label('INCOME_BAND'), 'Income band');
  assert.equal(attrs.label('attributes.country'), 'Country');
});

test('a list of records is a table with humanized headers and formatted, escaped cells', () => {
  const html = attrs.html(games, 'top10Games');
  assert.doesNotMatch(html, /[{}"]lifetimeHours/);
  assert.match(html, /<table class="attr-table">/);
  assert.match(html, /<th>Game<\/th><th class="num">Lifetime hours<\/th><th class="num">Cost \(USD\)<\/th>/);
  assert.match(html, /<td>Solitaire Grand Harvest<\/td><td class="num">300<\/td><td class="num">\$5<\/td>/);
  assert.match(html, /<td>Candy &lt;Crush&gt;<\/td><td class="num">1,400<\/td><td class="num">Free<\/td>/);
  assert.equal(attrs.wide(games), true);
});

test('records become label/value rows; scalars and plain lists stay inline text', () => {
  assert.match(attrs.html({ platform: 'iOS', monthlySpendUsd: 12.5, likesAds: false }), /<dt>Platform<\/dt><dd>iOS<\/dd><\/div><div><dt>Monthly spend \(USD\)<\/dt><dd>\$12\.5<\/dd><\/div><div><dt>Likes ads<\/dt><dd>No<\/dd>/);
  assert.equal(attrs.html(['Doom', 'Halo']), 'Doom, Halo');
  assert.equal(attrs.html('$28k-$38k'), '$28k-$38k');
  assert.equal(attrs.html(null), '—');
  assert.equal(attrs.wide(['a']), false);
  assert.equal(attrs.text(games.slice(0, 1)), 'Game: Solitaire Grand Harvest · Lifetime hours: 300 · Cost (USD): $5');
});

test('the inline client defines the same formatter', () => {
  const context: Record<string, any> = {};
  runInNewContext(PERSONA_ATTRIBUTES_CLIENT + ';globalThis.out=personaAttrs.html(' + JSON.stringify(games) + ')', context);
  assert.equal(context.out, attrs.html(games));
});
