import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../server/errors.js';
import { createExtractorService } from '../server/extractors/index.js';
import { normalizeSyndication, syndicationToken } from '../server/extractors/syndication.js';
import { normalizeYtdlp } from '../server/extractors/ytdlp.js';
import { parseAllowedUrl, qualityLabel, VIDEO_HOSTS } from '../server/media.js';
import { MemoryStore } from '../server/stores.js';
import { AGE_TOMBSTONE, GIF_TWEET, PHOTO_TWEET, PRIVATE_TOMBSTONE, QUOTE_TWEET, VIDEO_TWEET } from './fixtures.js';

const code = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError);
    return err.code;
  }
  return null;
};

test('token de syndication é alfanumérico sem zeros nem ponto', () => {
  const t = syndicationToken('1790000000000000001');
  assert.match(t, /^[1-9a-z]+$/);
});

test('normaliza vídeo: só MP4, maior qualidade primeiro, rótulos e duração', () => {
  const post = normalizeSyndication(VIDEO_TWEET, '1');
  assert.equal(post.author.username, 'fulano');
  assert.equal(post.text, 'Olha esse gol');
  assert.equal(post.media.length, 1);
  const m = post.media[0];
  assert.equal(m.type, 'video');
  assert.equal(m.durationMs, 42000);
  assert.deepEqual(m.variants.map((v) => v.label), ['1080p', '720p', '360p', '270p']);
  assert.ok(m.variants.every((v) => v.url.includes('.mp4')));
});

test('normaliza GIF (MP4 em loop)', () => {
  const post = normalizeSyndication(GIF_TWEET, '2');
  assert.equal(post.media[0].type, 'gif');
  assert.equal(post.media[0].variants[0].label, '360p');
});

test('mapeia erros: privado, sensível, vazio, só fotos', () => {
  assert.equal(code(() => normalizeSyndication(PRIVATE_TOMBSTONE, '3')), 'PRIVATE');
  assert.equal(code(() => normalizeSyndication(AGE_TOMBSTONE, '3')), 'SENSITIVE');
  assert.equal(code(() => normalizeSyndication({}, '4')), 'NOT_FOUND');
  assert.equal(code(() => normalizeSyndication(PHOTO_TWEET, '5')), 'ONLY_PHOTOS');
  assert.equal(code(() => normalizeSyndication({ __typename: 'Tweet', text: 'oi', user: {} }, '6')), 'NO_MEDIA');
});

test('usa a mídia do post citado quando o post não tem vídeo', () => {
  const post = normalizeSyndication(QUOTE_TWEET, '6');
  assert.equal(post.fromQuote, true);
  assert.equal(post.media.length, 1);
});

test('normaliza saída do yt-dlp', () => {
  const post = normalizeYtdlp(
    {
      uploader: 'Fulano',
      uploader_id: 'fulano',
      description: 'oi https://t.co/x',
      duration: 10.5,
      thumbnail: 'https://pbs.twimg.com/x.jpg',
      formats: [
        { protocol: 'm3u8_native', ext: 'mp4', url: 'https://video.twimg.com/a.m3u8', vcodec: 'avc1' },
        { protocol: 'https', ext: 'mp4', url: 'https://video.twimg.com/v/vid/avc1/1280x720/a.mp4', tbr: 2000, width: 1280, height: 720, vcodec: 'avc1' },
        { protocol: 'https', ext: 'mp4', url: 'https://evil.com/a.mp4', width: 1920, height: 1080, vcodec: 'avc1' },
      ],
    },
    '9',
  );
  assert.equal(post.text, 'oi');
  assert.equal(post.media[0].durationMs, 10500);
  assert.deepEqual(post.media[0].variants.map((v) => v.label), ['720p']);
});

test('lista de hosts permitidos bloqueia endereços arbitrários', () => {
  assert.ok(parseAllowedUrl('https://video.twimg.com/a.mp4', VIDEO_HOSTS));
  assert.equal(parseAllowedUrl('http://video.twimg.com/a.mp4', VIDEO_HOSTS), null);
  assert.equal(parseAllowedUrl('https://video.twimg.com.evil.com/a.mp4', VIDEO_HOSTS), null);
  assert.equal(parseAllowedUrl('https://user@video.twimg.com/a.mp4', VIDEO_HOSTS), null);
  assert.equal(parseAllowedUrl('https://video.twimg.com:8443/a.mp4', VIDEO_HOSTS), null);
  assert.equal(parseAllowedUrl('https://169.254.169.254/', VIDEO_HOSTS), null);
});

test('rótulo de qualidade usa o lado menor (vídeo vertical)', () => {
  assert.equal(qualityLabel(720, 1280), '720p');
  assert.equal(qualityLabel(null, null), 'Original');
});

test('serviço: cai para o próximo extrator, cacheia e junta buscas simultâneas', async () => {
  let calls = 0;
  const failing = { name: 'a', extract: async () => { throw new AppError('UPSTREAM_ERROR'); } };
  const ok = {
    name: 'b',
    extract: async ({ id }) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return normalizeSyndication(VIDEO_TWEET, id);
    },
  };
  const store = new MemoryStore();
  const fetchImpl = async () => new Response(null, { headers: { 'content-length': '1000' } });
  const svc = createExtractorService({ extractors: [failing, ok], store, ttlMs: 60_000, fetchImpl });
  const target = { id: '1', canonical: 'https://x.com/i/status/1' };
  const [a, b] = await Promise.all([svc.extract(target), svc.extract(target)]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.media[0].variants[0].sizeBytes, 1000);
  await svc.extract(target);
  assert.equal(calls, 1, 'segunda busca vem do cache');
  await store.close();
});

test('serviço: conta privada não tenta outro extrator', async () => {
  let second = 0;
  const svc = createExtractorService({
    extractors: [
      { name: 'a', extract: async () => { throw new AppError('PRIVATE'); } },
      { name: 'b', extract: async () => { second += 1; } },
    ],
    store: new MemoryStore(),
    ttlMs: 1000,
    fetchImpl: fetch,
  });
  await assert.rejects(svc.extract({ id: '1' }), { code: 'PRIVATE' });
  assert.equal(second, 0);
});

test('tamanho estimado por bitrate quando o HEAD falha', async () => {
  const store = new MemoryStore();
  const svc = createExtractorService({
    extractors: [{ name: 'a', extract: async ({ id }) => normalizeSyndication(VIDEO_TWEET, id) }],
    store,
    ttlMs: 1000,
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const post = await svc.extract({ id: '7' });
  const v720 = post.media[0].variants.find((v) => v.label === '720p');
  assert.equal(v720.sizeEstimated, true);
  assert.equal(v720.sizeBytes, Math.round((2176000 * 42) / 8));
  await store.close();
});
