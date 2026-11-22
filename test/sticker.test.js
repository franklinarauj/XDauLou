import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { findFfmpeg, hasEncoder } from '../server/binaries.js';
import { loadConfig } from '../server/config.js';
import { AppError } from '../server/errors.js';
import { createExtractorService } from '../server/extractors/index.js';
import { createSyndicationExtractor } from '../server/extractors/syndication.js';
import { createJobLimiter } from '../server/ffmpeg.js';
import { createGifService } from '../server/gif.js';
import { compressToFit, detectFormat, LEVELS, parseOptions, stickerFilter } from '../server/sticker.js';
import { MemoryStore } from '../server/stores.js';
import { createFakeX, IDS, makeSampleMedia } from './fake-x.js';

const ffmpegPath = await findFfmpeg(process.env.FFMPEG_PATH);
const canEncode = hasEncoder(ffmpegPath, 'libwebp_anim');
const skip = !canEncode && 'ffmpeg sem libwebp_anim';

/** Lê a estrutura de um WebP (RIFF): tamanho da tela, animação, loop, quadros e alfa. */
function inspectWebp(buf) {
  assert.equal(buf.subarray(0, 4).toString('latin1'), 'RIFF');
  assert.equal(buf.subarray(8, 12).toString('latin1'), 'WEBP');
  const info = { frames: 0, durationMs: 0, minFrameMs: Infinity, alphaFrames: 0 };
  const walk = (start, end, inFrame) => {
    let p = start;
    while (p + 8 <= end) {
      const id = buf.subarray(p, p + 4).toString('latin1');
      const size = buf.readUInt32LE(p + 4);
      const body = p + 8;
      if (id === 'VP8X') {
        info.alphaFlag = Boolean(buf[body] & 0x10);
        info.animFlag = Boolean(buf[body] & 0x02);
        info.width = buf.readUIntLE(body + 4, 3) + 1;
        info.height = buf.readUIntLE(body + 7, 3) + 1;
      } else if (id === 'ANIM') {
        info.loop = buf.readUInt16LE(body + 4);
      } else if (id === 'ANMF') {
        const ms = buf.readUIntLE(body + 12, 3);
        info.frames += 1;
        info.durationMs += ms;
        info.minFrameMs = Math.min(info.minFrameMs, ms);
        walk(body + 16, body + size, true);
      } else if (id === 'ALPH' && inFrame) {
        info.alphaFrames += 1;
      }
      p = body + size + (size % 2);
    }
  };
  walk(12, buf.length, false);
  return info;
}

/** Renderiza o 1º quadro do filtro em RGBA bruto, para conferir a transparência das bordas. */
function firstFrameRgba(input, filter) {
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-i', input, '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(r.status, 0, String(r.stderr));
  return r.stdout;
}
const pixel = (rgba, x, y) => [...rgba.subarray((y * 512 + x) * 4, (y * 512 + x) * 4 + 4)];

function makeClip(name, args) {
  const dir = mkdtempSync(join(tmpdir(), 'xdaulou-st-'));
  const out = join(dir, name);
  const r = spawnSync(ffmpegPath, ['-v', 'error', '-y', ...args, out]);
  assert.equal(r.status, 0, String(r.stderr));
  return out;
}

let server;
let base;
let store;
let clips;

