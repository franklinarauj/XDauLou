import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTweetUrl } from '../public/js/tweet-url.js';

test('aceita x.com e twitter.com, com e sem parâmetros de rastreamento', () => {
  for (const input of [
    'https://x.com/fulano/status/1790000000000000001',
    'https://twitter.com/fulano/status/1790000000000000001?s=20',
    'https://x.com/fulano/status/1790000000000000001?s=46&t=AbC-dEf',
    'http://www.twitter.com/fulano/status/1790000000000000001/',
    'https://mobile.twitter.com/fulano/status/1790000000000000001',
    'x.com/fulano/status/1790000000000000001',
    '  https://X.com/fulano/status/1790000000000000001  ',
    'https://fxtwitter.com/fulano/status/1790000000000000001',
  ]) {
    const r = parseTweetUrl(input);
    assert.ok(r, input);
    assert.equal(r.id, '1790000000000000001', input);
    assert.equal(r.username, 'fulano', input);
  }
});

test('extrai o link de um texto compartilhado', () => {
  const r = parseTweetUrl('Olha isso kkk https://x.com/fulano/status/123456789?s=20 muito bom');
  assert.equal(r.id, '123456789');
});

test('aceita /i/status e /i/web/status sem usuário', () => {
  assert.equal(parseTweetUrl('https://x.com/i/status/42').id, '42');
  assert.equal(parseTweetUrl('https://twitter.com/i/web/status/42').id, '42');
  assert.equal(parseTweetUrl('https://x.com/i/status/42').username, null);
});

test('lê o índice de mídia em /video/N', () => {
  assert.equal(parseTweetUrl('https://x.com/a/status/1/video/2').mediaIndex, 1);
  assert.equal(parseTweetUrl('https://x.com/a/status/1/photo/1').mediaIndex, 0);
  assert.equal(parseTweetUrl('https://x.com/a/status/1').mediaIndex, null);
});

test('rejeita links que não são de post', () => {
  for (const input of [
    '',
    'oi',
    'https://x.com/fulano',
    'https://x.com/fulano/likes',
    'https://youtube.com/watch?v=1',
    'https://notx.com/a/status/1',
    'https://x.com.evil.com/a/status/1',
    'https://x.com/a/status/abc',
    'https://x.com/nome_grande_demais_aqui/status/1',
    null,
  ]) {
    assert.equal(parseTweetUrl(input), null, String(input));
  }
});

test('gera URL canônica', () => {
  assert.equal(parseTweetUrl('twitter.com/a/status/9?s=1').canonical, 'https://x.com/a/status/9');
});
