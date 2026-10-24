import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beats } from '../web/src/features/stage/subtitles.js';

test('sentences are beats in order, and short ones share one rather than flicker', () => {
  assert.deepEqual(beats('晚安呀。今天辛苦啦！明天见吗？', null).map(b => b.text),
    ['晚安呀。今天辛苦啦！', '明天见吗？']);
});

test('a long sentence is cut again at a comma, so no beat fills the stage', () => {
  const text = '我想跟你说很多很多话，可是今天实在是有一点困了，所以就先说这些吧。';
  const parts = beats(text, null).map(b => b.text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => [...part].length <= 29));
  assert.equal(parts.join(''), text);
});

test('English is not chopped short: a Latin letter is half a Chinese character wide', () => {
  const parts = beats('Today was my very first day, and I spent the whole morning smiling at names.', null).map(b => b.text);
  assert.ok(parts.every(part => [...part].length >= 20), parts.join(' | '));
});

test('without audio the beats are paced by reading speed, with a breath between', () => {
  const [first, second] = beats('今晚的风好大，我把窗户关上了。你那边冷不冷？', null);
  assert.equal(first!.at, 0);
  assert.ok(second!.at > 0 && second!.at < 4);
});

test('server timing wins over reading speed, and a cut sentence splits its own span', () => {
  const timed = [
    { text: '第一句说得长一点吧。', startsAt: 0 },
    { text: '我想跟你说很多很多话，可是今天实在是有一点困了，所以就先说这些吧。', startsAt: 1 },
    { text: '最后一句。', startsAt: 5 },
  ];
  const parts = beats(timed.map(line => line.text).join(''), timed);
  assert.ok(parts[0]!.text.startsWith('第一句说得长一点吧。'));
  assert.equal(parts.at(-1)!.text, '最后一句。');
  // Every beat after the opening one lands inside its own sentence's span, in order.
  assert.ok(parts.slice(1).every((beat, i, rest) => beat.at >= 1 && beat.at <= 5 && (i === 0 || beat.at > rest[i - 1]!.at)));
});

test('a timed sentence with no next start still lands when the server says', () => {
  const [only] = beats('只有一句。', [{ text: '只有一句。', startsAt: 3 }]);
  assert.equal(only!.at, 3);
});

test('blank text is no beats', () => {
  assert.deepEqual(beats('   ', null), []);
});
