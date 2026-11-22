import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { findFfmpeg } from '../server/binaries.js';
import { loadConfig } from '../server/config.js';
import { createExtractorService } from '../server/extractors/index.js';
import { createSyndicationExtractor } from '../server/extractors/syndication.js';
import { createGifService } from '../server/gif.js';
import { MemoryStore } from '../server/stores.js';
import { createFakeX, IDS, makeSampleMedia } from './fake-x.js';

let server;
let base;
let fake;
let store;
// Resolvido antes de definir os testes, para o `skip` do teste de GIF funcionar.
const ffmpegPath = await findFfmpeg(process.env.FFMPEG_PATH);

before(async () => {
  const sample = ffmpegPath ? makeSampleMedia(ffmpegPath) : null;
  fake = createFakeX({ sample });
  const config = loadConfig({
    rateLimit: { windowSeconds: 60, extract: 1000, download: 1000, gif: 1000 },
  });
  store = new MemoryStore();
  const extractorService = createExtractorService({
    extractors: [createSyndicationExtractor({ fetchImpl: fake.fetchImpl, timeoutMs: 2000 })],
    store,
    ttlMs: 60_000,
    fetchImpl: fake.fetchImpl,
  });
  const gifService = createGifService({ ffmpegPath, fetchImpl: fake.fetchImpl, timeoutMs: 2000, gif: config.gif });
  const app = createApp({ config, store, extractorService, gifService, fetchImpl: fake.fetchImpl });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await store.close();
});

const extract = (url) =>
  fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

test('página inicial com cabeçalhos de segurança', async () => {
  const res = await fetch(base);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /XDauLou/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(res.headers.get('x-powered-by'), null);
});

test('extrai vídeo com qualidades e tamanhos', async () => {
  const res = await extract(`https://twitter.com/fulano/status/${IDS.video}?s=20`);
  assert.equal(res.status, 200);
  const { post, selectedIndex } = await res.json();
  assert.equal(selectedIndex, 0);
  assert.equal(post.author.username, 'fulano');
  const v = post.media[0].variants;
  assert.deepEqual(v.map((x) => x.label), ['1080p', '720p', '360p', '270p']);
  assert.ok(v.every((x) => x.sizeBytes > 0 && x.sizeEstimated === false));
  assert.equal(post.media[0].canGif, Boolean(ffmpegPath), 'vídeo de 42 s pode virar GIF');
});

test('segunda busca do mesmo post vem do cache', async () => {
  const before = fake.calls.syndication;
  await extract(`https://x.com/fulano/status/${IDS.video}`);
  assert.equal(fake.calls.syndication, before);
});

test('respeita /video/2 em post com várias mídias', async () => {
  const { post, selectedIndex } = await (await extract(`https://x.com/a/status/${IDS.multi}/video/2`)).json();
  assert.equal(post.media.length, 2);
  assert.equal(selectedIndex, 1);
});

test('erros amigáveis', async () => {
  const cases = [
    ['https://youtube.com/watch?v=1', 400, 'INVALID_URL'],
    [`https://x.com/a/status/${IDS.private}`, 403, 'PRIVATE'],
    [`https://x.com/a/status/${IDS.missing}`, 404, 'NOT_FOUND'],
    [`https://x.com/a/status/${IDS.photos}`, 404, 'ONLY_PHOTOS'],
  ];
  for (const [url, status, code] of cases) {
    const res = await extract(url);
    assert.equal(res.status, status, url);
    const body = await res.json();
    assert.equal(body.error.code, code);
    assert.ok(body.error.message.length > 10);
  }
});

