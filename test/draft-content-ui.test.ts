import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { DRAFT_CONTENT_CLIENT } from '../src/draft-content-ui.js';

const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const context: any = { esc, TextEncoder, Error };
new Script(DRAFT_CONTENT_CLIENT + '\nglobalThis.api={markdownHtml,plural,materialReadFile};').runInNewContext(context);
const { markdownHtml, plural, materialReadFile } = context.api;
const file = (text: string, name = 'notes.json', size = Buffer.byteLength(text)) => ({ name, size, text: async () => text });

test('markdown renders paragraphs, bullets, bold and code with every other character escaped', () => {
  assert.equal(markdownHtml('Made **two** studies.\n\n- Uses `Deterrent`\n* Second\n\nAfter list'), '<p>Made <strong>two</strong> studies.</p><ul><li>Uses <code>Deterrent</code></li><li>Second</li></ul><p>After list</p>');
  assert.equal(markdownHtml('line one\nline two'), '<p>line one<br>line two</p>');
  assert.equal(markdownHtml(''), '');
});

test('markdown never passes provider text through as markup', () => {
  const html = markdownHtml('<img src=x onerror=alert(1)> **<script>alert(1)</script>**\n- <b>x</b> `<i>`\n[link](javascript:alert(1))');
  assert.doesNotMatch(html, /<img|<script|<b>|<i>|<a /);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(html, /<strong>&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/strong>/); assert.match(html, /<code>&lt;i&gt;<\/code>/);
});

test('plural labels counts', () => {
  assert.equal(plural(1, 'persona'), '1 persona'); assert.equal(plural(0, 'persona'), '0 personas'); assert.equal(plural(17, 'step'), '17 steps'); assert.equal(plural(2, 'study', 'studies'), '2 studies');
});

test('attached material accepts UTF-8 text files and rejects other files with fixed messages', async () => {
  assert.equal(await materialReadFile(file('[["A","b"]]')), '[["A","b"]]');
  await assert.rejects(materialReadFile(file('x', 'photo.png')), /TXT, Markdown, CSV or JSON/);
  await assert.rejects(materialReadFile(file('x', 'big.txt', 256 * 1024 + 1)), /too large/);
  await assert.rejects(materialReadFile(file('x'.repeat(256 * 1024 + 1), 'big.txt', 10)), /too large/);
  await assert.rejects(materialReadFile(file('a\u0000b')), /UTF-8/); await assert.rejects(materialReadFile(file('bad�')), /UTF-8/);
  await assert.rejects(materialReadFile(file('  \n')), /empty/);
});

test('markdown renders bold spans that contain inline code', () => {
  assert.equal(markdownHtml('**Phase 1 (`market`):** rank them'), '<p><strong>Phase 1 (<code>market</code>):</strong> rank them</p>');
  assert.equal(markdownHtml('**open `<b>` still'), '<p>**open <code>&lt;b&gt;</code> still</p>');
  assert.equal(markdownHtml('`**not bold**`'), '<p><code>**not bold**</code></p>');
});

test('markdown renders ordered lists on separate lines and inline after a colon', () => {
  assert.equal(markdownHtml('Plan:\n1. First **one**\n2. Second `two`\n\nDone'), '<p>Plan:</p><ol><li>First <strong>one</strong></li><li>Second <code>two</code></li></ol><p>Done</p>');
  assert.equal(markdownHtml('Two phases: 1. Score names 2. Rank <b>finalists</b>'), '<p>Two phases:</p><ol><li>Score names</li><li>Rank &lt;b&gt;finalists&lt;/b&gt;</li></ol>');
  assert.equal(markdownHtml('- a\n1. b'), '<ul><li>a</li></ul><ol><li>b</li></ol>');
  assert.equal(markdownHtml('Version: 1. only one'), '<p>Version: 1. only one</p>');
});
