// Localiza binários externos opcionais (ffmpeg e yt-dlp).

import { spawnSync } from 'node:child_process';

function works(bin, args) {
  try {
    const r = spawnSync(bin, args, { stdio: 'ignore', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** FFMPEG_PATH → pacote ffmpeg-static → ffmpeg do sistema. */
export async function findFfmpeg(configured) {
  if (configured) return works(configured, ['-version']) ? configured : null;
  try {
    const { default: staticPath } = await import('ffmpeg-static');
    if (staticPath && works(staticPath, ['-version'])) return staticPath;
  } catch {
    // pacote opcional ausente
  }
  return works('ffmpeg', ['-version']) ? 'ffmpeg' : null;
}

/** YTDLP_PATH → yt-dlp do sistema. */
export function findYtdlp(configured) {
  const bin = configured || 'yt-dlp';
  return works(bin, ['--version']) ? bin : null;
}
