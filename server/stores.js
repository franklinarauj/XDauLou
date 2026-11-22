// Armazenamento temporário: cache de metadados e contadores de rate limit.
// Usa Redis quando REDIS_URL está definido; caso contrário, memória do processo.
// Nada aqui é persistido em disco, e as chaves são hashes (não guardamos links nem IPs em claro).

import { createHash, randomBytes } from 'node:crypto';

// Sal aleatório por processo: os hashes não podem ser revertidos nem comparados entre reinícios.
const SALT = randomBytes(16).toString('hex');

export const hashKey = (value) =>
  createHash('sha256').update(SALT).update(String(value)).digest('hex').slice(0, 32);

export class MemoryStore {
  constructor({ maxEntries = 1000 } = {}) {
    this.kind = 'memory';
    this.maxEntries = maxEntries;
    /** @type {Map<string, {value: any, expiresAt: number}>} */
    this.data = new Map();
    /** @type {Map<string, {count: number, resetAt: number}>} */
    this.counters = new Map();
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref();
  }

  async get(key) {
    const entry = this.data.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.data.delete(key);
      return undefined;
    }
    // Reinsere para manter a ordem de uso (LRU simples).
    this.data.delete(key);
    this.data.set(key, entry);
    return entry.value;
  }

  async set(key, value, ttlMs) {
    this.data.delete(key);
    this.data.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.data.size > this.maxEntries) {
      this.data.delete(this.data.keys().next().value);
    }
  }

  /** Incrementa um contador de janela fixa. Retorna {count, resetAt}. */
  async incr(key, windowMs) {
    const now = Date.now();
    let c = this.counters.get(key);
    if (!c || c.resetAt <= now) {
      c = { count: 0, resetAt: now + windowMs };
      this.counters.set(key, c);
    }
    c.count += 1;
    return { count: c.count, resetAt: c.resetAt };
  }

  sweep() {
    const now = Date.now();
    for (const [k, v] of this.data) if (v.expiresAt <= now) this.data.delete(k);
    for (const [k, v] of this.counters) if (v.resetAt <= now) this.counters.delete(k);
  }

  async close() {
    clearInterval(this.sweeper);
    this.data.clear();
    this.counters.clear();
  }
}

export class RedisStore {
  constructor(client) {
    this.kind = 'redis';
    this.client = client;
  }

  async get(key) {
    const raw = await this.client.get(`xdl:c:${key}`);
    return raw ? JSON.parse(raw) : undefined;
  }

  async set(key, value, ttlMs) {
    await this.client.set(`xdl:c:${key}`, JSON.stringify(value), 'PX', ttlMs);
  }

  async incr(key, windowMs) {
    const k = `xdl:r:${key}`;
    const [[, count], [, ttl]] = await this.client
      .multi()
      .incr(k)
      .pttl(k)
      .exec();
    let remaining = ttl;
    if (ttl < 0) {
      await this.client.pexpire(k, windowMs);
      remaining = windowMs;
    }
    return { count, resetAt: Date.now() + remaining };
  }

  async close() {
    await this.client.quit().catch(() => {});
  }
}

/** Cria o store adequado. Se o Redis falhar, cai para memória sem derrubar o app. */
export async function createStore(config) {
  if (config.redisUrl) {
    try {
      const { default: Redis } = await import('ioredis');
      const client = new Redis(config.redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        enableOfflineQueue: false,
      });
      await client.connect();
      return new RedisStore(client);
    } catch (err) {
      console.warn(`[xdaulou] Redis indisponível (${err.code ?? err.message}); usando memória.`);
    }
  }
  return new MemoryStore({ maxEntries: config.cacheMaxEntries });
}
