// Ponto de entrada: `npm start`.

import { createApp } from './app.js';
import { findFfmpeg, findYtdlp } from './binaries.js';
import { loadConfig } from './config.js';
import { createExtractorService } from './extractors/index.js';
import { createSyndicationExtractor } from './extractors/syndication.js';
import { createYtdlpExtractor } from './extractors/ytdlp.js';
import { createGifService } from './gif.js';
import { createStore } from './stores.js';

const config = loadConfig();
const fetchImpl = globalThis.fetch;

const store = await createStore(config);
const ffmpegPath = await findFfmpeg(config.ffmpegPath);
const ytdlpPath = findYtdlp(config.ytdlpPath);

const extractors = [createSyndicationExtractor({ fetchImpl, timeoutMs: config.upstreamTimeoutMs })];
if (ytdlpPath) extractors.push(createYtdlpExtractor({ bin: ytdlpPath, timeoutMs: config.upstreamTimeoutMs }));

const extractorService = createExtractorService({
  extractors,
  store,
  ttlMs: config.cacheTtlSeconds * 1000,
  fetchImpl,
});

const gifService = createGifService({
  ffmpegPath,
  fetchImpl,
  timeoutMs: config.upstreamTimeoutMs,
  gif: config.gif,
});

const app = createApp({ config, store, extractorService, gifService, fetchImpl });

const server = app.listen(config.port, config.host, () => {
  const where = config.host === '0.0.0.0' ? 'localhost' : config.host;
  console.log(`XDauLou rodando em http://${where}:${config.port}`);
  console.log(
    `  cache: ${store.kind} · extratores: ${extractorService.names.join(', ')} · GIF: ${
      ffmpegPath ? 'ativado' : 'desativado (instale o ffmpeg)'
    }`,
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
