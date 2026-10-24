import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainText } from '../src/shared/plain.js';
import { splitSentences } from '../src/shared/sentences.js';

test('the reply from the screenshot comes out as plain lines', () => {
  const raw = '<p>Rainy day picks:</p> <p>Movies — In the Mood for Love</p>';
  assert.equal(plainText(raw).trim(), 'Rainy day picks:\n\nMovies — In the Mood for Love');
  assert.doesNotMatch(plainText(raw), /<|>/);
});

test('a tag still being written at the end of a stream is hidden, not flashed', () => {
  assert.equal(plainText('Rainy day picks:</p> <p'), 'Rainy day picks:\n ');
  assert.equal(plainText('好呀 <stro'), '好呀 ');
});

test('markdown markers go, the words stay', () => {
  assert.equal(plainText('## 下雨天\n- 《花样年华》\n- 《海街日记》'), '下雨天\n《花样年华》\n《海街日记》');
  assert.equal(plainText('1. 先烧水\n2) 再下面'), '先烧水\n再下面');
  assert.equal(plainText('我最想推荐**《花样年华》**，很*安静*。'), '我最想推荐《花样年华》，很安静。');
  assert.equal(plainText('看看[这个](https://example.com)'), '看看这个');
  assert.equal(plainText('> 引用'), '引用');
});

test('ordinary speech is left alone', () => {
  for (const text of ['今天下雨了，要不要听点爵士？', 'It is 3 * 4 = 12, right?', '5 - 3 = 2', '我们约 3.5 点见']) {
    assert.equal(plainText(text), text);
  }
});

test('an emphasis marker waiting for its pair at the end of a stream is hidden', () => {
  assert.equal(plainText('我最想推荐**'), '我最想推荐');
});

test('a list, once stripped, reads item by item rather than as one run-on line', () => {
  const lines = splitSentences(plainText('- 花样年华\n- 海街日记\n- 情书'));
  assert.deepEqual(lines, ['花样年华', '海街日记', '情书']);
});
