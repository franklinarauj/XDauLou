// Assina os endereços de mídia devolvidos por /api/extract. O proxy só aceita
// links assinados e dentro do prazo, então ninguém consegue usar o servidor como
// proxy genérico do X nem embutir links de download dele em outros sites.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function createSigner({ secret, ttlSeconds }) {
  // Sem segredo configurado, gera um por processo (links valem até reiniciar).
  const key = secret || randomBytes(32).toString('hex');
  const mac = (src, exp) => createHmac('sha256', key).update(`${src}\n${exp}`).digest('base64url').slice(0, 32);

  return {
    sign(src) {
      const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
      return { exp, sig: mac(src, exp) };
    },

    /** Caminho pronto para o navegador, ex.: /api/thumb?src=...&exp=...&sig=... */
    path(route, src) {
      const { exp, sig } = this.sign(src);
      return `${route}?src=${encodeURIComponent(src)}&exp=${exp}&sig=${sig}`;
    },

    /** @returns {'ok' | 'expired' | 'invalid'} */
    verify(src, exp, sig) {
      if (typeof src !== 'string' || typeof sig !== 'string' || typeof exp !== 'string' || !/^\d{1,12}$/.test(exp)) {
        return 'invalid';
      }
      const expected = Buffer.from(mac(src, exp));
      const given = Buffer.from(sig);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return 'invalid';
      if (Number(exp) < Math.floor(Date.now() / 1000)) return 'expired';
      return 'ok';
    },
  };
}
