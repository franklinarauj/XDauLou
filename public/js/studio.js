// Estúdio de figurinhas do WhatsApp: ocupa o card da direita no modo "Criar figurinha".
// A origem pode ser a mídia de um post do X ou um arquivo enviado pelo usuário.

import { $, apiError, escapeHtml, formatBytes, formatSeconds, saveBlob } from './util.js';

const MAX_SECONDS = 10;
const DEFAULT_SECONDS = 6;

const defaultOptions = () => ({ fit: 'contain', start: 0, duration: DEFAULT_SECONDS, removeBg: false, tolerance: 0.25 });

/** Menor variante que ainda cobre 512 px no lado menor (baixa menos e não perde nitidez). */
function variantForSticker(media) {
  const sorted = [...media.variants].sort((a, b) => (a.width ?? 0) * (a.height ?? 0) - (b.width ?? 0) * (b.height ?? 0));
  return sorted.find((v) => Math.min(v.width ?? 0, v.height ?? 0) >= 512) ?? sorted[sorted.length - 1];
}

const safeBase = (name) =>
  name
    .replace(/\.[^.]+$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || 'arquivo';

/** Origem a partir de um post do X já buscado. */
export function sourceFromPost(post, mediaIndex) {
  const media = post.media[mediaIndex];
  return {
    kind: 'x',
    post,
    mediaIndex,
    media,
    durationSec: media.durationMs ? media.durationMs / 1000 : null,
    filename: `XDauLou_${post.id}_figurinha.webp`,
  };
}

/** Origem a partir de um arquivo do usuário. Lê a duração se for vídeo. */
export async function sourceFromFile(file) {
  const previewUrl = URL.createObjectURL(file);
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(file.name);
  let durationSec = null;
  if (isVideo) {
    durationSec = await new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) && v.duration > 0 ? v.duration : null);
      v.onerror = () => resolve(null);
      v.src = previewUrl;
    });
  }
  return { kind: 'file', file, previewUrl, isVideo, durationSec, filename: `XDauLou_${safeBase(file.name)}_figurinha.webp` };
}

