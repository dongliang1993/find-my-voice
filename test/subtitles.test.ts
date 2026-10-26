import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beats } from '../web/src/features/stage/subtitles.js';

test('sentences are beats in order, and short ones share one rather than flicker', () => {
  assert.deepEqual(beats('晚安呀。今天辛苦啦！明天见吗？', null).map(b => b.text),
    ['晚安呀。今天辛苦啦！', '明天见吗？']);
});

test('a long sentence stays one beat: it is never split across two', () => {
  const text = '我想跟你说很多很多话，可是今天实在是有一点困了，所以就先说这些吧。';
  assert.deepEqual(beats(text, null).map(b => b.text), [text]);
});

test('English is cut at sentence ends, not at a width', () => {
  const text = 'Try a flat white. And if you’re feeling lazy, a latte never does you wrong.';
  assert.deepEqual(beats(text, null).map(b => b.text), ['Try a flat white.', 'And if you’re feeling lazy, a latte never does you wrong.']);
});

test('without audio the beats are paced by reading speed, with a breath between', () => {
  const [first, second] = beats('今晚的风好大，我把窗户关上了。你那边冷不冷？', null);
  assert.equal(first!.at, 0);
  assert.ok(second!.at > 0 && second!.at < 4);
});

test('server timing wins over reading speed, one beat per sentence', () => {
  const timed = [
    { text: '第一句说得长一点吧。', startsAt: 0 },
    { text: '我想跟你说很多很多话，可是今天实在是有一点困了，所以就先说这些吧。', startsAt: 1 },
    { text: '最后一句。', startsAt: 5 },
  ];
  assert.deepEqual(beats(timed.map(line => line.text).join(''), timed), [
    { text: '第一句说得长一点吧。', at: 0 },
    { text: '我想跟你说很多很多话，可是今天实在是有一点困了，所以就先说这些吧。', at: 1 },
    { text: '最后一句。', at: 5 },
  ]);
});

test('a piece the voice cut early at a comma is joined back onto the rest of its sentence', () => {
  const timed = [
    { text: 'And if you’re feeling lazy,', startsAt: 0 },
    { text: 'a latte never does you wrong.', startsAt: 1.4 },
    { text: 'Want me to find a café nearby?', startsAt: 3 },
  ];
  assert.deepEqual(beats(timed.map(line => line.text).join(' '), timed), [
    { text: 'And if you’re feeling lazy, a latte never does you wrong.', at: 0 },
    { text: 'Want me to find a café nearby?', at: 3 },
  ]);
});

test('a line break still ends a list item without punctuation', () => {
  const timed = [
    { text: '街角那家店的燕麦拿铁', startsAt: 0 },
    { text: '冰美式加一点点焦糖糖浆', startsAt: 1 },
  ];
  assert.deepEqual(beats('街角那家店的燕麦拿铁\n冰美式加一点点焦糖糖浆', timed).map(b => b.text),
    ['街角那家店的燕麦拿铁', '冰美式加一点点焦糖糖浆']);
});

test('a timed sentence with no next start still lands when the server says', () => {
  const [only] = beats('只有一句。', [{ text: '只有一句。', startsAt: 3 }]);
  assert.equal(only!.at, 3);
});

test('blank text is no beats', () => {
  assert.deepEqual(beats('   ', null), []);
});
