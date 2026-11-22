// Utilidades compartilhadas pela página.

export const $ = (sel, root = document) => root.querySelector(sel);

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const oneDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

export function formatBytes(bytes) {
  if (!bytes) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${oneDecimal.format(bytes / (1024 * 1024))} MB`;
}

export const formatSeconds = (s) => `${oneDecimal.format(s)} s`;

export function formatDuration(ms) {
  if (!ms) return null;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Salva um Blob como arquivo, sem abrir nova aba. */
export function saveBlob(blob, filename) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

/** Lê a resposta de erro padrão da API ({ error: { code, message } }). */
export async function apiError(res, fallback) {
  const data = await res.json().catch(() => ({}));
  return Object.assign(new Error(data.error?.message ?? fallback), { code: data.error?.code ?? 'INTERNAL' });
}
