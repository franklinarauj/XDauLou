import { createStudio, sourceFromFile, sourceFromPost } from './studio.js';
import { parseTweetUrl } from './tweet-url.js';
import { $, apiError, escapeHtml, formatBytes, formatDuration, saveBlob } from './util.js';

const form = $('#search');
const input = $('#url');
const pasteBtn = $('#paste');
const clearBtn = $('#clear');
const hint = $('#hint');
const result = $('#result');
const modeSwitch = $('#mode');
const lede = $('#lede');
const dropzone = $('#dropzone');
const fileInput = $('#file');
const dropLabel = $('#drop-label');

const DEFAULT_HINT = hint.textContent;
const LEDE = {
  download: 'Cole o link de um post do X e baixe o vídeo ou o GIF.',
  sticker: 'Transforme um vídeo ou GIF do X, ou um arquivo seu, em figurinha animada do WhatsApp.',
};
const NATIVE_DOWNLOAD_ABOVE = 250 * 1024 * 1024; // acima disso, deixa o navegador baixar sozinho
const RETRYABLE = new Set(['UPSTREAM_ERROR', 'UPSTREAM_RATE_LIMITED', 'RATE_LIMITED', 'INTERNAL', 'NETWORK', 'GIF_BUSY']);

const TITLES = {
  INVALID_URL: 'Link não reconhecido',
  NOT_FOUND: 'Post não encontrado',
  PRIVATE: 'Conta privada',
  SENSITIVE: 'Post restrito',
  UNAVAILABLE: 'Post indisponível',
  NO_MEDIA: 'Sem vídeo neste post',
  ONLY_PHOTOS: 'Só há imagens neste post',
  RATE_LIMITED: 'Calma, muitas tentativas',
  UPSTREAM_RATE_LIMITED: 'O X está limitando consultas',
  UPSTREAM_ERROR: 'O X não respondeu',
  NETWORK: 'Sem conexão',
};

const state = {
  mode: 'download',
  features: { sticker: false, stickerMaxUploadMb: 15 },
  post: null,
  file: null, // origem "arquivo" do modo figurinha
  stickerFrom: null, // 'x' | 'file': a última origem escolhida
  error: null, // último erro de busca, para redesenhar ao trocar de modo
  gif: { available: false, maxDurationSeconds: 60 },
  mediaIndex: 0,
  format: 'mp4',
  variantIndex: 0,
  gifPreset: 'sd',
  lastId: null,
  request: null,
  download: null,
};

const studio = createStudio({ root: result, getFeatures: () => state.features });

// Utilidades ------------------------------------------------------------

// Miniaturas já vêm do servidor como caminhos assinados (/api/thumb?src=...&sig=...).
const thumbUrl = (signedPath) => escapeHtml(signedPath);
const signedQuery = (v) => `src=${encodeURIComponent(v.url)}&exp=${v.exp}&sig=${encodeURIComponent(v.sig)}`;

function setHint(text, isError = false) {
  hint.textContent = text;
  hint.classList.toggle('is-error', isError);
}

function updateClear() {
  clearBtn.hidden = input.value.length === 0;
}

// Modo (baixar mídia / criar figurinha) ---------------------------------------

function setMode(mode) {
  state.mode = mode === 'sticker' && state.features.sticker ? 'sticker' : 'download';
  for (const el of modeSwitch.querySelectorAll('input')) el.checked = el.value === state.mode;
  lede.textContent = LEDE[state.mode];
  dropzone.hidden = state.mode !== 'sticker';
  renderPanel();
}

/** Redesenha o card da direita conforme o modo e a origem atual. */
function renderPanel() {
  if (state.request) return; // o esqueleto continua até a busca terminar
  if (state.error && !(state.mode === 'sticker' && state.stickerFrom === 'file')) {
    renderError(state.error.code, state.error.message);
    return;
  }
  if (state.mode === 'download') {
    if (state.post) renderPost();
    else renderEmpty();
    return;
  }
  const source =
    state.stickerFrom === 'file' && state.file
      ? state.file
      : state.post
        ? sourceFromPost(state.post, state.mediaIndex)
        : state.file;
  if (!source) {
    studio.clear();
    renderStickerEmpty();
  } else if (studio.source && sameSource(studio.source, source)) {
    studio.render();
  } else {
    studio.setSource(source);
  }
}

const sameSource = (a, b) =>
  a.kind === b.kind && (a.kind === 'file' ? a.file === b.file : a.post === b.post && a.mediaIndex === b.mediaIndex);