before(async () => {
  if (!canEncode) return;
  clips = {
    // GIF largo (letterbox) com fundo sólido verde: testa transparência e remoção de fundo.
    gif: makeClip('wide.gif', [
      '-f', 'lavfi', '-i',
      'color=c=0x00ff00:s=480x200:r=10:d=2[bg];color=c=red:s=80x80:r=10:d=2[box];[bg][box]overlay=x=200+40*sin(t*3):y=60[out0]',
      '-loop', '0',
    ]),
    // GIF parado: todos os quadros iguais viram uma figurinha estática (limite de 100 KB).
    still: makeClip('still.gif', ['-f', 'lavfi', '-i', 'testsrc2=size=480x480:rate=10', '-vf', 'trim=end_frame=1,loop=19:1:0', '-loop', '0']),
    // Vídeo detalhado e longo (12 s): força a compressão a trabalhar e o corte em 10 s.
    heavy: makeClip('heavy.mp4', ['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '12', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast']),
  };
  const fake = createFakeX({ sample: makeSampleMedia(ffmpegPath) });
  const config = loadConfig({ rateLimit: { windowSeconds: 60, extract: 1000, download: 1000, gif: 1000, sticker: 1000 } });
  config.sticker = { ...config.sticker, maxUploadMb: 3 };
  store = new MemoryStore();
  const limiter = createJobLimiter(4);
  const app = createApp({
    config,
    store,
    extractorService: createExtractorService({
      extractors: [createSyndicationExtractor({ fetchImpl: fake.fetchImpl, timeoutMs: 2000 })],
      store,
      ttlMs: 60_000,
      fetchImpl: fake.fetchImpl,
    }),
    gifService: createGifService({ ffmpegPath, fetchImpl: fake.fetchImpl, timeoutMs: 2000, gif: config.gif, limiter }),
    stickerService: (await import('../server/sticker.js')).createStickerService({
      ffmpegPath,
      webpSupported: canEncode,
      fetchImpl: fake.fetchImpl,
      timeoutMs: 5000,
      sticker: config.sticker,
      limiter,
    }),
    fetchImpl: fake.fetchImpl,
  });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await store?.close();
});

const upload = (file, query = '', type = 'image/gif') =>
  fetch(`${base}/api/sticker?${query}`, { method: 'POST', headers: { 'Content-Type': type }, body: readFileSync(file) });

test('opções são limitadas aos valores permitidos', () => {
  const o = parseOptions({ start: '-5', duration: '99', fit: 'x', removeBg: '1', tolerance: '9' });
  assert.deepEqual(o, { start: 0, duration: 10, fit: 'contain', removeBg: true, tolerance: 0.6 });
  assert.equal(parseOptions({ fit: 'cover' }).fit, 'cover');
});

test('formato detectado pelo conteúdo, não pela extensão', () => {
  assert.equal(detectFormat(Buffer.from('GIF89a........')), 'gif');
  assert.equal(detectFormat(Buffer.from('\0\0\0\x18ftypmp42....', 'latin1')), 'mov');
  assert.equal(detectFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), 'matroska');
  assert.equal(detectFormat(Buffer.from('<svg onload=alert(1)>')), null);
  assert.equal(detectFormat(Buffer.from('#EXTM3U\nhttp://x')), null);
});

test('compressão: desce degraus até caber e para quando cabe', async () => {
  // Tamanho simulado: proporcional a fps, área e qualidade.
  const fake = (base) => async (level, q) =>
    Math.round(base * (level.fps / 15) * (level.inner / 512) ** 2 * (0.62 + (0.38 * (q - 30)) / 50));
  const easy = await compressToFit(fake(300_000), 480 * 1024);
  assert.equal(easy.tries.length, 1);
  assert.equal(easy.best.q, 80);

  const medium = await compressToFit(fake(1_000_000), 480 * 1024);
  assert.ok(medium.best.size <= 480 * 1024);
  assert.ok(medium.tries.length <= 4, `tentativas: ${medium.tries.length}`);

  const hard = await compressToFit(fake(2_400_000), 480 * 1024);
  assert.ok(hard.best.size <= 480 * 1024);
  assert.ok(hard.best.fps < 15 || hard.best.inner < 512);

  await assert.rejects(compressToFit(fake(50_000_000), 480 * 1024), (e) => e instanceof AppError && e.code === 'STICKER_TOO_LARGE');
  assert.equal(LEVELS[0].inner, 512);
});

test('filtro: sobra transparente (sem borda branca) e conteúdo centralizado', { skip }, () => {
  const rgba = firstFrameRgba(clips.gif, stickerFilter({ fps: 10, inner: 512, fit: 'contain' }));
  assert.equal(rgba.length, 512 * 512 * 4);
  assert.deepEqual(pixel(rgba, 0, 0), [0, 0, 0, 0], 'canto transparente');
  assert.deepEqual(pixel(rgba, 256, 30), [0, 0, 0, 0], 'faixa de cima transparente');
  assert.equal(pixel(rgba, 256, 256)[3], 255, 'centro opaco');
  assert.equal(pixel(rgba, 5, 256)[3], 255, 'conteúdo vai até a borda lateral');
});

