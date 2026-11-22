// Encadeia extratores: tenta o principal e, se falhar por motivo recuperável,
// tenta o próximo. Também cacheia o resultado e junta buscas simultâneas do mesmo post.

import { AppError } from '../errors.js';
import { enrichSizes } from '../media.js';
import { hashKey } from '../stores.js';

// Erros definitivos: não adianta tentar outro extrator.
const FINAL = new Set(['PRIVATE', 'ONLY_PHOTOS']);

export function createExtractorService({ extractors, store, ttlMs, fetchImpl }) {
  const inflight = new Map();

  async function runChain(target) {
    let firstError;
    for (const ex of extractors) {
      try {
        return await ex.extract(target);
      } catch (err) {
        const appErr = err instanceof AppError ? err : new AppError('UPSTREAM_ERROR', { cause: err });
        firstError ??= appErr;
        if (FINAL.has(appErr.code)) throw appErr;
      }
    }
    throw firstError ?? new AppError('UPSTREAM_ERROR');
  }

  async function load(target) {
    const key = `meta:${hashKey(target.id)}`;
    const cached = await store.get(key).catch(() => undefined);
    if (cached) return cached;

    const post = await runChain(target);
    await enrichSizes(post, { fetchImpl });
    await store.set(key, post, ttlMs).catch(() => {});
    return post;
  }

  return {
    names: extractors.map((e) => e.name),
    /** @param {{id: string, canonical: string}} target */
    async extract(target) {
      if (inflight.has(target.id)) return inflight.get(target.id);
      const p = load(target).finally(() => inflight.delete(target.id));
      inflight.set(target.id, p);
      return p;
    },
  };
}
