// Monta a aplicação Express. Dependências externas são injetáveis para testes.

import { fileURLToPath } from 'node:url';
import express from 'express';
import { parseTweetUrl } from '../public/js/tweet-url.js';
import { AppError } from './errors.js';
import { downloadHandler, thumbHandler } from './proxy.js';
import { rateLimit } from './rate-limit.js';
import { createSigner } from './signer.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self'",
  "script-src 'self'",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

function securityHeaders(_req, res, next) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'clipboard-read=(self), camera=(), microphone=(), geolocation=()');
  next();
}

/**
 * @param {{
 *   config: ReturnType<import('./config.js').loadConfig>,
 *   store: import('./stores.js').MemoryStore,
 *   extractorService: ReturnType<import('./extractors/index.js').createExtractorService>,
 *   gifService: ReturnType<import('./gif.js').createGifService>,
 *   stickerService: ReturnType<import('./sticker.js').createStickerService>,
 *   fetchImpl: typeof fetch,
 * }} deps
 */
export function createApp({ config, store, extractorService, gifService, stickerService, fetchImpl }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);

  const signer = createSigner({ secret: config.signingSecret, ttlSeconds: config.signedUrlTtlSeconds });
  const requireSignature = (req, _res, next) => {
    const result = signer.verify(req.query.src, req.query.exp, req.query.sig);
    if (result === 'expired') throw new AppError('LINK_EXPIRED');
    if (result !== 'ok') throw new AppError('MEDIA_NOT_ALLOWED');
    next();
  };
  const signedImage = (src) => (src ? signer.path('/api/thumb', src) : null);

  const { windowSeconds } = config.rateLimit;
  const limit = (name) => rateLimit({ store, name, max: config.rateLimit[name], windowSeconds });

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      cache: store.kind,
      extractors: extractorService.names,
      gif: gifService.available,
      sticker: stickerService.available,
      stickerMaxUploadMb: config.sticker.maxUploadMb,
    });
  });

  // POST para que o link pesquisado não apareça em URLs, históricos ou logs de proxies.
  app.post('/api/extract', limit('extract'), express.json({ limit: '8kb' }), async (req, res) => {
    const target = parseTweetUrl(req.body?.url);
    if (!target) throw new AppError('INVALID_URL');

    const post = await extractorService.extract(target);
    const maxMs = gifService.maxDurationSeconds * 1000;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      post: {
        ...post,
        author: { ...post.author, avatar: signedImage(post.author.avatar) },
        media: post.media.map((m) => ({
          ...m,
          thumbnail: signedImage(m.thumbnail),
          variants: m.variants.map((v) => ({ ...v, ...signer.sign(v.url) })),
          canGif: gifService.available && (m.type === 'gif' || (m.durationMs ?? Infinity) <= maxMs),
        })),
      },
      selectedIndex:
        target.mediaIndex !== null && target.mediaIndex < post.media.length ? target.mediaIndex : 0,
      gif: { available: gifService.available, maxDurationSeconds: gifService.maxDurationSeconds },
      sticker: { available: stickerService.available },
    });
  });

  app.get('/api/download', limit('download'), requireSignature, downloadHandler({ fetchImpl, timeoutMs: config.upstreamTimeoutMs }));
  app.get('/api/gif', limit('gif'), requireSignature, gifService.handler());
  // Figurinha: JSON com o link assinado de um post do X, ou o arquivo enviado no corpo.
  app.post(
    '/api/sticker',
    limit('sticker'),
    express.json({ limit: '4kb' }),
    express.raw({ type: (req) => !req.is('application/json'), limit: `${config.sticker.maxUploadMb}mb` }),
    stickerService.handler({ verify: (src, exp, sig) => signer.verify(src, exp, sig) }),
  );

  app.get('/api/thumb', requireSignature, thumbHandler({ fetchImpl, timeoutMs: config.upstreamTimeoutMs }));

  app.use('/api', () => {
    throw new AppError('NOT_FOUND_ROUTE');
  });

  app.use(
    express.static(PUBLIC_DIR, {
      index: 'index.html',
      setHeaders(res, path) {
        if (path.includes('/fonts/')) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        else res.setHeader('Cache-Control', 'public, max-age=300');
      },
    }),
  );

  // Tratamento de erros: responde JSON amigável. Não registra URLs, IPs nem parâmetros.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let appErr = err;
    if (!(err instanceof AppError)) {
      if (err?.type === 'entity.too.large' && req.path === '/api/sticker') {
        appErr = new AppError('UPLOAD_TOO_LARGE');
      } else if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
        appErr = new AppError('INVALID_URL');
      } else {
        console.error('[xdaulou] erro interno:', err?.name ?? 'Error', err?.message ?? '');
        appErr = new AppError('INTERNAL');
      }
    } else if (['INTERNAL', 'GIF_FAILED', 'STICKER_FAILED'].includes(appErr.code)) {
      console.error(`[xdaulou] ${appErr.code}:`, appErr.cause?.message?.split('\n')[0] ?? '');
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    if (appErr.retryAfter) res.setHeader('Retry-After', String(appErr.retryAfter));
    res.setHeader('Cache-Control', 'no-store');
    res.status(appErr.status).json(appErr.toJSON());
  });

  return app;
}
