// Parser de links de posts do X. Compartilhado entre navegador e servidor
// (o servidor importa este mesmo arquivo), para que a validação seja idêntica.

const HOSTS = new Set([
  'x.com',
  'twitter.com',
  'mobile.x.com',
  'mobile.twitter.com',
  'fxtwitter.com',
  'vxtwitter.com',
  'fixupx.com',
  'fixvx.com',
]);

// Procura um link dentro de qualquer texto colado ("olha isso https://x.com/...").
// O lookbehind impede casar "x.com" no meio de outro domínio (ex.: "notx.com").
const URL_IN_TEXT =
  /(?<![\w.-])(?:https?:\/\/)?(?:[\w-]+\.)*(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com\/[^\s<>"'`]+/i;

const USERNAME = /^[A-Za-z0-9_]{1,15}$/;
const TWEET_ID = /^\d{1,20}$/;

/**
 * @param {string} input texto livre que contém um link de post
 * @returns {{id: string, username: string|null, mediaIndex: number|null, canonical: string} | null}
 */
export function parseTweetUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 4096) return null;

  const match = text.match(URL_IN_TEXT);
  if (!match) return null;

  let raw = match[0].replace(/[).,;:!?\]]+$/, '');
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!HOSTS.has(host)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  const idx = parts.findIndex((p) => p === 'status' || p === 'statuses');
  if (idx < 0) return null;

  // Formatos aceitos: /usuario/status/ID, /i/status/ID, /i/web/status/ID
  const isUserPath = idx === 1;
  const isWebPath = idx === 2 && parts[0] === 'i' && parts[1] === 'web';
  if (!isUserPath && !isWebPath) return null;

  const id = parts[idx + 1];
  if (!id || !TWEET_ID.test(id)) return null;

  let username = null;
  if (isUserPath && parts[0] !== 'i' && USERNAME.test(parts[0])) username = parts[0];
  if (isUserPath && parts[0] !== 'i' && !USERNAME.test(parts[0])) return null;

  // /video/2 ou /photo/2 indicam qual mídia do post o usuário abriu.
  let mediaIndex = null;
  const kind = parts[idx + 2];
  const n = parts[idx + 3];
  if ((kind === 'video' || kind === 'photo') && /^[1-9]$/.test(n ?? '')) {
    mediaIndex = Number(n) - 1;
  }

  return {
    id,
    username,
    mediaIndex,
    canonical: `https://x.com/${username ?? 'i'}/status/${id}`,
  };
}
