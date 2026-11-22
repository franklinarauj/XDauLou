// Extrator principal: endpoint público de "syndication" do X, o mesmo usado pelos
// embeds de posts em sites. Não exige login nem chave de API.

import { AppError } from '../errors.js';
import { IMAGE_HOSTS, normalizeVariants, parseAllowedUrl } from '../media.js';

const ENDPOINT = 'https://cdn.syndication.twimg.com/tweet-result';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Token exigido pelo endpoint (mesma fórmula usada pelo widget oficial de embed). */
export function syndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

export async function fetchSyndication(id, { fetchImpl, timeoutMs }) {
  const url = `${ENDPOINT}?id=${encodeURIComponent(id)}&lang=pt&token=${syndicationToken(id)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', { cause });
  }
  if (res.status === 404) throw new AppError('NOT_FOUND');
  if (res.status === 429) throw new AppError('UPSTREAM_RATE_LIMITED');
  if (!res.ok) throw new AppError('UPSTREAM_ERROR');

  const body = await res.text();
  if (!body.trim()) throw new AppError('NOT_FOUND');
  try {
    return JSON.parse(body);
  } catch (cause) {
    throw new AppError('UPSTREAM_ERROR', { cause });
  }
}

function tombstoneError(data) {
  const text = data?.tombstone?.text?.text ?? '';
  if (/limits who can view|protected|protegid|privad/i.test(text)) return new AppError('PRIVATE');
  if (/age|adult|sensitive|sensível|idade/i.test(text)) return new AppError('SENSITIVE');
  if (/suspended|suspens/i.test(text)) return new AppError('UNAVAILABLE');
  return new AppError('UNAVAILABLE');
}

const safeImage = (url) => (parseAllowedUrl(url, IMAGE_HOSTS) ? url : null);

function mediaFromDetails(details = []) {
  const out = [];
  let photos = 0;
  for (const m of details) {
    if (m.type === 'photo') {
      photos += 1;
      continue;
    }
    if (m.type !== 'video' && m.type !== 'animated_gif') continue;
    const mp4 = (m.video_info?.variants ?? []).filter((v) => v.content_type === 'video/mp4');
    const variants = normalizeVariants(mp4, {
      fallbackWidth: m.original_info?.width,
      fallbackHeight: m.original_info?.height,
    });
    if (!variants.length) continue;
    out.push({
      type: m.type === 'animated_gif' ? 'gif' : 'video',
      thumbnail: safeImage(m.media_url_https),
      width: m.original_info?.width ?? variants[0].width,
      height: m.original_info?.height ?? variants[0].height,
      durationMs: m.video_info?.duration_millis ?? null,
      variants,
    });
  }
  return { media: out, photos };
}

/** Converte a resposta do X no formato interno do XDauLou. */
export function normalizeSyndication(data, id) {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    throw new AppError('NOT_FOUND');
  }
  if (data.__typename === 'TweetTombstone') throw tombstoneError(data);

  const tweet = data.__typename === 'TweetWithVisibilityResults' && data.tweet ? data.tweet : data;

  let { media, photos } = mediaFromDetails(tweet.mediaDetails);
  let fromQuote = false;
  // Se o post só cita outro post com vídeo, oferece a mídia do post citado.
  if (!media.length && tweet.quoted_tweet?.mediaDetails) {
    const quoted = mediaFromDetails(tweet.quoted_tweet.mediaDetails);
    if (quoted.media.length) {
      media = quoted.media;
      fromQuote = true;
    }
    photos += quoted.photos;
  }

  if (!media.length) throw new AppError(photos > 0 ? 'ONLY_PHOTOS' : 'NO_MEDIA');

  const user = tweet.user ?? {};
  return {
    id: tweet.id_str ?? String(id),
    author: {
      name: user.name ?? '',
      username: user.screen_name ?? '',
      avatar: safeImage(user.profile_image_url_https),
    },
    text: (tweet.text ?? '').replace(/\s*https:\/\/t\.co\/\w+\s*$/u, '').trim(),
    createdAt: tweet.created_at ?? null,
    fromQuote,
    media: media.map((m, index) => ({ index, ...m })),
    source: 'syndication',
  };
}

export function createSyndicationExtractor({ fetchImpl, timeoutMs }) {
  return {
    name: 'syndication',
    async extract({ id }) {
      const data = await fetchSyndication(id, { fetchImpl, timeoutMs });
      return normalizeSyndication(data, id);
    },
  };
}
