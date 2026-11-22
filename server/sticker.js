// Figurinha animada do WhatsApp: WebP animado 512×512, fundo transparente (nunca
// branco), até 10 s, loop infinito e menos de 500 KB. Aceita a mídia de um post
// do X (link assinado) ou um arquivo enviado pelo usuário.

import { readFile, stat, writeFile } from 'node:fs/promises';
import { AppError } from './errors.js';
import { createJobLimiter, downloadToFile, makeTempDir, runFfmpeg, SAFE_INPUT } from './ffmpeg.js';
import { VIDEO_HOSTS } from './media.js';
import { attachment, safeFilename } from './proxy.js';

export const CANVAS = 512;
export const WHATSAPP_MAX_BYTES = 500 * 1024;
// Se todos os quadros forem iguais, o WebP sai com um quadro só e o WhatsApp o
// trata como figurinha estática, cujo limite é 100 KB.
export const STATIC_MAX_BYTES = 95 * 1024;
export const MAX_DURATION = 10;

// Degraus de compressão, do melhor para o mais econômico. A qualidade é ajustada
// dentro de cada degrau; se nem a qualidade mínima couber, desce um degrau.
export const LEVELS = [
  { fps: 15, inner: 512 },
  { fps: 12, inner: 512 },
  { fps: 10, inner: 512 },
  { fps: 10, inner: 448 },
  { fps: 8, inner: 400 },
];
// GIF para o "Criar figurinha" do WhatsApp no celular: é o único caminho que
// mantém a figurinha animada (no WhatsApp Web/Desktop ela sempre fica parada).
export const GIF_LEVELS = [
  { fps: 15, inner: 512 },
  { fps: 12, inner: 512 },
  { fps: 10, inner: 448 },
  { fps: 10, inner: 384 },
  { fps: 8, inner: 320 },
];
const Q_MAX = 80;
const Q_MIN = 30;
// No teste com vídeo detalhado, q=30 rendeu ~62% do tamanho de q=80.
const Q_MIN_RATIO = 0.62;

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Lê e limita as opções vindas da query string. */
export function parseOptions(q = {}) {
  return {
    start: clamp(num(q.start, 0), 0, 3600),
    duration: clamp(num(q.duration, 6), 0.5, MAX_DURATION),
    fit: q.fit === 'cover' ? 'cover' : 'contain',
    removeBg: q.removeBg === '1' || q.removeBg === 'true',
    tolerance: clamp(num(q.tolerance, 0.25), 0.01, 0.6),
    format: q.format === 'gif' ? 'gif' : 'webp',
  };
}

/** Identifica o formato pelo conteúdo (não confia na extensão nem no Content-Type). */
export function detectFormat(buf) {
  if (!buf || buf.length < 12) return null;
  const ascii = (a, b) => buf.subarray(a, b).toString('latin1');
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'gif';
  if (ascii(4, 8) === 'ftyp') return 'mov'; // MP4, MOV, M4V
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'matroska'; // WebM
  return null;
}

export function stickerFilter({ fps, inner, fit, key, tolerance, canvas }) {
  const chain = [`fps=${fps}`, 'format=rgba'];
  if (key) chain.push(`colorkey=0x${key}:${tolerance}:0.08`);
  if (fit === 'cover') {
    chain.push(`scale=${inner}:${inner}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${inner}:${inner}`);
  } else {
    chain.push(`scale=${inner}:${inner}:force_original_aspect_ratio=decrease:flags=lanczos`);
  }
  // Sobra preenchida com transparência total: nada de borda branca.
  const size = canvas ?? CANVAS;
  chain.push(`pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`);
  return chain.join(',');
}

/** Mesmo enquadramento da figurinha, mas em GIF com paleta otimizada e transparência. */
export function stickerGifFilter(opts) {
  return (
    `${stickerFilter({ ...opts, canvas: opts.inner })},split[a][b];` +
    '[a]palettegen=reserve_transparent=1:stats_mode=diff:max_colors=255[p];' +
    '[b][p]paletteuse=alpha_threshold=128:dither=bayer:bayer_scale=4:diff_mode=rectangle'
  );
}

