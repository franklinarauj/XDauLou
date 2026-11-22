// Infraestrutura compartilhada pelas conversões (GIF e figurinha): execução do
// ffmpeg com timeout e cancelamento, fila de trabalhos e download para arquivo
// temporário com limite de tamanho.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.js';
import { fetchUpstream } from './proxy.js';

// Só arquivos locais: impede que um arquivo de entrada faça o ffmpeg abrir
// outros protocolos (http, concat, playlists etc.).
export const SAFE_INPUT = ['-protocol_whitelist', 'file'];

/**
 * Roda o ffmpeg. Encerra o processo ao estourar o tempo ou se `signal` abortar.
 * @returns {Promise<Buffer>} stdout (útil para extrair dados brutos)
 */
export function runFfmpeg(bin, args, { timeoutMs, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelado'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let stderr = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d;
    });
    const kill = () => child.kill('SIGKILL');
    const timer = setTimeout(kill, timeoutMs ?? 60_000);
    signal?.addEventListener('abort', kill, { once: true });
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', kill);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code) => {
      done();
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-500)}`));
    });
  });
}

/** Limita quantas conversões rodam ao mesmo tempo (GIF e figurinha somados). */
export function createJobLimiter(max) {
  let running = 0;
  return {
    get running() {
      return running;
    },
    /** @returns {(() => void) | null} função para liberar a vaga, ou null se estiver cheio */
    tryAcquire() {
      if (running >= max) return null;
      running += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          running -= 1;
        }
      };
    },
  };
}

export async function makeTempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'xdaulou-'));
  return {
    dir,
    file: (name) => join(dir, name),
    cleanup: () => rm(dir, { recursive: true, force: true }).catch(() => {}),
  };
}

function byteLimit(max) {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > max) cb(new AppError('MEDIA_TOO_LARGE'));
      else cb(null, chunk);
    },
  });
}

/** Baixa uma mídia permitida do X para um arquivo local, respeitando `maxBytes`. */
export async function downloadToFile(src, dest, { hosts, fetchImpl, signal, timeoutMs, maxBytes }) {
  const upstream = await fetchUpstream(src, { hosts, fetchImpl, signal, timeoutMs });
  const declared = Number(upstream.headers.get('content-length'));
  if (declared > maxBytes) {
    await upstream.body?.cancel().catch(() => {});
    throw new AppError('MEDIA_TOO_LARGE');
  }
  await pipeline(Readable.fromWeb(upstream.body), byteLimit(maxBytes), createWriteStream(dest));
}
