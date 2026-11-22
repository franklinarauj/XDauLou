// Configuração via variáveis de ambiente (veja .env.example).

const int = (name, fallback) => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : fallback;
};

const trustProxy = () => {
  const v = process.env.TRUST_PROXY;
  if (v === undefined || v === '' || v === 'false') return false;
  // "true" confiaria em qualquer X-Forwarded-For (o cliente poderia forjar o IP e
  // escapar do rate limit). Tratamos como "um proxy na frente".
  if (v === 'true') return 1;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
};

export function loadConfig(overrides = {}) {
  return {
    port: int('PORT', 3000),
    host: process.env.HOST || '0.0.0.0',
    trustProxy: trustProxy(),
    redisUrl: process.env.REDIS_URL || '',
    cacheTtlSeconds: int('CACHE_TTL_SECONDS', 600),
    cacheMaxEntries: int('CACHE_MAX_ENTRIES', 1000),
    upstreamTimeoutMs: int('UPSTREAM_TIMEOUT_MS', 10_000),
    signingSecret: process.env.URL_SIGNING_SECRET || '',
    signedUrlTtlSeconds: int('SIGNED_URL_TTL_SECONDS', 7200),
    rateLimit: {
      windowSeconds: int('RATE_LIMIT_WINDOW_SECONDS', 60),
      extract: int('RATE_LIMIT_EXTRACT', 30),
      download: int('RATE_LIMIT_DOWNLOAD', 30),
      gif: int('RATE_LIMIT_GIF', 6),
      sticker: int('RATE_LIMIT_STICKER', 10),
    },
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ytdlpPath: process.env.YTDLP_PATH || '',
    // Conversões simultâneas (GIF + figurinha somados).
    maxConcurrentJobs: int('MAX_CONCURRENT_JOBS', int('GIF_MAX_CONCURRENT', 2)),
    sticker: {
      targetKb: Math.min(int('STICKER_TARGET_KB', 480), 500),
      gifMaxMb: int('STICKER_GIF_MAX_MB', 4),
      maxInputMb: int('STICKER_MAX_INPUT_MB', 80),
      maxUploadMb: int('STICKER_MAX_UPLOAD_MB', 15),
      timeoutMs: int('STICKER_TIMEOUT_MS', 60_000),
    },
    gif: {
      maxDurationSeconds: int('GIF_MAX_DURATION_SECONDS', 60),
      maxInputMb: int('GIF_MAX_INPUT_MB', 80),
      maxOutputMb: int('GIF_MAX_OUTPUT_MB', 40),
      maxConcurrent: int('GIF_MAX_CONCURRENT', 2),
      timeoutMs: int('GIF_TIMEOUT_MS', 120_000),
    },
    ...overrides,
  };
}
