// Rate limiting por IP (janela fixa). O IP é guardado apenas como hash e só
// durante a janela de contagem.

import { isIPv6 } from 'node:net';
import { AppError } from './errors.js';
import { hashKey } from './stores.js';

/**
 * Chave do cliente para o rate limit. IPv6 é agrupado por /64, porque um único
 * usuário costuma controlar a faixa inteira e poderia trocar de IP a cada pedido.
 */
export function clientBucket(raw = '') {
  const ip = String(raw).split('%')[0];
  if (ip.toLowerCase().startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  if (!isIPv6(ip)) return ip;
  let groups;
  if (ip.includes('::')) {
    const [head, tail] = ip.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  } else {
    groups = ip.split(':');
  }
  return `${groups
    .slice(0, 4)
    .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export function rateLimit({ store, name, max, windowSeconds }) {
  const windowMs = windowSeconds * 1000;
  return async function rateLimitMiddleware(req, res, next) {
    if (max <= 0) return next();
    const key = `${name}:${hashKey(clientBucket(req.ip ?? 'unknown'))}`;
    let result;
    try {
      result = await store.incr(key, windowMs);
    } catch {
      // Se o store falhar, não bloqueia o usuário.
      return next();
    }
    const resetSeconds = Math.max(0, Math.ceil((result.resetAt - Date.now()) / 1000));
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - result.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    if (result.count > max) {
      return next(new AppError('RATE_LIMITED', { retryAfter: resetSeconds }));
    }
    return next();
  };
}
