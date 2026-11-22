// Utilitários de mídia: lista de hosts permitidos, normalização de variantes e
// estimativa de tamanho.

export const VIDEO_HOSTS = new Set(['video.twimg.com']);
export const IMAGE_HOSTS = new Set(['pbs.twimg.com', 'abs.twimg.com']);

/**
 * Aceita apenas https em hosts específicos do X. Impede que o proxy seja usado
 * para buscar endereços arbitrários (SSRF / proxy aberto).
 */
export function parseAllowedUrl(value, hosts) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (!hosts.has(url.hostname.toLowerCase())) return null;
  return url;
}

const RES_IN_URL = /\/(\d{2,5})x(\d{2,5})\//;

/** Extrai largura x altura do caminho (ex.: /vid/avc1/1280x720/...). */
export function resolutionFromUrl(url) {
  const m = RES_IN_URL.exec(url);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
}

/** Rótulo "720p" usa o lado menor, como fazem os players (vale para vídeos verticais). */
export function qualityLabel(width, height) {
  if (!width || !height) return 'Original';
  return `${Math.min(width, height)}p`;
}

export function estimateBytes(bitrate, durationMs) {
  if (!bitrate || !durationMs) return null;
  return Math.round((bitrate * (durationMs / 1000)) / 8);
}

/**
 * Normaliza e ordena variantes MP4: maior resolução primeiro, sem rótulos repetidos.
 * @param {{url: string, bitrate?: number, width?: number, height?: number, sizeBytes?: number|null}[]} list
 */
export function normalizeVariants(list, { fallbackWidth, fallbackHeight } = {}) {
  const variants = list
    .filter((v) => parseAllowedUrl(v.url, VIDEO_HOSTS))
    .map((v) => {
      const res = v.width && v.height ? { width: v.width, height: v.height } : resolutionFromUrl(v.url);
      const width = res?.width ?? fallbackWidth ?? null;
      const height = res?.height ?? fallbackHeight ?? null;
      return {
        url: v.url,
        bitrate: v.bitrate ?? 0,
        width,
        height,
        label: qualityLabel(width, height),
        sizeBytes: v.sizeBytes ?? null,
        sizeEstimated: false,
      };
    })
    .sort((a, b) => (b.height ?? 0) * (b.width ?? 0) - (a.height ?? 0) * (a.width ?? 0) || b.bitrate - a.bitrate);

  const seen = new Set();
  return variants.filter((v) => {
    if (seen.has(v.label)) return false;
    seen.add(v.label);
    return true;
  });
}

/**
 * Preenche sizeBytes de cada variante: tenta Content-Length via HEAD e, se não
 * houver, estima por bitrate × duração.
 */
export async function enrichSizes(post, { fetchImpl, timeoutMs = 3500 }) {
  const jobs = [];
  for (const media of post.media) {
    for (const v of media.variants) {
      if (v.sizeBytes) continue;
      jobs.push(
        fetchImpl(v.url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
          .then((res) => {
            const len = Number(res.headers.get('content-length'));
            if (res.ok && len > 0) v.sizeBytes = len;
          })
          .catch(() => {})
          .finally(() => {
            if (!v.sizeBytes) {
              const est = estimateBytes(v.bitrate, media.durationMs);
              if (est) {
                v.sizeBytes = est;
                v.sizeEstimated = true;
              }
            }
          }),
      );
    }
  }
  await Promise.all(jobs);
  return post;
}
