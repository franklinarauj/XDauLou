// Modo demonstração: sobe o app com um "X falso", para ver a interface funcionando
// sem internet. Links de exemplo aparecem no terminal.

import { createApp } from '../server/app.js';
import { findFfmpeg, hasEncoder } from '../server/binaries.js';
import { loadConfig } from '../server/config.js';
import { createExtractorService } from '../server/extractors/index.js';
import { createSyndicationExtractor } from '../server/extractors/syndication.js';
import { createJobLimiter } from '../server/ffmpeg.js';
import { createGifService } from '../server/gif.js';
import { createStickerService } from '../server/sticker.js';
import { MemoryStore } from '../server/stores.js';
import { createFakeX, IDS, makeSampleMedia } from '../test/fake-x.js';

const config = loadConfig();
const ffmpegPath = await findFfmpeg(config.ffmpegPath);
const fake = createFakeX({ sample: ffmpegPath ? makeSampleMedia(ffmpegPath) : null, delayMs: 400 });
const store = new MemoryStore();
const limiter = createJobLimiter(config.maxConcurrentJobs);

const app = createApp({
  config,
  store,
  extractorService: createExtractorService({
    extractors: [createSyndicationExtractor({ fetchImpl: fake.fetchImpl, timeoutMs: 5000 })],
    store,
    ttlMs: 60_000,
    fetchImpl: fake.fetchImpl,
  }),
  gifService: createGifService({ ffmpegPath, fetchImpl: fake.fetchImpl, timeoutMs: 5000, gif: config.gif, limiter }),
  stickerService: createStickerService({
    ffmpegPath,
    webpSupported: hasEncoder(ffmpegPath, 'libwebp_anim'),
    fetchImpl: fake.fetchImpl,
    timeoutMs: 5000,
    sticker: config.sticker,
    limiter,
  }),
  fetchImpl: fake.fetchImpl,
});

app.listen(config.port, config.host, () => {
  console.log(`XDauLou (demonstração, X simulado) em http://localhost:${config.port}\n`);
  console.log('Cole um destes links:');
  for (const [name, id] of Object.entries(IDS)) console.log(`  ${name.padEnd(8)} https://x.com/fulano/status/${id}`);
});
