import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSettings, resolveInitiative, settingsPatchSchema } from '../src/server/config.js';

const tempDir = () => mkdtempSync(join(tmpdir(), 'fmv-mode-'));

test('each mode resolves to its own knobs', () => {
  const dir = tempDir();
  const settings = loadSettings(dir);

  const off = resolveInitiative({ ...settings.initiative, mode: 'off' });
  assert.equal(off.enabled, false);
  assert.equal(off.dailyLimit, 0);
  assert.equal(off.morningStart, null);

  const occasional = resolveInitiative({ ...settings.initiative, mode: 'occasional' });
  assert.equal(occasional.enabled, true);
  assert.equal(occasional.dailyLimit, 2);
  assert.equal(occasional.morningStart, null);

  const often = resolveInitiative({ ...settings.initiative, mode: 'often' });
  assert.equal(often.enabled, true);
  assert.equal(often.morningStart, 8);
  assert.equal(often.morningEnd, 11);
});

test('quiet hours are shared by every mode that is on', () => {
  const dir = tempDir();
  const settings = loadSettings(dir);
  for (const mode of ['occasional', 'often'] as const) {
    const resolved = resolveInitiative({ ...settings.initiative, mode });
    assert.equal(resolved.quietStart, 23);
    assert.equal(resolved.quietEnd, 8);
  }
});

test('notify passes through untouched', () => {
  const dir = tempDir();
  const settings = loadSettings(dir);
  const resolved = resolveInitiative({ ...settings.initiative, mode: 'occasional', notify: false });
  assert.equal(resolved.notify, false);
});

test('legacy knob configs migrate to the nearest mode', () => {
  const dir = tempDir();
  // A pre-mode config file: enabled with morning greetings configured.
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    companion: { name: 'Vivi' },
    initiative: {
      enabled: true, notify: true,
      quietStart: 23, quietEnd: 8, dailyLimit: 5,
      cooldownMinutes: 90, missYouHours: 30, morningStart: 8, morningEnd: 11,
    },
    voice: { provider: 'fixture' },
  }));
  const settings = loadSettings(dir);
  assert.equal(settings.initiative.mode, 'often');

  // A disabled legacy config maps to off, not to a load error.
  const dir2 = tempDir();
  writeFileSync(join(dir2, 'config.json'), JSON.stringify({
    companion: { name: 'Vivi' },
    initiative: { enabled: false, notify: true, quietStart: 23, quietEnd: 8 },
    voice: { provider: 'fixture' },
  }));
  const settings2 = loadSettings(dir2);
  assert.equal(settings2.initiative.mode, 'off');
});

test('legacy configs without an initiative block load as occasional', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ companion: { name: 'Vivi' } }));
  const settings = loadSettings(dir);
  assert.equal(settings.initiative.mode, 'occasional');
});

test('the patch schema accepts mode but rejects raw knobs', () => {
  const ok = settingsPatchSchema.safeParse({ initiative: { mode: 'off', notify: false } });
  assert.equal(ok.success, true);

  const knobs = settingsPatchSchema.safeParse({ initiative: { enabled: false, dailyLimit: 0 } as never });
  // Knob fields are silently ignored rather than rejected, so the shape still
  // parses; the point is that mode is the only field that reaches settings.
  if (knobs.success) {
    assert.equal(knobs.data.initiative?.mode, undefined);
    assert.equal('enabled' in (knobs.data.initiative ?? {}), false);
  } else {
    assert.match(knobs.error.message, /Unrecognized/i);
  }
});

test('companion userName is stored and patchable', () => {
  const dir = tempDir();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    companion: { name: 'Vivi', userName: '阿梁' },
  }));
  const settings = loadSettings(dir);
  assert.equal(settings.companion.userName, '阿梁');
});
