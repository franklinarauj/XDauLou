// Ponto de entrada: `npm start`.

import { createApp } from './app.js';
import { findFfmpeg, findYtdlp, hasEncoder } from './binaries.js';
import { loadConfig } from './config.js';
import { createExtractorService } from './extractors/index.js';
import { createSyndicationExtractor } from './extractors/syndication.js';
import { createYtdlpExtractor } from './extractors/ytdlp.js';
import { createJobLimiter } from './ffmpeg.js';
import { createGifService } from './gif.js';
import { createStickerService } from './sticker.js';
import { createStore } from './stores.js';

const config = loadConfig();
const fetchImpl = globalThis.fetch;

const store = await createStore(config);
let ffmpegPath = await findFfmpeg(config.ffmpegPath);
// Figurinhas precisam de libwebp. Se o ffmpeg do pacote não tiver e o do sistema
// (ex.: Homebrew) tiver, usa o do sistema.
if (!config.ffmpegPath && ffmpegPath && !hasEncoder(ffmpegPath, 'libwebp_anim') && hasEncoder('ffmpeg', 'libwebp_anim')) {
  ffmpegPath = 'ffmpeg';
}
const ytdlpPath = findYtdlp(config.ytdlpPath);

const extractors = [createSyndicationExtractor({ fetchImpl, timeoutMs: config.upstreamTimeoutMs })];
if (ytdlpPath) extractors.push(createYtdlpExtractor({ bin: ytdlpPath, timeoutMs: config.upstreamTimeoutMs }));

const extractorService = createExtractorService({
  extractors,
  store,
  ttlMs: config.cacheTtlSeconds * 1000,
  fetchImpl,
});

const limiter = createJobLimiter(config.maxConcurrentJobs);
const gifService = createGifService({
  ffmpegPath,
  fetchImpl,
  timeoutMs: config.upstreamTimeoutMs,
  gif: config.gif,
  limiter,
});
const stickerService = createStickerService({
  ffmpegPath,
  webpSupported: hasEncoder(ffmpegPath, 'libwebp_anim'),
  fetchImpl,
  timeoutMs: config.upstreamTimeoutMs,
  sticker: config.sticker,
  limiter,
});

const app = createApp({ config, store, extractorService, gifService, stickerService, fetchImpl });

const server = app.listen(config.port, config.host, () => {
  const where = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`XDauLou rodando em http://${where}:${config.port}`);
  console.log(
    `  cache: ${store.kind} | extratores: ${extractorService.names.join(', ')} | GIF: ${
      ffmpegPath ? 'ativado' : 'desativado (instale o ffmpeg)'
    } | figurinhas: ${stickerService.available ? 'ativadas' : 'desativadas (ffmpeg sem libwebp)'}`,
  );
});

function shutdown() {
  server.close(() => {
    store.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