// Busca -------------------------------------------------------------------

async function search(raw, { force = false } = {}) {
  const target = parseTweetUrl(raw);
  if (!target) {
    if (raw.trim()) setHint('Esse link não é de um post do X. Ele deve ter o formato x.com/usuario/status/…', true);
    return;
  }
  if (!force && target.id === state.lastId) return;

  state.request?.abort();
  const controller = new AbortController();
  state.request = controller;
  state.lastId = target.id;
  state.stickerFrom = 'x';
  state.error = null;
  setHint(DEFAULT_HINT);
  renderSkeleton();

  try {
    const res = await fetch('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: raw }),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (controller.signal.aborted) return;
    state.request = null;
    if (!res.ok) {
      state.lastId = null;
      state.post = null;
      state.error = {
        code: data.error?.code ?? 'INTERNAL',
        message: data.error?.message ?? 'Algo deu errado do nosso lado. Tente de novo.',
      };
      renderPanel();
      return;
    }
    state.post = data.post;
    state.gif = data.gif;
    selectMedia(data.selectedIndex ?? 0);
  } catch (err) {
    if (err.name === 'AbortError') return;
    state.request = null;
    state.lastId = null;
    state.error = { code: 'NETWORK', message: 'Não foi possível falar com o servidor. Verifique sua internet e tente de novo.' };
    renderPanel();
  } finally {
    if (state.request === controller) state.request = null;
  }
}

function selectMedia(index) {
  state.mediaIndex = index;
  const media = currentMedia();
  state.format = media.type === 'gif' && media.canGif ? 'gif' : 'mp4';
  state.variantIndex = 0;
  state.gifPreset = 'sd';
  if (state.mode === 'sticker') state.stickerFrom = 'x';
  renderPanel();
}

const currentMedia = () => state.post.media[state.mediaIndex];

function gifPresets(media) {
  const presets = [{ key: 'sd', label: '480 px', sub: 'Leve, bom para mensagens' }];
  if ((media.width ?? 0) > 480) presets.push({ key: 'hd', label: '720 px', sub: 'Mais nítido, arquivo maior' });
  return presets;
}

/** Escolhe a menor variante que ainda cobre a largura do GIF desejado. */
function gifSource(media, presetKey) {
  const width = presetKey === 'hd' ? 720 : 480;
  const sorted = [...media.variants].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  return sorted.find((v) => (v.width ?? 0) >= width) ?? sorted[sorted.length - 1];
}

/** Nome do arquivo: XDauLou_<número do post>_<qualidade>, ex.: XDauLou_1790000000000000001_720 */
function fileBase(quality) {
  return `XDauLou_${state.post.id}_${quality}`;
}

function downloadTarget() {
  const media = currentMedia();
  if (state.format === 'gif') {
    const src = gifSource(media, state.gifPreset);
    const name = fileBase(state.gifPreset === 'hd' ? '720' : '480');
    return {
      kind: 'gif',
      url: `/api/gif?${signedQuery(src)}&q=${state.gifPreset}&name=${encodeURIComponent(name)}`,
      filename: `${name}.gif`,
      size: null,
    };
  }
  const v = media.variants[state.variantIndex];
  const name = fileBase(v.label.replace(/p$/, '').toLowerCase());
  return {
    kind: 'mp4',
    url: `/api/download?${signedQuery(v)}&name=${encodeURIComponent(name)}`,
    filename: `${name}.mp4`,
    size: v.sizeBytes,
  };
}

// Renderização -------------------------------------------------------------

function renderEmpty() {
  result.setAttribute('aria-busy', 'false');
  result.innerHTML = `
    <div class="empty">
      <div class="empty-shapes" aria-hidden="true">
        <span class="empty-square">GIF</span>
        <span class="empty-rect">Vídeo</span>
      </div>
      <p>Cole o link de um post para ver a mídia e escolher a qualidade do download.</p>
    </div>`;
}

function renderStickerEmpty() {
  result.setAttribute('aria-busy', 'false');
  result.innerHTML = `
    <div class="empty">
      <div class="empty-shapes" aria-hidden="true">
        <span class="empty-sticker">512 × 512</span>
      </div>
      <p>Cole o link de um post ou envie um arquivo para montar a figurinha.</p>
    </div>`;
}

function renderSkeleton() {
  result.setAttribute('aria-busy', 'true');
  result.innerHTML = `
    <div class="content skeleton" aria-label="Buscando o post">
      <div class="preview">
        <div class="frame frame--video"></div>
        <div class="bone-lines">
          <div class="byline"><div class="bone bone--avatar"></div><div class="bone bone--short"></div></div>
          <div class="bone bone--long"></div>
          <div class="bone bone--short"></div>
        </div>
      </div>
      <div class="bone bone--row"></div>
      <div class="bone bone--row"></div>
      <div class="bone bone--row"></div>
    </div>`;
}

function renderError(code, message) {
  result.setAttribute('aria-busy', 'false');
  const title = TITLES[code] ?? 'Não deu certo';
  result.innerHTML = `
    <div class="message" role="alert">
      <h2 class="message-title">${escapeHtml(title)}</h2>
      <p class="message-text">${escapeHtml(message)}</p>
      ${RETRYABLE.has(code) ? '<button type="button" class="secondary" data-action="retry">Tentar de novo</button>' : ''}
    </div>`;
}

function renderPost() {
  result.setAttribute('aria-busy', 'false');
  const { post } = state;
  const media = currentMedia();
  const isGif = media.type === 'gif';
  const isPortrait = !isGif && media.width && media.height && media.height > media.width;
  const frameClass = `frame ${isGif ? 'frame--gif' : 'frame--video'}${isPortrait ? ' frame--portrait' : ''}`;
  const duration = formatDuration(media.durationMs);
  const author = post.author;

  const picker =
    post.media.length > 1
      ? `<div class="picker" role="group" aria-label="Escolha a mídia">
          ${post.media
            .map(
              (m, i) => `<button type="button" data-media="${i}" aria-pressed="${i === state.mediaIndex}"
                aria-label="Mídia ${i + 1}">${m.thumbnail ? `<img src="${thumbUrl(m.thumbnail)}" alt="" loading="lazy">` : ''}<span>${i + 1}</span></button>`,
            )
            .join('')}
        </div>`
      : '';

  const formatGroup = media.canGif
    ? `<fieldset class="group">
        <legend>Formato</legend>
        <div class="segmented">
          <label><input type="radio" name="format" value="mp4" ${state.format === 'mp4' ? 'checked' : ''}>Vídeo MP4</label>
          <label><input type="radio" name="format" value="gif" ${state.format === 'gif' ? 'checked' : ''}>GIF animado</label>
        </div>
      </fieldset>`
    : '';

  result.innerHTML = `
    <article class="content">
      <div class="preview">
        <figure class="${frameClass}">
          ${media.thumbnail ? `<img src="${thumbUrl(media.thumbnail)}" alt="Miniatura do ${isGif ? 'GIF' : 'vídeo'}">` : ''}
          ${isGif ? '<span class="badge badge--kind">GIF</span>' : ''}
          ${duration ? `<span class="badge badge--time">${duration}</span>` : ''}
        </figure>
        <div class="preview-info">
          <div class="byline">
            ${author.avatar ? `<img class="avatar" src="${thumbUrl(author.avatar)}" alt="">` : '<div class="avatar"></div>'}
            <div class="byline-text">
              <strong>${escapeHtml(author.name || author.username || 'Autor desconhecido')}</strong>
              ${author.username ? `<span>@${escapeHtml(author.username)}</span>` : ''}
            </div>
          </div>
          ${post.text ? `<p class="post-text">${escapeHtml(post.text)}</p>` : ''}
          ${post.fromQuote ? '<p class="note">A mídia é do post citado.</p>' : ''}
        </div>
      </div>
      ${picker}
      ${formatGroup}
      <fieldset class="group">
        <legend>Qualidade</legend>
        <div class="qualities" id="qualities"></div>
      </fieldset>
      <p class="note" id="format-note" hidden></p>
      <button type="button" class="download" id="download" data-action="download"></button>
      ${state.features.sticker ? '<button type="button" class="secondary secondary--wide" data-action="to-sticker">Transformar em figurinha</button>' : ''}
    </article>`;

  renderQualities();
}

function renderQualities() {
  const media = currentMedia();
  const box = $('#qualities');
  const note = $('#format-note');

  if (state.format === 'gif') {
    box.innerHTML = gifPresets(media)
      .map(
        (p) => `<label class="quality">
          <input type="radio" name="quality" value="${p.key}" ${p.key === state.gifPreset ? 'checked' : ''}>
          <span class="quality-label">${p.label}<span class="quality-sub">${p.sub}</span></span>
        </label>`,
      )
      .join('');
    note.hidden = false;
    note.textContent = 'GIFs ficam bem maiores que o MP4, e a conversão leva alguns segundos.';
  } else {
    const max = Math.max(...media.variants.map((v) => v.sizeBytes ?? 0));
    box.innerHTML = media.variants
      .map((v, i) => {
        const size = formatBytes(v.sizeBytes);
        const fill = max && v.sizeBytes ? Math.max(6, Math.round((v.sizeBytes / max) * 100)) : 0;
        const sizeText = size ? `${v.sizeEstimated ? '≈ ' : ''}${size}` : '';
        return `<label class="quality" data-fill="${fill}%">
          <input type="radio" name="quality" value="${i}" ${i === state.variantIndex ? 'checked' : ''}>
          <span class="quality-label">${escapeHtml(v.label)}</span>
          <span class="quality-size">${sizeText}</span>
        </label>`;
      })
      .join('');
    box.querySelectorAll('[data-fill]').forEach((el) => el.style.setProperty('--fill', el.dataset.fill));
    const estimated = media.variants.some((v) => v.sizeEstimated);
    note.hidden = !estimated;
    note.textContent = estimated ? 'Tamanhos com ≈ são estimativas.' : '';
  }
  renderButton();
}

function renderButton(override) {
  const btn = $('#download');
  if (!btn) return;
  if (override) {
    btn.textContent = override;
    return;
  }
  const media = currentMedia();
  if (state.format === 'gif') {
    btn.textContent = `Baixar GIF ${state.gifPreset === 'hd' ? '720 px' : '480 px'}`;
  } else {
    const v = media.variants[state.variantIndex];
    const size = formatBytes(v.sizeBytes);
    btn.textContent = size ? `Baixar ${v.label} (${v.sizeEstimated ? '≈ ' : ''}${size})` : `Baixar ${v.label}`;
  }
}

// Download -------------------------------------------------------------------

function nativeDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
}

