import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lapseAt, readLapse } from '../web/src/features/stage/timelapse.js';

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const base = new Date(2026, 9, 25, 12, 0);

test('it starts at the first hour, ends at the last, and passes through the middle', () => {
  const lapse = readLapse('?timelapse=06:00-23:40&seconds=10');
  assert.deepEqual(lapse, { from: 360, to: 1420, ms: 10_000 });
  assert.equal(hm(lapseAt(lapse, 0, base)), '06:00');
  assert.equal(hm(lapseAt(lapse, 1, base)), '23:40');
  assert.equal(hm(lapseAt(lapse, 0.5, base)), '14:50');
});

test('a day that runs past midnight carries on into the small hours', () => {
  const lapse = readLapse('?timelapse=20:00-02:00');
  assert.equal(hm(lapseAt(lapse, 0.5, base)), '23:00');
  assert.equal(hm(lapseAt(lapse, 1, base)), '02:00');
});

test('without a query it is a whole waking day in ten seconds; nonsense falls back too', () => {
  assert.deepEqual(readLapse(''), { from: 360, to: 1420, ms: 10_000 });
  assert.deepEqual(readLapse('?timelapse=25:00-xx&seconds=-3'), { from: 360, to: 1420, ms: 10_000 });
  assert.equal(readLapse('?seconds=4').ms, 4000);
});

test('progress outside 0..1 is held at the ends', () => {
  const lapse = readLapse('');
  assert.equal(hm(lapseAt(lapse, -1, base)), '06:00');
  assert.equal(hm(lapseAt(lapse, 2, base)), '23:40');
});
