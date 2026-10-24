import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, backlog, caughtUp, chunkLength, letterSegments, PACE, shownChunks, speedFor, startPen, type Segment } from '../web/src/features/letter/pace.js';

/** Always the middle of every range. */
const mid = () => 0.5;
const seg = (text: string, kind: Segment['kind'] = 'paragraph', key = 'p'): Segment => ({ key, kind, text });
const written = (pen: ReturnType<typeof startPen>, segments: Segment[]) =>
  segments.map((_, i) => shownChunks(pen, segments, i).map(c => c.text).join('')).join('|');

test('chunks are a few Chinese characters, and stop right after punctuation', () => {
  assert.equal(chunkLength('下雨的周六适合慢一点的东西', 0, mid), 4);
  assert.equal(chunkLength('下雨，适合慢一点', 0, mid), 3, 'the comma ends the chunk');
  assert.equal(chunkLength('好。', 0, mid), 2);
  assert.equal(chunkLength('下雨', 0, () => 1), 2, 'never past the end');
});

test('English goes a word or two at a time', () => {
  assert.equal('Peace Piece by Bill'.slice(0, chunkLength('Peace Piece by Bill', 0, () => 0)), 'Peace ');
  assert.equal('Peace Piece by Bill'.slice(0, chunkLength('Peace Piece by Bill', 0, () => 1)), 'Peace Piece ');
  assert.equal('Hi, there'.slice(0, chunkLength('Hi, there', 0, () => 1)), 'Hi,');
});

test('about sixteen Chinese characters a second', () => {
  const text = '下雨的周六适合慢一点的东西'.repeat(5);
  const segments = [seg(text)];
  const pen = advance(startPen(0), segments, 1000, { random: mid });
  const perSecond = shownChunks(pen, segments, 0).map(c => c.text).join('').length;
  assert.ok(perSecond >= 14 && perSecond <= 20, `wrote ${perSecond} in a second`);
});

test('a comma, a full stop, a new line and a new heading each pause longer than the last', () => {
  const time = (segments: Segment[]) => {
    let pen = startPen(0);
    for (let t = 0; t < 10_000 && !caughtUp(pen, segments); t += 10) pen = advance(pen, segments, t, { random: mid });
    return pen.lastAt;
  };
  const plain = time([seg('一二三四五六七八')]);
  const comma = time([seg('一二三，四五六七八')]);
  const stop = time([seg('一二三。四五六七八')]);
  assert.ok(comma - plain >= PACE.commaMs - 20, `comma pauses: ${comma - plain}`);
  assert.ok(stop - comma >= PACE.stopMs - PACE.commaMs - 40, `full stop pauses longer: ${stop - comma}`);
  const line = time([seg('一二三四', 'name', 'a'), seg('五六七八', 'name', 'b')]);
  const heading = time([seg('一二三四', 'name', 'a'), seg('五六七八', 'heading', 'b')]);
  assert.ok(heading - line >= PACE.headingMs - PACE.newLineMs - 40, `a heading pauses longer than a line: ${heading - line}`);
});

test('the pen waits where it is when the model has not written more yet, and does not burst after', () => {
  let segments = [seg('下雨的周六')];
  let pen = advance(startPen(0), segments, 5000, { random: mid });
  assert.ok(caughtUp(pen, segments));
  // Five seconds later more arrives: it is written at pace, not all at once.
  segments = [seg('下雨的周六，适合慢一点的东西，我挑了几部电影')];
  pen = advance(pen, segments, 5050, { random: mid });
  assert.ok(backlog(pen, segments) > 10, 'still writing, not flushed');
});

test('a long backlog speeds her up, to at most twice as fast', () => {
  assert.equal(speedFor(0), 1);
  assert.equal(speedFor(PACE.backlogChars), 1);
  assert.ok(speedFor(PACE.backlogChars + 150) > 1.4);
  assert.equal(speedFor(5000), 2);
  assert.equal(speedFor(0, 2), 2, 'a replay is twice as fast from the start');
});

test('skipping shows everything, and whatever arrives after too', () => {
  const segments = [seg('下雨天', 'title', 'title'), seg('花样年华', 'name', 'b1:name')];
  const skipped = advance({ ...startPen(0), instant: true }, segments, 0);
  assert.equal(written(skipped, segments), '下雨天|花样年华');
  const more = [...segments, seg('如果只看一部', 'note', 'b1:note')];
  assert.equal(written(advance(skipped, more, 1), more), '下雨天|花样年华|如果只看一部');
});

test('picking up a letter part-way: what is there shows at once, only new text is paced', () => {
  const segments = [seg('下雨天', 'title', 'title'), seg('花样年华', 'name', 'b1:name')];
  const pen = startPen(0, segments, { atEnd: true });
  assert.equal(written(pen, segments), '下雨天|花样年华');
  const more = [...segments, seg('如果只看一部，就是它。', 'note', 'b1:note')];
  assert.equal(written(advance(pen, more, 10, { random: mid }), more), '下雨天|花样年华|', 'the note waits its pause first');
});

test('each chunk keeps its start, so the newest can fade in on its own', () => {
  const segments = [seg('下雨的周六适合慢一点')];
  const pen = advance(startPen(0), segments, 400, { random: mid });
  const chunks = shownChunks(pen, segments, 0);
  assert.ok(chunks.length >= 2);
  assert.equal(chunks[0]?.at, 0);
  assert.equal(chunks[1]?.at, chunks[0]!.text.length);
});

test('a letter is written title first, then each block, an item as its name then its note', () => {
  const segments = letterSegments({
    title: '下雨天',
    blocks: [
      { id: 'b1', type: 'heading', text: '电影' },
      { id: 'b2', type: 'item', name: '花样年华', note: '就是它', link: null },
      { id: 'b3', type: 'item', name: '迷失东京', note: '', link: null },
    ],
  });
  assert.deepEqual(segments.map(s => s.key), ['title', 'b1:text', 'b2:name', 'b2:note', 'b3:name']);
});