export function createStudio({ root, getFeatures }) {
  const st = { source: null, options: defaultOptions(), result: null, stale: false, busy: null, error: null };

  const total = () => st.source?.durationSec ?? null;
  const maxDuration = () => {
    const t = total();
    return t ? Math.max(0.5, Math.min(MAX_SECONDS, t - st.options.start)) : MAX_SECONDS;
  };

  function dropResult() {
    if (st.result) URL.revokeObjectURL(st.result.url);
    st.result = null;
    st.stale = false;
  }

  function setSource(source) {
    st.busy?.abort();
    st.busy = null;
    dropResult();
    st.source = source;
    st.error = null;
    st.options.start = 0;
    const t = total();
    st.options.duration = t ? Math.max(0.5, Math.min(DEFAULT_SECONDS, t)) : DEFAULT_SECONDS;
    render();
  }

  function clear() {
    st.busy?.abort();
    st.busy = null;
    dropResult();
    st.source = null;
    st.error = null;
  }

  // Renderização ------------------------------------------------------------

  function stageHtml() {
    const { source, result } = st;
    let inner = '';
    if (result) {
      inner = `<img src="${result.url}" alt="Prévia da figurinha">`;
    } else if (source.kind === 'x') {
      inner = source.media.thumbnail ? `<img src="${escapeHtml(source.media.thumbnail)}" alt="Mídia original">` : '';
    } else if (source.isVideo) {
      inner = `<video src="${source.previewUrl}" muted autoplay loop playsinline aria-label="Vídeo original"></video>`;
    } else {
      inner = `<img src="${source.previewUrl}" alt="GIF original">`;
    }
    return `<div class="sticker-stage" id="st-stage">
        ${inner}
        <span class="badge badge--stage">${result ? 'Figurinha' : 'Original'}</span>
      </div>`;
  }

  function sourceHtml() {
    const { source } = st;
    if (source.kind === 'x') {
      const a = source.post.author;
      return `<div class="byline">
          ${a.avatar ? `<img class="avatar" src="${escapeHtml(a.avatar)}" alt="">` : '<div class="avatar"></div>'}
          <div class="byline-text">
            <strong>${escapeHtml(a.name || a.username || 'Autor desconhecido')}</strong>
            ${a.username ? `<span>@${escapeHtml(a.username)}</span>` : ''}
          </div>
        </div>`;
    }
    return `<div class="file-line">
        <strong>${escapeHtml(source.file.name)}</strong>
        <span>Arquivo enviado, ${formatBytes(source.file.size) ?? '0 KB'}</span>
      </div>`;
  }

  function resultHtml() {
    const r = st.result;
    if (!r) {
      return '<p class="note" id="st-status">A figurinha sai em 512 × 512 px, com fundo transparente, até 10 s e menos de 500 KB.</p>';
    }
    const limit = r.animated ? 500 : 100;
    const ok = r.bytes <= limit * 1024;
    const detail = r.animated
      ? `Dentro do limite de 500 KB do WhatsApp. ${r.fps} fps, qualidade ${r.quality}.`
      : 'Figurinha estática (o conteúdo não se mexe), dentro do limite de 100 KB.';
    return `<p class="sticker-size ${ok ? 'is-ok' : 'is-bad'}">${formatBytes(r.bytes)}</p>
      <p class="note" id="st-status">${st.stale ? 'As opções mudaram. Gere de novo para atualizar.' : detail}</p>`;
  }

  function pickerHtml() {
    const { source } = st;
    if (source.kind !== 'x' || source.post.media.length < 2) return '';
    return `<div class="picker" role="group" aria-label="Escolha a mídia">
        ${source.post.media
          .map(
            (m, i) => `<button type="button" data-media="${i}" aria-pressed="${i === source.mediaIndex}" aria-label="Mídia ${i + 1}">
              ${m.thumbnail ? `<img src="${escapeHtml(m.thumbnail)}" alt="" loading="lazy">` : ''}<span>${i + 1}</span></button>`,
          )
          .join('')}
      </div>`;
  }

  function trimHtml() {
    const t = total();
    const o = st.options;
    const start = t && t > 1
      ? `<label class="range">
          <span class="range-head"><span>Começa em</span><output id="st-start-out">${formatSeconds(o.start)}</output></span>
          <input type="range" name="st-start" min="0" max="${Math.max(0, t - 0.5).toFixed(1)}" step="0.1" value="${o.start}">
        </label>`
      : '';
    return `<fieldset class="group">
        <legend>Trecho</legend>
        ${start}
        <label class="range">
          <span class="range-head"><span>Duração</span><output id="st-duration-out">${formatSeconds(o.duration)}</output></span>
          <input type="range" name="st-duration" min="0.5" max="${maxDuration().toFixed(1)}" step="0.5" value="${Math.min(o.duration, maxDuration())}">
        </label>
        <p class="note">O WhatsApp aceita até 10 s, e a animação termina parada no primeiro quadro: escolha um começo que funcione como imagem.</p>
      </fieldset>`;
  }

  function optionsHtml() {
    const o = st.options;
    return `<fieldset class="group">
        <legend>Enquadramento</legend>
        <div class="segmented">
          <label><input type="radio" name="st-fit" value="contain" ${o.fit === 'contain' ? 'checked' : ''}>Ajustar</label>
          <label><input type="radio" name="st-fit" value="cover" ${o.fit === 'cover' ? 'checked' : ''}>Preencher</label>
        </div>
        <p class="note" id="st-fit-note">${o.fit === 'contain' ? 'Mostra a imagem inteira; a sobra fica transparente.' : 'Ocupa o quadrado inteiro, cortando as bordas.'}</p>
      </fieldset>
      ${trimHtml()}
      <fieldset class="group">
        <legend>Fundo</legend>
        <label class="check">
          <input type="checkbox" name="st-removebg" ${o.removeBg ? 'checked' : ''}>
          <span>Remover fundo sólido</span>
        </label>
        <label class="range" id="st-tolerance-wrap" ${o.removeBg ? '' : 'hidden'}>
          <span class="range-head"><span>Tolerância</span><output id="st-tolerance-out">${Math.round(o.tolerance * 100)}%</output></span>
          <input type="range" name="st-tolerance" min="0.02" max="0.5" step="0.01" value="${o.tolerance}">
        </label>
        <p class="note">Usa a cor do canto da imagem. Funciona melhor com fundo de uma cor só.</p>
      </fieldset>`;
  }

  function render() {
    if (!st.source) return;
    root.setAttribute('aria-busy', 'false');
    root.innerHTML = `
      <article class="content studio">
        <div class="preview">
          ${stageHtml()}
          <div class="preview-info">
            ${sourceHtml()}
            <div id="st-result">${resultHtml()}</div>
          </div>
        </div>
        ${pickerHtml()}
        ${optionsHtml()}
        <p class="inline-error" id="st-error" role="alert" ${st.error ? '' : 'hidden'}>${escapeHtml(st.error ?? '')}</p>
        <button type="button" class="download" id="st-action"></button>
        <p class="note howto">No WhatsApp Web, abra uma conversa (pode ser com você mesmo), clique no clipe, escolha
          <strong>Figurinha</strong> e selecione o arquivo .webp. Depois, no celular, toque na figurinha e favorite.</p>
      </article>`;
    refresh();
  }

  /** Atualiza só o que muda com os controles (sem recriar os sliders no meio do arraste). */
  function refresh() {
    const btn = $('#st-action', root);
    if (!btn) return;
    const fresh = st.result && !st.stale;
    $('#st-stage', root)?.classList.toggle('is-stale', Boolean(st.result && st.stale));
    $('#st-stage', root)?.classList.toggle('is-busy', Boolean(st.busy));
    if (st.busy) {
      btn.textContent = 'Gerando figurinha…';
      btn.dataset.action = '';
      btn.setAttribute('aria-busy', 'true');
      btn.classList.add('is-indeterminate');
    } else {
      btn.removeAttribute('aria-busy');
      btn.classList.remove('is-indeterminate');
      btn.dataset.action = fresh ? 'st-download' : 'st-generate';
      btn.textContent = fresh ? `Baixar figurinha (${formatBytes(st.result.bytes)})` : st.result ? 'Gerar de novo' : 'Gerar figurinha';
    }
    const status = $('#st-status', root);
    if (status && st.result && st.stale) status.textContent = 'As opções mudaram. Gere de novo para atualizar.';
    const err = $('#st-error', root);
    if (err) {
      err.hidden = !st.error;
      err.textContent = st.error ?? '';
    }
  }

  // Ações ---------------------------------------------------------------------

  async function generate() {
    if (st.busy || !st.source) return;
    const { source, options: o } = st;
    const features = getFeatures();
    if (source.kind === 'file' && source.file.size > features.stickerMaxUploadMb * 1024 * 1024) {
      st.error = `O arquivo passa de ${features.stickerMaxUploadMb} MB. Use um arquivo menor.`;
      refresh();
      return;
    }

    const qs = new URLSearchParams({
      fit: o.fit,
      start: String(o.start),
      duration: String(Math.min(o.duration, maxDuration())),
      removeBg: o.removeBg ? '1' : '0',
      tolerance: String(o.tolerance),
      name: source.filename.replace(/\.webp$/, ''),
    });
    let init;
    if (source.kind === 'x') {
      const v = variantForSticker(source.media);
      init = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src: v.url, exp: v.exp, sig: v.sig }) };
    } else {
      init = { headers: { 'Content-Type': source.file.type || 'application/octet-stream' }, body: source.file };
    }

    const controller = new AbortController();
    st.busy = controller;
    st.error = null;
    refresh();
    try {
      const res = await fetch(`/api/sticker?${qs}`, { method: 'POST', signal: controller.signal, ...init });
      if (!res.ok) throw await apiError(res, 'Não foi possível criar a figurinha. Tente de novo.');
      const blob = await res.blob();
      if (st.source !== source) return; // a origem mudou no meio do caminho
      dropResult();
      st.result = {
        blob,
        url: URL.createObjectURL(blob),
        bytes: blob.size,
        fps: res.headers.get('X-Sticker-Fps'),
        quality: res.headers.get('X-Sticker-Quality'),
        animated: res.headers.get('X-Sticker-Animated') !== '0',
      };
      st.busy = null;
      render();
    } catch (err) {
      if (err.name === 'AbortError') return;
      st.error = err.code ? err.message : 'Não foi possível falar com o servidor. Verifique sua internet e tente de novo.';
    } finally {
      if (st.busy === controller) {
        st.busy = null;
        refresh();
      }
    }
  }

  function download() {
    if (!st.result) return;
    saveBlob(st.result.blob, st.source.filename);
    const status = $('#st-status', root);
    if (status) status.textContent = `Download concluído: ${st.source.filename}`;
  }

  function markStale() {
    if (st.result) st.stale = true;
    st.error = null;
    refresh();
  }

  // Eventos (delegados no card; só reagem aos controles do estúdio) -------------

  root.addEventListener('input', (e) => {
    const el = e.target;
    if (!el.name?.startsWith('st-') || !st.source) return;
    const o = st.options;
    if (el.name === 'st-start') {
      o.start = Number(el.value);
      $('#st-start-out', root).textContent = formatSeconds(o.start);
      const dur = root.querySelector('[name="st-duration"]');
      dur.max = maxDuration().toFixed(1);
      if (o.duration > maxDuration()) {
        o.duration = maxDuration();
        dur.value = String(o.duration);
        $('#st-duration-out', root).textContent = formatSeconds(o.duration);
      }
    } else if (el.name === 'st-duration') {
      o.duration = Number(el.value);
      $('#st-duration-out', root).textContent = formatSeconds(o.duration);
    } else if (el.name === 'st-tolerance') {
      o.tolerance = Number(el.value);
      $('#st-tolerance-out', root).textContent = `${Math.round(o.tolerance * 100)}%`;
    } else if (el.name === 'st-fit') {
      o.fit = el.value;
      $('#st-fit-note', root).textContent =
        o.fit === 'contain' ? 'Mostra a imagem inteira; a sobra fica transparente.' : 'Ocupa o quadrado inteiro, cortando as bordas.';
    } else if (el.name === 'st-removebg') {
      o.removeBg = el.checked;
      $('#st-tolerance-wrap', root).hidden = !o.removeBg;
    }
    markStale();
  });

  root.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action^="st-"]');
    if (!btn || !st.source) return;
    if (btn.dataset.action === 'st-generate') generate();
    if (btn.dataset.action === 'st-download') download();
  });

  return {
    setSource,
    clear,
    render,
    get source() {
      return st.source;
    },
  };
}
