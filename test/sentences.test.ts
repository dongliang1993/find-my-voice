import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitSentences } from '../src/shared/sentences.js';

test('splits on Chinese and English sentence endings, keeping punctuation', () => {
  assert.deepEqual(splitSentences('晚安呀。今天辛苦啦！明天见吗？Good night. See you!'),
    ['晚安呀。', '今天辛苦啦！', '明天见吗？', 'Good night.', 'See you!']);
});

test('keeps closing quotes, ellipses and tildes with their sentence', () => {
  assert.deepEqual(splitSentences('他说"好啊。"然后呢……嗯～我知道了'), ['他说"好啊。"', '然后呢……', '嗯～', '我知道了']);
});

test('merges fragments shorter than the minimum so TTS is not called per word', () => {
  assert.deepEqual(splitSentences('嗯。好。那我们明天一起去吃火锅吧！', { minChars: 6 }), ['嗯。好。那我们明天一起去吃火锅吧！']);
});

test('hard-wraps very long runs at a soft break', () => {
  const long = '我想跟你说很多很多话，' .repeat(20);
  const parts = splitSentences(long, { maxChars: 60 });
  assert.ok(parts.every(p => [...p].length <= 60));
  assert.equal(parts.join(''), long);
});

test('drops blank input and trims whitespace', () => {
  assert.deepEqual(splitSentences('   '), []);
  assert.deepEqual(splitSentences('  你好。 \n 在吗 '), ['你好。', '在吗']);
});

test('cuts only the first chunk short, at a soft break', () => {
  assert.deepEqual(splitSentences('我在呢，那今晚我们就慢慢聊，聊到你困了为止。明天再说也可以，不着急的。', { firstMaxChars: 8 }),
    ['我在呢，', '那今晚我们就慢慢聊，聊到你困了为止。', '明天再说也可以，不着急的。']);
});

test('leaves a first chunk with no soft break whole', () => {
  assert.deepEqual(splitSentences('Absolutely. Fine.', { firstMaxChars: 4 }), ['Absolutely.', 'Fine.']);
});
