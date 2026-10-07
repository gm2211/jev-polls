import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { parseAnswerCsv } from '../src/answer-csv.js';

test('parses quoted values, escaped quotes, multiline cells, BOM and mixed newlines', () => {
  const input = '\uFEFF  Red ,"blue, green"\r\n"say ""hello""",  5  \n"line one\r\nline two",last';
  assert.deepEqual(parseAnswerCsv(input), [
    ['Red', 'blue, green'],
    ['say "hello"', '5'],
    ['line one\r\nline two', 'last'],
  ]);
});

test('keeps row and cell order, empty fields, and skips fully blank rows', () => {
  assert.deepEqual(parseAnswerCsv('\n\r\nFirst,,Third\n   , \nFourth, Fifth,'), [
    ['First', '', 'Third'],
    ['Fourth', 'Fifth', ''],
  ]);
  assert.deepEqual(parseAnswerCsv(''), []);
});

test('accepts surrounding spaces and tabs around quoted quick-list options', () => {
  assert.deepEqual(parseAnswerCsv('Low, "Medium, steady", High'), [['Low', 'Medium, steady', 'High']]);
  assert.deepEqual(parseAnswerCsv('Low,\t"Medium, steady"\t, High'), [['Low', 'Medium, steady', 'High']]);
});

test('reports malformed quote placement and line endings', () => {
  assert.throws(() => parseAnswerCsv('"unfinished'), /unterminated quoted cell/i);
  assert.throws(() => parseAnswerCsv('un"quoted'), /quote inside an unquoted cell/i);
  assert.throws(() => parseAnswerCsv('"closed"tail'), /unexpected text after a closing quote/i);
  assert.throws(() => parseAnswerCsv('one\rtwo'), /bare carriage return/i);
});

test('rejects input above 256 KiB and can be reconstructed from its function source', () => {
  assert.throws(() => parseAnswerCsv('a'.repeat(256 * 1024 + 1)), /maximum size is 256 KiB/i);
  const reconstructed = runInNewContext(`(${parseAnswerCsv.toString()})`, { TextEncoder }) as typeof parseAnswerCsv;
  assert.equal(JSON.stringify(reconstructed('"one, two",three')), JSON.stringify([['one, two', 'three']]));
});
