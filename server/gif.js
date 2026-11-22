// Conversão real de MP4 para .gif com ffmpeg (paleta otimizada em uma passada).
// Arquivos temporários ficam no diretório temporário do sistema e são apagados
// assim que a resposta termina.

import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.js';
import { VIDEO_HOSTS } from './media.js';
import { attachment, fetchUpstream, safeFilename } from './proxy.js';

export const GIF_PRESETS = {
  sd: { width: 480, fps: 15 },
  hd: { width: 720, fps: 20 },
};

export function gifFilter({ width, fps }) {
  return (
    `fps=${fps},scale='min(${width},iw)':-1:flags=lanczos,split[a][b];` +
    '[a]palettegen=stats_mode=diff:max_colors=256[p];' +
    '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle'
  );
}

function runFfmpeg(bin, args, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('cancelado'));
      return;
    }
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // Se o usuário fechar a página, a conversão para e libera a vaga na hora.
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      if (stderr.length < 4000) stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg saiu com código ${code}: ${stderr.slice(-500)}`));
    });
  });
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

export function createGifService({ ffmpegPath, fetchImpl, timeoutMs, gif }) {
  let running = 0;
  const maxBytes = gif.maxInputMb * 1024 * 1024;
  const maxOutputBytes = gif.maxOutputMb * 1024 * 1024;

  async function convert({ src, preset, signal }) {
    const dir = await mkdtemp(join(tmpdir(), 'xdaulou-'));
    const input = join(dir, 'in.mp4');
    const output = join(dir, 'out.gif');
    try {
      const upstream = await fetchUpstream(src, { hosts: VIDEO_HOSTS, fetchImpl, signal, timeoutMs });
      const declared = Number(upstream.headers.get('content-length'));
      if (declared > maxBytes) throw new AppError('MEDIA_TOO_LARGE');
      await pipeline(Readable.fromWeb(upstream.body), byteLimit(maxBytes), createWriteStream(input));

      await runFfmpeg(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-t', String(gif.maxDurationSeconds),
          '-i', input,
          '-an',
          '-filter_complex', gifFilter(preset),
          '-loop', '0',
          '-fs', String(maxOutputBytes),
          output,
        ],
        gif.timeoutMs,
        signal,
      );
      const { size } = await stat(output);
      // -fs corta o arquivo no limite; um GIF cortado não serve, então recusa.
      if (size >= maxOutputBytes * 0.98) throw new AppError('MEDIA_TOO_LARGE');
      return { dir, output, size };
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (err instanceof AppError) throw err;
      throw new AppError('GIF_FAILED', { cause: err });
    }
  }

  return {
    available: Boolean(ffmpegPath),
    maxDurationSeconds: gif.maxDurationSeconds,

    handler() {
      return async (req, res) => {
        if (!ffmpegPath) throw new AppError('GIF_UNAVAILABLE');
        if (running >= gif.maxConcurrent) throw new AppError('GIF_BUSY', { retryAfter: 5 });

        const preset = GIF_PRESETS[req.query.q] ?? GIF_PRESETS.sd;
        const abort = new AbortController();
        res.on('close', () => abort.abort());

        running += 1;
        let result;
        try {
          result = await convert({ src: req.query.src, preset, signal: abort.signal });
        } finally {
          running -= 1;
        }

        const cleanup = () => rm(result.dir, { recursive: true, force: true }).catch(() => {});
        res.on('close', cleanup);
        res.status(200);
        res.setHeader('Content-Type', 'image/gif');
        res.setHeader('Content-Length', String(result.size));
        res.setHeader('Content-Disposition', attachment(safeFilename(req.query.name, 'gif')));
        res.setHeader('Cache-Control', 'no-store');
        try {
          await pipeline(createReadStream(result.output), res);
        } catch {
          if (!res.writableEnded) res.destroy();
        } finally {
          cleanup();
        }
      };
    },
  };
}
