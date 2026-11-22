// "X falso": um fetch simulado que responde como os servidores do X.
// Usado nos testes e no modo demonstração (npm run demo), que funciona sem internet.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIF_TWEET, PHOTO_TWEET, PRIVATE_TOMBSTONE, QUOTE_TWEET, VIDEO_TWEET } from './fixtures.js';

export const IDS = {
  video: '1790000000000000001',
  gif: '1790000000000000002',
  private: '1790000000000000003',
  missing: '1790000000000000004',
  photos: '1790000000000000005',
  quote: '1790000000000000006',
  multi: '1790000000000000007',
};

const MULTI_TWEET = {
  ...VIDEO_TWEET,
  id_str: IDS.multi,
  text: 'Dois ângulos do mesmo lance',
  mediaDetails: [VIDEO_TWEET.mediaDetails[0], { ...VIDEO_TWEET.mediaDetails[0], original_info: { width: 720, height: 1280 } }],
};

const TWEETS = {
  [IDS.video]: VIDEO_TWEET,
  [IDS.gif]: GIF_TWEET,
  [IDS.private]: PRIVATE_TOMBSTONE,
  [IDS.photos]: PHOTO_TWEET,
  [IDS.quote]: QUOTE_TWEET,
  [IDS.multi]: MULTI_TWEET,
};

/** Gera um MP4 e um JPG de verdade com ffmpeg (se houver), para testar conversão e preview. */
export function makeSampleMedia(ffmpeg = 'ffmpeg') {
  const dir = mkdtempSync(join(tmpdir(), 'xdaulou-sample-'));
  const mp4 = join(dir, 'sample.mp4');
  const jpg = join(dir, 'thumb.jpg');
  const r1 = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
    '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', mp4,
  ]);
  const r2 = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'gradients=size=1280x720:seed=7:speed=0.0001', '-frames:v', '1', jpg,
  ]);
  if (r1.status !== 0) return null;
  return {
    mp4: readFileSync(mp4),
    jpg: r2.status === 0 ? readFileSync(jpg) : null,
  };
}

export function createFakeX({ sample = null, delayMs = 0 } = {}) {
  const calls = { syndication: 0, head: 0, video: 0, image: 0 };
  const sleep = () => (delayMs ? new Promise((r) => setTimeout(r, delayMs)) : null);

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    await sleep();

    if (url.hostname === 'cdn.syndication.twimg.com') {
      calls.syndication += 1;
      const tweet = TWEETS[url.searchParams.get('id')];
      if (!tweet) return new Response('', { status: 404 });
      return Response.json(tweet);
    }

    if (url.hostname === 'video.twimg.com') {
      const body = sample?.mp4 ?? Buffer.alloc(2048, 1);
      // Tamanho "anunciado" proporcional à resolução, para a interface ficar realista.
      const m = /\/(\d+)x(\d+)\//.exec(url.pathname);
      const fakeLen = m ? Math.round(Number(m[1]) * Number(m[2]) * 6.2) : body.length;
      if (method === 'HEAD') {
        calls.head += 1;
        return new Response(null, { headers: { 'content-length': String(fakeLen), 'content-type': 'video/mp4' } });
      }
      calls.video += 1;
      return new Response(body, { headers: { 'content-length': String(body.length), 'content-type': 'video/mp4' } });
    }

    if (url.hostname === 'pbs.twimg.com') {
      calls.image += 1;
      const body = sample?.jpg ?? Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
      return new Response(body, { headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length) } });
    }

    throw new TypeError(`fetch failed: host não simulado ${url.hostname}`);
  }

  return { fetchImpl, calls };
}