function setProgress(btn, fraction) {
  btn.classList.toggle('is-indeterminate', fraction === null);
  btn.style.setProperty('--progress', fraction === null ? '0%' : `${Math.round(fraction * 100)}%`);
}

async function startDownload() {
  if (state.download) return;
  const btn = $('#download');
  const target = downloadTarget();

  if (target.kind === 'mp4' && target.size && target.size > NATIVE_DOWNLOAD_ABOVE) {
    nativeDownload(target.url, target.filename);
    return;
  }

  const controller = new AbortController();
  state.download = controller;
  btn.setAttribute('aria-busy', 'true');
  setProgress(btn, null);
  renderButton(target.kind === 'gif' ? 'Convertendo em GIF…' : 'Baixando…');

  try {
    const res = await fetch(target.url, { signal: controller.signal });
    if (!res.ok) throw await apiError(res, 'Não foi possível baixar o arquivo. Tente de novo.');
    const total = Number(res.headers.get('content-length')) || target.size || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        const fraction = Math.min(1, received / total);
        setProgress(btn, fraction);
        renderButton(`${target.kind === 'gif' ? 'Baixando GIF' : 'Baixando'} ${Math.round(fraction * 100)}%`);
      }
    }
    saveBlob(new Blob(chunks, { type: target.kind === 'gif' ? 'image/gif' : 'video/mp4' }), target.filename);
    setProgress(btn, 1);
    renderButton('Baixado');
    setHint(`Download concluído: ${target.filename}`);
    setTimeout(() => {
      if ($('#download') === btn) {
        setProgress(btn, 0);
        renderButton();
      }
    }, 2500);
  } catch (err) {
    if (err.name === 'AbortError') return;
    setProgress(btn, 0);
    renderButton();
    setHint(err.code ? err.message : 'O download foi interrompido. Verifique sua conexão e tente de novo.', true);
  } finally {
    btn.removeAttribute('aria-busy');
    state.download = null;
  }
}

