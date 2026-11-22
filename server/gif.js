// Conversão real de MP4 para .gif com ffmpeg (paleta otimizada em uma passada).
// Arquivos temporários ficam no diretório temporário do sistema e são apagados
// assim que a resposta termina.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { AppError } from './errors.js';
import { createJobLimiter, downloadToFile, makeTempDir, runFfmpeg, SAFE_INPUT } from './ffmpeg.js';
import { VIDEO_HOSTS } from './media.js';
import { attachment, safeFilename } from './proxy.js';

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

export function createGifService({ ffmpegPath, fetchImpl, timeoutMs, gif, limiter }) {
  const jobs = limiter ?? createJobLimiter(gif.maxConcurrent);
  const maxBytes = gif.maxInputMb * 1024 * 1024;
  const maxOutputBytes = gif.maxOutputMb * 1024 * 1024;

  async function convert({ src, preset, signal }) {
    const tmp = await makeTempDir();
    const input = tmp.file('in.mp4');
    const output = tmp.file('out.gif');
    try {
      await downloadToFile(src, input, { hosts: VIDEO_HOSTS, fetchImpl, signal, timeoutMs, maxBytes });
      await runFfmpeg(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          ...SAFE_INPUT,
          '-t', String(gif.maxDurationSeconds),
          '-i', input,
          '-an',
          '-filter_complex', gifFilter(preset),
          '-loop', '0',
          '-fs', String(maxOutputBytes),
          output,
        ],
        { timeoutMs: gif.timeoutMs, signal },
      );
      const { size } = await stat(output);
      // -fs corta o arquivo no limite; um GIF cortado não serve, então recusa.
      if (size >= maxOutputBytes * 0.98) throw new AppError('MEDIA_TOO_LARGE');
      return { tmp, output, size };
    } catch (err) {
      await tmp.cleanup();
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
        const release = jobs.tryAcquire();
        if (!release) throw new AppError('GIF_BUSY', { retryAfter: 5 });

        const preset = GIF_PRESETS[req.query.q] ?? GIF_PRESETS.sd;
        const abort = new AbortController();
        res.on('close', () => abort.abort());

        let result;
        try {
          result = await convert({ src: req.query.src, preset, signal: abort.signal });
        } finally {
          release();
        }

        res.on('close', result.tmp.cleanup);
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
          result.tmp.cleanup();
        }
      };
    },
  };
}
