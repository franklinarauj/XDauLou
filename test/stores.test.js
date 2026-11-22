import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashKey, MemoryStore } from '../server/stores.js';

test('cache em memória expira pelo TTL', async () => {
  const s = new MemoryStore();
  await s.set('a', { x: 1 }, 30);
  assert.deepEqual(await s.get('a'), { x: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await s.get('a'), undefined);
  await s.close();
});

test('cache em memória descarta o item menos usado ao lotar', async () => {
  const s = new MemoryStore({ maxEntries: 2 });
  await s.set('a', 1, 10_000);
  await s.set('b', 2, 10_000);
  await s.get('a');
  await s.set('c', 3, 10_000);
  assert.equal(await s.get('b'), undefined);
  assert.equal(await s.get('a'), 1);
  assert.equal(await s.get('c'), 3);
  await s.close();
});

test('contador de janela reinicia após a janela', async () => {
  const s = new MemoryStore();
  assert.equal((await s.incr('k', 40)).count, 1);
  assert.equal((await s.incr('k', 40)).count, 2);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal((await s.incr('k', 40)).count, 1);
  await s.close();
});

test('chaves são hashes, nunca o valor original', () => {
  const k = hashKey('203.0.113.9');
  assert.match(k, /^[0-9a-f]{32}$/);
  assert.equal(hashKey('203.0.113.9'), k, 'mesma entrada, mesma chave');
  assert.notEqual(hashKey('203.0.113.10'), k);
});