// Arquivo do usuário (modo figurinha) ---------------------------------------------

const ACCEPTED = /^(image\/gif|video\/(mp4|quicktime|webm))$/;

async function useFile(file) {
  if (!file) return;
  if (!ACCEPTED.test(file.type) && !/\.(gif|mp4|mov|webm|m4v)$/i.test(file.name)) {
    setHint('Envie um GIF ou um vídeo MP4, MOV ou WebM.', true);
    return;
  }
  const maxMb = state.features.stickerMaxUploadMb;
  if (file.size > maxMb * 1024 * 1024) {
    setHint(`O arquivo passa de ${maxMb} MB. Use um arquivo menor.`, true);
    return;
  }
  if (state.file) URL.revokeObjectURL(state.file.previewUrl);
  state.file = await sourceFromFile(file);
  state.stickerFrom = 'file';
  state.error = null;
  dropLabel.textContent = `${file.name} (${formatBytes(file.size)})`;
  dropzone.classList.add('has-file');
  setHint(DEFAULT_HINT);
  if (state.mode !== 'sticker') setMode('sticker');
  else renderPanel();
  // No celular os cards ficam empilhados: leva a pessoa até o estúdio.
  if (window.matchMedia('(max-width: 56rem)').matches) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    result.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }
}

fileInput.addEventListener('change', () => {
  useFile(fileInput.files?.[0]);
  fileInput.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.add('is-dragging');
  });
}
for (const type of ['dragleave', 'drop']) {
  dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    dropzone.classList.remove('is-dragging');
  });
}
dropzone.addEventListener('drop', (e) => useFile(e.dataTransfer?.files?.[0]));