test('filtro: remover fundo sólido deixa o fundo transparente e mantém o objeto', { skip }, () => {
  const rgba = firstFrameRgba(clips.gif, stickerFilter({ fps: 10, inner: 512, fit: 'cover', key: '00ff00', tolerance: 0.15 }));
  assert.equal(pixel(rgba, 20, 256)[3], 0, 'fundo verde removido');
  const center = pixel(rgba, 256, 256);
  assert.equal(center[3], 255, 'quadrado vermelho mantido');
  assert.ok(center[0] > 200 && center[1] < 60);
});

test('GIF enviado vira figurinha válida para o WhatsApp', { skip }, async () => {
  const res = await upload(clips.gif, 'name=minha%20figurinha');
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('content-type'), 'image/webp');
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="minha_figurinha.webp"');
  const buf = Buffer.from(await res.arrayBuffer());
  const info = inspectWebp(buf);
  assert.equal(info.width, 512);
  assert.equal(info.height, 512);
  assert.ok(info.animFlag && info.frames > 1, 'animada');
  assert.equal(info.loop, 0, 'loop infinito');
  assert.ok(info.alphaFlag && info.alphaFrames > 0, 'com canal alfa');
  assert.ok(buf.length < 500 * 1024);
});

test('GIF parado vira figurinha estática abaixo de 100 KB', { skip, timeout: 60_000 }, async () => {
  const res = await upload(clips.still);
  assert.equal(res.status, 200, await res.clone().text());
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('x-sticker-animated'), '0');
  assert.ok(buf.length <= 100 * 1024, `tamanho ${buf.length}`);
});

test('vídeo pesado e longo: comprime abaixo de 500 KB e corta em até 10 s', { skip, timeout: 120_000 }, async () => {
  const res = await upload(clips.heavy, 'duration=10', 'video/mp4');
  assert.equal(res.status, 200, await res.clone().text());
  const buf = Buffer.from(await res.arrayBuffer());
  const info = inspectWebp(buf);
  assert.ok(buf.length <= 480 * 1024, `tamanho ${buf.length}`);
  assert.ok(info.durationMs <= 10_050, `duração ${info.durationMs} ms`);
  assert.ok(info.minFrameMs >= 8, 'quadros com pelo menos 8 ms');
  assert.ok(Number(res.headers.get('x-sticker-attempts')) <= 6);
});

test('figurinha a partir da mídia de um post do X (link assinado)', { skip }, async () => {
  const { post } = await (
    await fetch(`${base}/api/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `https://x.com/a/status/${IDS.gif}` }),
    })
  ).json();
  const v = post.media[0].variants[0];
  const ok = await fetch(`${base}/api/sticker?fit=cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src: v.url, exp: v.exp, sig: v.sig }),
  });
  assert.equal(ok.status, 200, await ok.clone().text());
  assert.equal(inspectWebp(Buffer.from(await ok.arrayBuffer())).width, 512);

  const forged = await fetch(`${base}/api/sticker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ src: 'https://video.twimg.com/outro.mp4', exp: v.exp, sig: v.sig }),
  });
  assert.equal(forged.status, 400);
  assert.equal((await forged.json()).error.code, 'MEDIA_NOT_ALLOWED');
});

test('envio inválido: tipo falso, grande demais ou vazio', { skip }, async () => {
  const fakeGif = await fetch(`${base}/api/sticker`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/gif' },
    body: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  });
  assert.equal(fakeGif.status, 415);
  assert.equal((await fakeGif.json()).error.code, 'UPLOAD_INVALID');

  const big = await fetch(`${base}/api/sticker`, {
    method: 'POST',
    headers: { 'Content-Type': 'video/mp4' },
    body: Buffer.alloc(4 * 1024 * 1024, 1),
  });
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.code, 'UPLOAD_TOO_LARGE');

  const empty = await fetch(`${base}/api/sticker`, { method: 'POST' });
  assert.equal(empty.status, 415);
});

test('health informa se figurinhas estão disponíveis', { skip }, async () => {
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.sticker, true);
});
