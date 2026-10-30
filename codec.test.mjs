import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decode, encode } from './codec.mjs';

const vectors = JSON.parse(await readFile(new URL('./vectors.json', import.meta.url), 'utf8'));

test('shared payload vectors', async () => {
  const original = crypto.getRandomValues;
  try {
    for (const vector of vectors.valid) {
      const nonce = Uint8Array.from(Buffer.from(vector.nonce, 'hex'));
      crypto.getRandomValues = bytes => { bytes.set(nonce); return bytes; };
      assert.deepEqual(await decode(vector.payload), vector.expected, vector.name);
      assert.equal(await encode(vector.input), vector.payload, vector.name);
    }
  } finally { crypto.getRandomValues = original; }
  for (const vector of vectors.invalid) {
    await assert.rejects(decode(vector.payload), { message: 'This link is not valid' }, vector.name);
  }
  const first = await encode(vectors.valid[0].input);
  const second = await encode(vectors.valid[0].input);
  assert.notEqual(first, second);
  assert.deepEqual(await decode(first), vectors.valid[0].expected);
  await assert.rejects(encode({ id: 'bad', t: 0 }), { message: 'This link is not valid' });
});
