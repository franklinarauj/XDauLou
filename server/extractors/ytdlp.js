// Extrator alternativo: usa o yt-dlp (se instalado) quando o endpoint principal falha.

import { execFile } from 'node:child_process';
import { AppError } from '../errors.js';
import { IMAGE_HOSTS, VIDEO_HOSTS, normalizeVariants, parseAllowedUrl } from '../media.js';

function run(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr ?? '');
        reject(err);
      } else resolve(stdout);
    });
  });
}

function errorFromStderr(stderr) {
  if (/protected|private/i.test(stderr)) return new AppError('PRIVATE');
  if (/sensitive|age|NSFW|log ?in/i.test(stderr)) return new AppError('SENSITIVE');
  if (/no video|no media|could not find/i.test(stderr)) return new AppError('NO_MEDIA');
  if (/not found|does not exist|404/i.test(stderr)) return new AppError('NOT_FOUND');
  if (/429|rate.?limit/i.test(stderr)) return new AppError('UPSTREAM_RATE_LIMITED');
  return new AppError('UPSTREAM_ERROR');
}

function entryToMedia(entry) {
  const formats = (entry.formats ?? []).filter(
    (f) =>
      /^https?$/.test(f.protocol ?? '') &&
      (f.ext === 'mp4' || /\.mp4(\?|$)/.test(f.url ?? '')) &&
      f.vcodec !== 'none' &&
      parseAllowedUrl(f.url, VIDEO_HOSTS),
  );
  if (!formats.length) return null;
  const variants = normalizeVariants(
    formats.map((f) => ({
      url: f.url,
      bitrate: f.tbr ? Math.round(f.tbr * 1000) : 0,
      width: f.width,
      height: f.height,
      sizeBytes: f.filesize ?? null,
    })),
  );
  if (!variants.length) return null;
  const isGif = variants.some((v) => v.url.includes('/tweet_video/'));
  return {
    type: isGif ? 'gif' : 'video',
    thumbnail: parseAllowedUrl(entry.thumbnail, IMAGE_HOSTS) ? entry.thumbnail : null,
    width: entry.width ?? variants[0].width,
    height: entry.height ?? variants[0].height,
    durationMs: entry.duration ? Math.round(entry.duration * 1000) : null,
    variants,
  };
}

export function normalizeYtdlp(info, id) {
  const entries = info?._type === 'playlist' ? info.entries ?? [] : [info];
  const media = entries.map(entryToMedia).filter(Boolean);
  if (!media.length) throw new AppError('NO_MEDIA');
  const first = entries[0] ?? {};
  return {
    id: String(id),
    author: {
      name: first.uploader ?? info.uploader ?? '',
      username: first.uploader_id ?? info.uploader_id ?? '',
      avatar: null,
    },
    text: (first.description ?? '').replace(/\s*https:\/\/t\.co\/\w+\s*$/u, '').trim(),
    createdAt: first.timestamp ? new Date(first.timestamp * 1000).toISOString() : null,
    fromQuote: false,
    media: media.map((m, index) => ({ index, ...m })),
    source: 'yt-dlp',
  };
}

export function createYtdlpExtractor({ bin, timeoutMs }) {
  return {
    name: 'yt-dlp',
    async extract({ id, canonical }) {
      let stdout;
      try {
        stdout = await run(
          bin,
          ['-J', '--no-warnings', '--skip-download', '--no-cache-dir', canonical],
          timeoutMs * 3,
        );
      } catch (err) {
        throw errorFromStderr(err.stderr ?? '');
      }
      return normalizeYtdlp(JSON.parse(stdout), id);
    },
  };
}
