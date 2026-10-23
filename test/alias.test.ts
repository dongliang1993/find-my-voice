import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aliasPrompt, aliasSchema, plainAlias } from '../src/server/profile/alias.js';

test('a bare name needs no model: it is the alias as said', () => {
  assert.equal(plainAlias('阿良'), '阿良');
  assert.equal(plainAlias('  Lin. '), 'Lin');
  assert.equal(plainAlias('阿良。'), '阿良');
});

test('anything that is more than a name goes to the model', () => {
  for (const said of ['叫我阿良就行', '嗯……阿良吧', 'call me Lin', '我叫林小良，你叫我小良']) {
    assert.equal(plainAlias(said), null, said);
  }
});

test('the prompt carries what was said and asks for the alias only', () => {
  const prompt = aliasPrompt('叫我阿良就行');
  assert.match(prompt, /叫我阿良就行/);
  assert.match(prompt, /称呼/);
});

test('the schema accepts a short alias or none, and rejects a sentence', () => {
  assert.deepEqual(aliasSchema.parse({ alias: '阿良' }), { alias: '阿良' });
  assert.deepEqual(aliasSchema.parse({ alias: null }), { alias: null });
  assert.throws(() => aliasSchema.parse({ alias: '这是一句很长很长的话而不是一个称呼名字' }));
});