/** Argumentos de entrada: GIF não tem busca rápida, então o corte vai depois do -i. */
function inputArgs(input, format, { start, duration }) {
  const window = ['-ss', String(start), '-t', String(duration)];
  return format === 'gif'
    ? [...SAFE_INPUT, '-f', 'gif', '-i', input, ...window]
    : [...SAFE_INPUT, ...window, '-f', format, '-i', input];
}

/**
 * Procura o melhor resultado que caiba em `target` bytes, com poucas tentativas.
 * `attempt(level, q)` gera um arquivo e devolve seu tamanho.
 */
export async function compressToFit(attempt, target) {
  const tries = [];
  const run = async (level, q) => {
    const size = await attempt(level, q, tries.length);
    const t = { ...level, q, size, index: tries.length };
    tries.push(t);
    return t;
  };

  const first = await run(LEVELS[0], Q_MAX);
  if (first.size <= target) return { best: first, tries };

  for (let i = 0; i < LEVELS.length; i++) {
    const level = LEVELS[i];
    const last = i === LEVELS.length - 1;
    // Tamanho previsto neste degrau em q=80, proporcional a fps e área.
    const p80 = first.size * (level.fps / LEVELS[0].fps) * (level.inner / LEVELS[0].inner) ** 2;
    if (!last && p80 * Q_MIN_RATIO > target * 1.08) continue; // nem em q=30 deve caber

    const estimate = Q_MIN + ((Q_MAX - Q_MIN) * (target * 0.95 - p80 * Q_MIN_RATIO)) / (p80 * (1 - Q_MIN_RATIO));
    const q = Math.round(clamp(estimate, Q_MIN, i === 0 ? Q_MAX - 5 : Q_MAX));
    let t = await run(level, q);
    if (t.size <= target) {
      // Sobrou bastante espaço: tenta uma qualidade maior uma vez.
      if (t.size < target * 0.78 && q <= Q_MAX - 10) {
        const up = await run(level, Math.round((q + Q_MAX) / 2));
        if (up.size <= target) return { best: up, tries };
      }
      return { best: t, tries };
    }
    if (q > Q_MIN) {
      t = await run(level, Q_MIN);
      if (t.size <= target) return { best: t, tries };
    }
  }
  throw new AppError('STICKER_TOO_LARGE');
}

/** Conta os quadros de um WebP (chunks ANMF). Sem ANMF, é uma imagem estática. */
export function countWebpFrames(buf) {
  let frames = 0;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.subarray(p, p + 4).toString('latin1');
    const size = buf.readUInt32LE(p + 4);
    if (id === 'ANMF') frames += 1;
    p += 8 + size + (size % 2);
  }
  return frames;
}

/** Cor do canto superior esquerdo no início do trecho (usada para remover fundo sólido). */
async function cornerColor(bin, input, format, options, signal) {
  const raw = await runFfmpeg(
    bin,
    [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...inputArgs(input, format, options),
      '-frames:v', '1',
      '-vf', 'crop=6:6:0:0,scale=1:1:flags=area,format=rgb24',
      '-f', 'rawvideo', 'pipe:1',
    ],
    { timeoutMs: 20_000, signal },
  );
  if (raw.length < 3) return null;
  return raw.subarray(0, 3).toString('hex');
}

