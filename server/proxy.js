// Proxy de stream: o servidor busca a mídia no X e repassa ao navegador com
// Content-Disposition: attachment, para o arquivo ser salvo direto (sem abrir player
// nem nova aba) e sem esbarrar em CORS.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.js';
import { IMAGE_HOSTS, VIDEO_HOSTS, parseAllowedUrl } from './media.js';

const UA = 'Mozilla/5.0 (compatible; XDauLou/1.0)';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function safeFilename(name, ext) {
  let base = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.(mp4|gif)$/i, '')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 100);
  if (!base) base = 'XDauLou';
  return `${base}.${ext}`;
}

export const attachment = (filename) => `attachment; filename="${filename}"`;

/** Busca uma mídia permitida no X. Lança AppError em qualquer falha. */
export async function fetchUpstream(src, { hosts, fetchImpl, signal, timeoutMs }) {
  const url = parseAllowedUrl(src, hosts);
  if (!url) throw new AppError('MEDIA_NOT_ALLOWED');
  // O timeout vale só até a resposta começar; o corpo (download longo) não é cortado.
  const headersTimeout = new AbortController();
  const timer = setTimeout(() => headersTimeout.abort(), timeoutMs);
  const signals = [headersTimeout.signal];
  if (signal) signals.push(signal);
  let res;
  let current = url;
  try {
    // Redirecionamentos são seguidos manualmente: cada destino é validado ANTES
    // de o servidor fazer a requisição.
    for (let hop = 0; ; hop += 1) {
      res = await fetchImpl(current.href, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.any(signals),
        redirect: 'manual',
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!location) break;
      await res.body?.cancel().catch(() => {});
      const next = parseAllowedUrl(new URL(location, current).href, hosts);
      if (!next || hop >= 3) throw new AppError('MEDIA_NOT_ALLOWED');
      current = next;
    }
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError('UPSTREAM_ERROR', { cause });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 || res.status === 410) throw new AppError('NOT_FOUND');
  if (res.status === 429) throw new AppError('UPSTREAM_RATE_LIMITED');
  if (!res.ok || !res.body) throw new AppError('UPSTREAM_ERROR');
  return res;
}

async function streamTo(res, upstream, abort) {
  try {
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch {
    // Conexão interrompida pelo usuário ou pelo X: só encerra.
    abort.abort();
    if (!res.writableEnded) res.destroy();
  }
}

export function downloadHandler({ fetchImpl, timeoutMs }) {
  return async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await fetchUpstream(req.query.src, {
      hosts: VIDEO_HOSTS,
      fetchImpl,
      signal: abort.signal,
      timeoutMs,
    });

    const filename = safeFilename(req.query.name, 'mp4');
    res.status(200);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', attachment(filename));
    res.setHeader('Cache-Control', 'no-store');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    await streamTo(res, upstream, abort);
  };
}

export function thumbHandler({ fetchImpl, timeoutMs }) {
  return async (req, res) => {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const upstream = await fetchUpstream(req.query.src, {
      hosts: IMAGE_HOSTS,
      fetchImpl,
      signal: abort.signal,
      timeoutMs,
    });
    // Só formatos raster: um SVG servido pela nossa origem poderia carregar script.
    const type = (upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) {
      await upstream.body?.cancel().catch(() => {});
      throw new AppError('MEDIA_NOT_ALLOWED');
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    const len = upstream.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);
    await streamTo(res, upstream, abort);
  };
}