// Eventos ----------------------------------------------------------------------

modeSwitch.addEventListener('change', (e) => setMode(e.target.value));

let debounce;
input.addEventListener('input', () => {
  updateClear();
  clearTimeout(debounce);
  const value = input.value;
  if (!value.trim()) {
    setHint(DEFAULT_HINT);
    return;
  }
  debounce = setTimeout(() => {
    if (parseTweetUrl(value)) search(value);
  }, 250);
});

input.addEventListener('paste', () => {
  // Colou um link válido: busca na hora, sem esperar o debounce.
  setTimeout(() => {
    clearTimeout(debounce);
    updateClear();
    search(input.value);
  }, 0);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  clearTimeout(debounce);
  search(input.value, { force: true });
});

pasteBtn.addEventListener('click', async () => {
  try {
    if (!navigator.clipboard?.readText) throw new Error('unsupported');
    const text = await navigator.clipboard.readText();
    if (!text.trim()) {
      setHint('A área de transferência está vazia. Copie o link do post e tente de novo.', true);
      return;
    }
    input.value = text.trim();
    updateClear();
    search(input.value, { force: true });
  } catch {
    input.focus();
    setHint('Seu navegador não liberou a área de transferência. Toque e segure no campo para colar.', true);
  }
});

clearBtn.addEventListener('click', () => {
  state.request?.abort();
  state.request = null;
  state.download?.abort();
  input.value = '';
  state.lastId = null;
  state.post = null;
  state.error = null;
  if (state.stickerFrom === 'x') state.stickerFrom = state.file ? 'file' : null;
  renderPanel();
  setHint(DEFAULT_HINT);
  updateClear();
  input.focus();
});

// Miniatura que não carrega some, em vez de mostrar o ícone de imagem quebrada.
result.addEventListener(
  'error',
  (e) => {
    if (e.target instanceof HTMLImageElement) e.target.classList.add('is-broken');
  },
  true,
);

result.addEventListener('change', (e) => {
  const el = e.target;
  if (el.name === 'format') {
    state.format = el.value;
    renderQualities();
  } else if (el.name === 'quality') {
    if (state.format === 'gif') state.gifPreset = el.value;
    else state.variantIndex = Number(el.value);
    renderButton();
  }
});

result.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action], [data-media]');
  if (!actionEl) return;
  if (actionEl.dataset.media !== undefined) {
    if (state.download) return;
    selectMedia(Number(actionEl.dataset.media));
    return;
  }
  const action = actionEl.dataset.action;
  if (action === 'download') startDownload();
  if (action === 'retry') search(input.value, { force: true });
  if (action === 'to-sticker') {
    state.stickerFrom = 'x';
    setMode('sticker');
  }
});

// Início -------------------------------------------------------------------------

renderEmpty();

fetch('/api/health')
  .then((r) => r.json())
  .then((h) => {
    state.features = { sticker: Boolean(h.sticker), stickerMaxUploadMb: h.stickerMaxUploadMb ?? 15 };
    modeSwitch.hidden = !state.features.sticker;
    $('#drop-limit').textContent = `GIF, MP4, MOV ou WebM, até ${state.features.stickerMaxUploadMb} MB.`;
    if (state.mode === 'download' && state.post) renderPanel(); // mostra o atalho de figurinha
  })
  .catch(() => {});

// Link recebido por compartilhamento (PWA) ou por ?url= na barra de endereço.
const params = new URLSearchParams(location.search);
const shared = params.get('url') || params.get('text') || params.get('title');
if (shared) {
  history.replaceState(null, '', location.pathname); // não deixa o link no histórico
  input.value = shared.trim();
  updateClear();
  search(input.value, { force: true });
}