test('JSON inválido vira erro de link', async () => {
  const res = await fetch(`${base}/api/extract`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert.equal(res.status, 400);
});

/** Busca um post e devolve a query assinada da variante pedida. */
async function signedVariant(id, label) {
  const { post } = await (await extract(`https://x.com/a/status/${id}`)).json();
  const v = label ? post.media[0].variants.find((x) => x.label === label) : post.media[0].variants[0];
  return { v, post, query: `src=${encodeURIComponent(v.url)}&exp=${v.exp}&sig=${encodeURIComponent(v.sig)}` };
}

test('download vem como anexo, com nome seguro e tamanho', async () => {
  const { query } = await signedVariant(IDS.video, '720p');
  const res = await fetch(`${base}/api/download?${query}&name=${encodeURIComponent('XDauLou_fulano/../ção"x')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'video/mp4');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="XDauLou_fulano_.._cao_x.mp4"');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(String(buf.length), res.headers.get('content-length'));
});

test('proxy só aceita links assinados pelo próprio servidor (sem proxy aberto)', async () => {
  const { v } = await signedVariant(IDS.video);
  const src = encodeURIComponent(v.url);
  const cases = [
    `src=${src}`, // sem assinatura
    `src=${src}&exp=${v.exp}&sig=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`, // assinatura falsa
    `src=${encodeURIComponent('https://video.twimg.com/outro.mp4')}&exp=${v.exp}&sig=${v.sig}`, // assinatura de outro arquivo
    `src=${src}&exp=${v.exp + 1000}&sig=${v.sig}`, // prazo adulterado
    `src=${src}&src=${src}&exp=${v.exp}&sig=${v.sig}`, // parâmetro repetido
  ];
  for (const q of cases) {
    for (const route of ['download', 'gif', 'thumb']) {
      const res = await fetch(`${base}/api/${route}?${q}`);
      assert.equal(res.status, 400, `${route}: ${q}`);
      assert.equal((await res.json()).error.code, 'MEDIA_NOT_ALLOWED');
    }
  }
});

test('miniatura passa pelo servidor (o navegador não fala com o X)', async () => {
  const { post } = await signedVariant(IDS.video);
  assert.match(post.media[0].thumbnail, /^\/api\/thumb\?src=.+&exp=\d+&sig=/);
  const res = await fetch(base + post.media[0].thumbnail);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
});

test('converte MP4 em GIF de verdade', { skip: !ffmpegPath && 'ffmpeg não encontrado' }, async () => {
  const { query } = await signedVariant(IDS.gif);
  const res = await fetch(`${base}/api/gif?${query}&q=sd&name=teste`);
  assert.equal(res.status, 200, await res.clone().text().catch(() => ''));
  assert.equal(res.headers.get('content-type'), 'image/gif');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="teste.gif"');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 6).toString('ascii'), 'GIF89a');
  assert.ok(buf.length > 1000);
});

test('rota inexistente da API responde JSON 404', async () => {
  const res = await fetch(`${base}/api/nada`);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'NOT_FOUND_ROUTE');
});

test('rate limit por IP', async () => {
  const local = new MemoryStore();
  const config = loadConfig({ rateLimit: { windowSeconds: 60, extract: 2, download: 2, gif: 1 } });
  const svc = createExtractorService({
    extractors: [createSyndicationExtractor({ fetchImpl: fake.fetchImpl, timeoutMs: 2000 })],
    store: local,
    ttlMs: 60_000,
    fetchImpl: fake.fetchImpl,
  });
  const gifService = createGifService({ ffmpegPath: null, fetchImpl: fake.fetchImpl, timeoutMs: 2000, gif: config.gif });
  const app = createApp({ config, store: local, extractorService: svc, gifService, fetchImpl: fake.fetchImpl });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${srv.address().port}/api/extract`;
  const call = () =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://x.com/a/status/${IDS.video}` }),
    });
  assert.equal((await call()).status, 200);
  assert.equal((await call()).status, 200);
  const blocked = await call();
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal((await blocked.json()).error.code, 'RATE_LIMITED');
  await new Promise((r) => srv.close(r));
  await local.close();
});

test('link assinado expira', async () => {
  const local = new MemoryStore();
  const config = loadConfig({ signedUrlTtlSeconds: -5 });
  const svc = createExtractorService({
    extractors: [createSyndicationExtractor({ fetchImpl: fake.fetchImpl, timeoutMs: 2000 })],
    store: local,
    ttlMs: 60_000,
    fetchImpl: fake.fetchImpl,
  });
  const gifService = createGifService({ ffmpegPath: null, fetchImpl: fake.fetchImpl, timeoutMs: 2000, gif: config.gif });
  const app = createApp({ config, store: local, extractorService: svc, gifService, fetchImpl: fake.fetchImpl });
  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const root = `http://127.0.0.1:${srv.address().port}`;
  const { post } = await (
    await fetch(`${root}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://x.com/a/status/${IDS.video}` }),
    })
  ).json();
  const v = post.media[0].variants[0];
  const res = await fetch(`${root}/api/download?src=${encodeURIComponent(v.url)}&exp=${v.exp}&sig=${v.sig}`);
  assert.equal(res.status, 410);
  assert.equal((await res.json()).error.code, 'LINK_EXPIRED');
  await new Promise((r) => srv.close(r));
  await local.close();
});