export function createStickerService({ ffmpegPath, webpSupported, fetchImpl, timeoutMs, sticker, limiter }) {
  const jobs = limiter ?? createJobLimiter(2);
  const available = Boolean(ffmpegPath && webpSupported);
  const target = sticker.targetKb * 1024;

  /** GIF: desce degraus (fps e tamanho) até caber em gifMaxMb. */
  async function encodeGif({ input, format, options, signal, key, tmp }) {
    const limit = sticker.gifMaxMb * 1024 * 1024;
    let last;
    for (const [n, level] of GIF_LEVELS.entries()) {
      const out = tmp.file(`out-${n}.gif`);
      await runFfmpeg(
        ffmpegPath,
        [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          ...inputArgs(input, format, options),
          '-an',
          '-filter_complex', stickerGifFilter({ ...level, fit: options.fit, key, tolerance: options.tolerance }),
          '-loop', '0',
          '-fs', String(limit * 3),
          out,
        ],
        { timeoutMs: sticker.timeoutMs, signal },
      );
      const size = (await stat(out)).size;
      last = { out, size, best: { ...level, q: null }, attempts: n + 1 };
      if (size <= limit) break;
    }
    if (last.size > limit) throw new AppError('STICKER_TOO_LARGE');
    return { buffer: await readFile(last.out), best: last.best, attempts: last.attempts, animated: true };
  }

  async function encode({ input, format, options, signal }) {
    const tmp = await makeTempDir();
    try {
      const key = options.removeBg ? await cornerColor(ffmpegPath, input, format, options, signal) : null;
      if (options.format === 'gif') return await encodeGif({ input, format, options, signal, key, tmp });
      const outputs = [];
      const attempt = async (level, q) => {
        const out = tmp.file(`out-${outputs.length}.webp`);
        outputs.push(out);
        await runFfmpeg(
          ffmpegPath,
          [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            ...inputArgs(input, format, options),
            '-an',
            '-vf', stickerFilter({ ...level, fit: options.fit, key, tolerance: options.tolerance }),
            '-c:v', 'libwebp_anim',
            '-q:v', String(q),
            '-compression_level', '4',
            '-loop', '0',
            '-fs', String(4 * 1024 * 1024),
            out,
          ],
          { timeoutMs: sticker.timeoutMs, signal },
        );
        return (await stat(out)).size;
      };

      let { best, tries } = await compressToFit(attempt, target);
      let buffer = await readFile(outputs[outputs.length - tries.length + best.index]);
      let attempts = tries.length;
      if (countWebpFrames(buffer) <= 1 && buffer.length > STATIC_MAX_BYTES) {
        ({ best, tries } = await compressToFit(attempt, STATIC_MAX_BYTES));
        buffer = await readFile(outputs[outputs.length - tries.length + best.index]);
        attempts += tries.length;
      }
      return { buffer, best, attempts, animated: countWebpFrames(buffer) > 1 };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('STICKER_FAILED', { cause: err });
    } finally {
      await tmp.cleanup();
    }
  }

  return {
    available,

    /**
     * @param {{verify: (src: unknown, exp: unknown, sig: unknown) => 'ok'|'expired'|'invalid'}} deps
     */
    handler({ verify }) {
      return async (req, res) => {
        if (!available) throw new AppError('STICKER_UNAVAILABLE');
        const options = parseOptions(req.query);
        const abort = new AbortController();
        res.on('close', () => abort.abort());

        const release = jobs.tryAcquire();
        if (!release) throw new AppError('GIF_BUSY', { retryAfter: 5 });

        const tmp = await makeTempDir();
        let result;
        try {
          let input;
          let format;
          if (Buffer.isBuffer(req.body)) {
            // Arquivo enviado pelo usuário.
            format = detectFormat(req.body);
            if (!format) throw new AppError('UPLOAD_INVALID');
            input = tmp.file('upload');
            await writeFile(input, req.body);
          } else {
            // Mídia de um post do X, com o link assinado devolvido por /api/extract.
            const { src, exp, sig } = req.body ?? {};
            const check = verify(src, exp === undefined ? undefined : String(exp), sig);
            if (check === 'expired') throw new AppError('LINK_EXPIRED');
            if (check !== 'ok') throw new AppError('MEDIA_NOT_ALLOWED');
            input = tmp.file('source');
            await downloadToFile(src, input, {
              hosts: VIDEO_HOSTS,
              fetchImpl,
              signal: abort.signal,
              timeoutMs,
              maxBytes: sticker.maxInputMb * 1024 * 1024,
            });
            format = 'mov';
          }
          result = await encode({ input, format, options, signal: abort.signal });
        } finally {
          release();
          await tmp.cleanup();
        }

        res.status(200);
        const ext = options.format === 'gif' ? 'gif' : 'webp';
        res.setHeader('Content-Type', `image/${ext}`);
        res.setHeader('Content-Length', String(result.buffer.length));
        res.setHeader('Content-Disposition', attachment(safeFilename(req.query.name, ext)));
        res.setHeader('X-Sticker-Format', ext);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Sticker-Fps', String(result.best.fps));
        res.setHeader('X-Sticker-Quality', String(result.best.q ?? ''));
        res.setHeader('X-Sticker-Inner', String(result.best.inner));
        res.setHeader('X-Sticker-Attempts', String(result.attempts));
        res.setHeader('X-Sticker-Animated', result.animated ? '1' : '0');
        res.end(result.buffer);
      };
    },
  };
}
