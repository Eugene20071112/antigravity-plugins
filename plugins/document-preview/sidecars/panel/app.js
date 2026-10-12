// Frontend for the 文件预览 panel.
//
// /preload.js runs first and defines window.sidecar. The host opens this page
// with ?file=<absolute path> when a matching file is clicked. Without it (e.g.
// Overview → Plugins) the panel lists this conversation's files and the
// workspace's. Switching files happens in place, without reloading the page.
//
// Loaded as a classic script: the host's plugin:// proxy answers ES module
// requests with a 500, so pdf.js is loaded from blob: URLs (see loadPdfjs).

(() => {
  const sidecar = window.sidecar;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // Language: the 中文汉化包 / claude-style plugins announce it by postMessage
  // ('agy-locale'); otherwise follow the system language.
  let locale = (() => {
    try { const saved = sessionStorage.getItem('agy-locale'); if (saved) return saved; } catch { /* ignore */ }
    return /^zh/i.test(navigator.language) ? 'zh' : 'en';
  })();
  const L = (zh, en) => (locale === 'zh' ? zh : en);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  async function callApi(path, body) {
    const res = await (sidecar?.fetch ?? fetch)(path, { method: 'POST', body: JSON.stringify({ ...(body ?? {}), lang: locale }) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }

  let toastTimer;
  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
  }

  function formatSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds)) return '0:00';
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    const m = Math.floor(seconds / 60) % 60;
    const h = Math.floor(seconds / 3600);
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function formatAgo(ms) {
    const diff = (Date.now() - ms) / 1000;
    if (diff < 60) return L('刚刚', 'just now');
    if (diff < 3600) return L(`${Math.floor(diff / 60)} 分钟前`, `${Math.floor(diff / 60)} min ago`);
    if (diff < 86400) return L(`${Math.floor(diff / 3600)} 小时前`, `${Math.floor(diff / 3600)} h ago`);
    if (diff < 86400 * 30) return L(`${Math.floor(diff / 86400)} 天前`, `${Math.floor(diff / 86400)} d ago`);
    return new Date(ms).toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US');
  }

  const TILE = {
    pdf: ['.pdf', '.ai'],
    word: ['.doc', '.docx', '.docm', '.dot', '.dotx', '.rtf', '.odt', '.ott', '.pages', '.wps', '.wpt'],
    slides: ['.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.pot', '.potx', '.odp', '.key', '.dps', '.dpt'],
    sheet: ['.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.ods', '.numbers', '.et', '.ett', '.csv', '.tsv'],
  };
  function tileColor(file) {
    for (const [color, exts] of Object.entries(TILE)) if (exts.includes(file.ext)) return color;
    return { image: 'image', video: 'media', audio: 'media', font: 'font', archive: 'archive' }[file.kind] ?? '';
  }

  function makeTile(file) {
    const tile = document.createElement('span');
    tile.className = 'tile';
    tile.dataset.c = tileColor(file);
    tile.textContent = file.ext.slice(1, 5);
    return tile;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
  }

  // The host pushes theme tokens only when the iframe first loads; remember
  // them so a reload doesn't fall back to defaults.
  (function persistTheme() {
    const KEY = 'host-theme';
    const root = document.documentElement;
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      if (saved && !root.style.getPropertyValue('--background')) {
        for (const [k, v] of Object.entries(saved)) root.style.setProperty(k, v);
      }
    } catch { /* storage unavailable */ }
    new MutationObserver(() => {
      const vars = {};
      for (const name of root.style) if (name.startsWith('--') && !name.startsWith('--viewer') && !name.startsWith('--scale')) vars[name] = root.style.getPropertyValue(name);
      try { if (vars['--background']) sessionStorage.setItem(KEY, JSON.stringify(vars)); } catch { /* ignore */ }
    }).observe(root, { attributes: true, attributeFilter: ['style'] });
  })();

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  let loaderTimer;
  function showLoading(title, detail = '') {
    $('status').hidden = false;
    $('status-error').hidden = true;
    $('status-actions').hidden = true;
    $('status-title').textContent = title;
    $('status-detail').textContent = detail;
    $('status-loading').style.visibility = 'hidden';
    clearTimeout(loaderTimer);
    loaderTimer = setTimeout(() => { $('status-loading').style.visibility = ''; }, 150);
  }

  function showError(title, detail = '') {
    clearTimeout(loaderTimer);
    $('status').hidden = false;
    $('status-loading').style.visibility = 'hidden';
    $('status-error').hidden = false;
    $('status-title').textContent = title;
    $('status-detail').textContent = detail;
    $('status-actions').hidden = !current;
  }

  function hideStatus() {
    clearTimeout(loaderTimer);
    $('status').hidden = true;
  }

  // ---------------------------------------------------------------------------
  // View switching
  // ---------------------------------------------------------------------------

  const VIEWS = {
    pdf: 'pdf-container', image: 'image-view', video: 'video-view', audio: 'audio-view', table: 'table-view',
    font: 'font-view', archive: 'archive-view', text: 'text-view', library: 'library',
  };
  let current = null; // prepared file info
  let currentView = null;
  let openToken = 0;
  let fromLibrary = false;

  function showView(view) {
    currentView = view;
    for (const [name, id] of Object.entries(VIEWS)) $(id).hidden = name !== view;
    $('thumbs').hidden = !(view === 'pdf' && thumbsOpen);
    $('pdf-container').classList.toggle('with-thumbs', view === 'pdf' && thumbsOpen);
    updateDock();
    if (view !== 'library') $(VIEWS[view]).focus({ preventScroll: true });
  }

  function resetViews() {
    closePopovers();
    closeFind();
    for (const media of [$('video'), $('audio')]) {
      media.pause();
      media.removeAttribute('src');
      media.load();
    }
    cancelAnimationFrame(waveRaf);
    for (const id of Object.values(VIEWS)) $(id).hidden = true;
    $('thumbs').hidden = true;
    currentView = null;
  }

  // ---------------------------------------------------------------------------
  // Dock (floating controls)
  // ---------------------------------------------------------------------------

  const AUTO_HIDE = new Set(['pdf', 'image', 'video']);
  let idleTimer;

  function updateDock() {
    const dock = $('dock');
    dock.hidden = !current || currentView === 'library';
    $('back').hidden = !fromLibrary;
    for (const group of $$('.dock-group', dock)) group.hidden = !group.dataset.for.split(' ').includes(currentView);
    dock.classList.toggle('top', currentView === 'video');
    wake();
  }

  function wake() {
    $('dock').classList.remove('idle');
    $('video-view').classList.remove('idle');
    clearTimeout(idleTimer);
    if (!AUTO_HIDE.has(currentView)) return;
    idleTimer = setTimeout(() => {
      const busy = $('dock').matches(':hover') || $$('.popover').some((p) => !p.hidden) || !$('find-bar').hidden
        || document.activeElement?.closest?.('.dock');
      if (busy) return wake();
      if (currentView === 'video' && $('video').paused) return;
      $('dock').classList.add('idle');
      if (currentView === 'video') $('video-view').classList.add('idle');
    }, 2200);
  }

  // ---------------------------------------------------------------------------
  // Popovers
  // ---------------------------------------------------------------------------

  // Popovers grow out of their button and shrink back into it.
  function openPopover(pop, anchor) {
    closePopovers(pop);
    pop.classList.remove('out');
    pop.hidden = false;
    const a = anchor.getBoundingClientRect();
    // offset* ignores the opening scale animation; getBoundingClientRect would not.
    const p = { width: pop.offsetWidth, height: pop.offsetHeight };
    const left = Math.min(Math.max(8, a.left + a.width / 2 - p.width / 2), innerWidth - p.width - 8);
    const above = a.top - p.height - 8;
    const top = above > 8 ? above : Math.min(a.bottom + 8, innerHeight - p.height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    const fromBelow = top < a.top;
    pop.style.transformOrigin = `${Math.min(p.width, Math.max(0, a.left + a.width / 2 - left))}px ${fromBelow ? '100%' : '0%'}`;
    pop.style.setProperty('--dy', fromBelow ? '6px' : '-6px');
    pop.style.animation = 'none';
    void pop.offsetWidth;
    pop.style.animation = '';
    anchor.setAttribute('aria-expanded', 'true');
  }

  function closePopovers(except) {
    for (const pop of $$('.popover')) {
      if (pop === except || pop.hidden || pop.classList.contains('out')) continue;
      pop.classList.add('out');
      const done = () => { if (pop.classList.contains('out')) { pop.hidden = true; pop.classList.remove('out'); } };
      pop.addEventListener('animationend', done, { once: true });
      setTimeout(done, 220);
    }
    for (const btn of $$('[aria-expanded="true"]')) btn.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('pointerdown', (event) => {
    if (!event.target.closest('.popover, #more, #switcher, [data-act="speed"]')) closePopovers();
  });

  function openMenu() {
    const info = $('menu-info');
    info.replaceChildren();
    const name = Object.assign(document.createElement('div'), { className: 'name', textContent: current.name });
    const bits = [current.ext.slice(1).toUpperCase(), formatSize(current.size)];
    if (current.meta?.width) bits.push(`${current.meta.width}×${current.meta.height}`);
    if (currentView === 'image' && $('image').naturalWidth) bits.push(`${$('image').naturalWidth}×${$('image').naturalHeight}`);
    if (currentView === 'pdf' && pdfDoc) bits.push(L(`${pdfDoc.numPages} 页`, `${pdfDoc.numPages} pages`));
    if (current.meta?.duration) bits.push(formatTime(current.meta.duration));
    if (current.converted) bits.push(current.view === 'pdf' ? L('已转换为 PDF 预览', 'Converted to PDF for preview') : L('兼容格式', 'Compatible format'));
    const meta = Object.assign(document.createElement('div'), { className: 'meta', textContent: bits.join(' · ') });
    info.append(name, meta);
    const night = $('menu').querySelector('[data-menu="night"]');
    night.hidden = currentView !== 'pdf';
    night.setAttribute('aria-checked', String($('stage').classList.contains('night')));
    openPopover($('menu'), $('more'));
  }

  async function menuAction(action) {
    closePopovers();
    if (action === 'night') {
      const on = $('stage').classList.toggle('night');
      try { localStorage.setItem('night', on ? '1' : ''); } catch { /* ignore */ }
    } else if (action === 'copy') {
      await copyText(current.path);
      toast(L('已复制文件路径', 'File path copied'));
    } else if (action === 'open' || action === 'reveal') {
      reveal(action);
    }
  }

  async function reveal(action) {
    if (!current) return;
    try {
      await callApi('/api/reveal', { id: current.id, action });
    } catch (err) {
      toast(err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Opening files
  // ---------------------------------------------------------------------------

  const LOADING_TEXT = {
    office: [L('正在转换文档…', 'Converting document…'), L('首次打开需要用 LibreOffice 排版，稍等几秒', 'First open is laid out by LibreOffice, a few seconds')],
    video: [L('正在准备视频…', 'Preparing video…'), ''],
    audio: [L('正在准备音频…', 'Preparing audio…'), ''],
    image: [L('正在载入图片…', 'Loading image…'), ''],
    archive: [L('正在读取压缩包…', 'Reading archive…'), ''],
  };

  async function openFile(filePath, { fromList = false } = {}) {
    const token = ++openToken;
    fromLibrary = fromList;
    resetViews();
    const url = new URL(location.href);
    url.searchParams.set('file', filePath);
    history.replaceState(null, '', url);
    current = null;
    updateDock();
    showLoading(L('正在打开…', 'Opening…'));
    try {
      const info = await callApi('/api/open', { path: filePath });
      if (token !== openToken) return;
      current = info;
      const [title, detail] = LOADING_TEXT[info.kind] ?? [L('正在打开…', 'Opening…'), ''];
      showLoading(title, detail);
      const prepared = await callApi('/api/prepare', { id: info.id });
      if (token !== openToken) return;
      current = prepared;
      // Views measure themselves while rendering, so show them first.
      showView(prepared.view);
      await RENDER[prepared.view](prepared, token);
      if (token !== openToken) return;
      hideStatus();
      if (prepared.converted && (prepared.view === 'video' || prepared.view === 'audio')) toast(L('已转换为兼容格式，原文件未改动', 'Converted to a compatible format; the original is unchanged'));
    } catch (err) {
      if (token !== openToken) return;
      showError(L('无法预览这个文件', 'Can\'t preview this file'), err.message);
      updateDock();
    }
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  let pdfjs = null;
  let viewer = null;
  let eventBus = null;
  let pdfDoc = null;
  let thumbsOpen = false;

  async function blobUrl(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error(L(`无法加载 ${path}`, `Couldn't load ${path}`));
    return URL.createObjectURL(new Blob([await res.text()], { type: 'text/javascript' }));
  }
  const absolute = (path) => new URL(path, location.href).href;

  async function loadPdfjs() {
    if (pdfjs) return pdfjs;
    const lib = await import(await blobUrl('/vendor/pdfjs/pdf.min.mjs'));
    globalThis.pdfjsLib = lib;
    const viewerLib = await import(await blobUrl('/vendor/pdfjs/pdf_viewer.mjs'));
    lib.GlobalWorkerOptions.workerSrc = await blobUrl('/vendor/pdfjs/pdf.worker.min.mjs');
    pdfjs = { lib, viewerLib };

    const container = $('pdf-container');
    eventBus = new viewerLib.EventBus();
    const linkService = new viewerLib.PDFLinkService({ eventBus, externalLinkTarget: viewerLib.LinkTarget.BLANK });
    const findController = new viewerLib.PDFFindController({ eventBus, linkService });
    viewer = new viewerLib.PDFViewer({ container, viewer: $('pdf-viewer'), eventBus, linkService, findController });
    linkService.setViewer(viewer);
    pdfjs.linkService = linkService;

    eventBus.on('pagesinit', () => { viewer.currentScaleValue = 'auto'; });
    eventBus.on('pagechanging', ({ pageNumber }) => {
      $('page').value = String(pageNumber);
      for (const t of $$('.thumb')) t.classList.toggle('current', Number(t.dataset.page) === pageNumber);
      $(`thumb-${pageNumber}`)?.scrollIntoView({ block: 'nearest' });
    });
    eventBus.on('scalechanging', ({ scale }) => { $('zoom-label').textContent = `${Math.round(scale * 100)}%`; });
    eventBus.on('updatefindmatchescount', ({ matchesCount }) => setFindCount(matchesCount.current, matchesCount.total));
    eventBus.on('updatefindcontrolstate', ({ matchesCount }) => setFindCount(matchesCount?.current, matchesCount?.total));

    new ResizeObserver(() => {
      const value = viewer.currentScaleValue;
      if (pdfDoc && ['auto', 'page-width', 'page-fit'].includes(value)) viewer.currentScaleValue = value;
    }).observe(container);

    // Trackpad pinch arrives as ctrl+wheel; zoom around the cursor.
    container.addEventListener('wheel', (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      viewer.updateScale({ drawingDelay: 300, scaleFactor: Math.exp(-event.deltaY / 100), origin: [event.clientX, event.clientY] });
    }, { passive: false });
    return pdfjs;
  }

  async function renderPdf(info) {
    const { lib } = await loadPdfjs();
    if (pdfDoc) {
      viewer.setDocument(null);
      pdfjs.linkService.setDocument(null);
      pdfDoc.destroy();
      pdfDoc = null;
    }
    $('thumbs').replaceChildren();
    const task = lib.getDocument({
      url: absolute(info.src),
      cMapUrl: absolute('/vendor/pdfjs/cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: absolute('/vendor/pdfjs/standard_fonts/'),
      wasmUrl: absolute('/vendor/pdfjs/wasm/'),
      iccUrl: absolute('/vendor/pdfjs/iccs/'),
    });
    task.onPassword = (update, reason) => {
      const password = prompt(reason === lib.PasswordResponses.INCORRECT_PASSWORD ? L('密码不正确，请重试：', 'Wrong password, try again:') : L('这个 PDF 需要密码：', 'This PDF needs a password:'));
      if (password == null) task.destroy();
      else update(password);
    };
    try {
      pdfDoc = await task.promise;
    } catch (err) {
      throw new Error(err?.name === 'PasswordException' ? L('需要密码才能打开。', 'A password is required.') : L('文件可能已损坏。', 'The file may be damaged.'));
    }
    viewer.setDocument(pdfDoc);
    pdfjs.linkService.setDocument(pdfDoc);
    $('pages').textContent = `/ ${pdfDoc.numPages}`;
    $('page').value = '1';
    const multi = pdfDoc.numPages > 1;
    $('thumbs-toggle').hidden = !multi;
    if (!multi) thumbsOpen = false;
    if (thumbsOpen) buildThumbs();
    $('thumbs-toggle').setAttribute('aria-pressed', String(thumbsOpen));
    $('thumbs').hidden = !thumbsOpen;
    $('pdf-container').classList.toggle('with-thumbs', thumbsOpen);
  }

  function toggleThumbs() {
    thumbsOpen = !thumbsOpen;
    $('thumbs-toggle').setAttribute('aria-pressed', String(thumbsOpen));
    if (thumbsOpen && !$('thumbs').children.length) buildThumbs();
    $('thumbs').hidden = !thumbsOpen;
    $('pdf-container').classList.toggle('with-thumbs', thumbsOpen);
  }

  async function buildThumbs() {
    const doc = pdfDoc;
    const box = $('thumbs');
    box.replaceChildren();
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.dataset.done) continue;
        entry.target.dataset.done = '1';
        renderThumb(doc, entry.target);
      }
    }, { root: box, rootMargin: '200px' });
    for (let n = 1; n <= doc.numPages; n++) {
      const btn = document.createElement('button');
      btn.className = `thumb${n === viewer.currentPageNumber ? ' current' : ''}`;
      btn.id = `thumb-${n}`;
      btn.dataset.page = String(n);
      btn.type = 'button';
      btn.style.setProperty('--ratio', String(vp.width / vp.height));
      const frame = Object.assign(document.createElement('span'), { className: 'frame' });
      btn.append(frame, document.createTextNode(String(n)));
      btn.addEventListener('click', () => { viewer.currentPageNumber = n; });
      box.append(btn);
      observer.observe(btn);
    }
  }

  async function renderThumb(doc, btn) {
    if (doc !== pdfDoc) return;
    const page = await doc.getPage(Number(btn.dataset.page));
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (104 * devicePixelRatio) / base.width });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    btn.style.setProperty('--ratio', String(base.width / base.height));
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    btn.querySelector('.frame').append(canvas);
  }

  // ---------------------------------------------------------------------------
  // Image (pan & zoom)
  // ---------------------------------------------------------------------------

  const img = { scale: 1, x: 0, y: 0, rot: 0, fit: true };

  async function renderImage(info) {
    const el = $('image');
    el.alt = info.name;
    el.src = info.src;
    try {
      await el.decode();
    } catch {
      throw new Error(L('图片无法解码。', 'The image can\'t be decoded.'));
    }
    img.rot = 0;
    $('image-view').classList.toggle('pixelated', el.naturalWidth < 256);
    fitImage(false);
  }

  function imageBox() {
    const el = $('image');
    const turned = img.rot % 180 !== 0;
    return { w: turned ? el.naturalHeight : el.naturalWidth, h: turned ? el.naturalWidth : el.naturalHeight };
  }

  function applyImage(animate) {
    const el = $('image');
    $('image-view').classList.toggle('animate', !!animate);
    el.style.transformOrigin = 'center';
    el.style.transform = `translate(${img.x - el.naturalWidth / 2}px, ${img.y - el.naturalHeight / 2}px) rotate(${img.rot}deg) scale(${img.scale})`;
    $('zoom-label').textContent = `${Math.round(img.scale * 100)}%`;
  }

  function fitImage(animate = true) {
    const view = $('image-view');
    const { w, h } = imageBox();
    if (!w || !view.clientWidth) return;
    const fit = Math.min((view.clientWidth - 48) / w, (view.clientHeight - 96) / h);
    img.scale = Math.min(fit, w < 256 ? 8 : 1);
    img.x = view.clientWidth / 2;
    img.y = (view.clientHeight - 44) / 2;
    img.fit = true;
    applyImage(animate);
  }

  function zoomImage(factor, cx, cy, animate) {
    const rect = $('image-view').getBoundingClientRect();
    const px = (cx ?? rect.left + rect.width / 2) - rect.left;
    const py = (cy ?? rect.top + rect.height / 2) - rect.top;
    const next = Math.min(32, Math.max(0.02, img.scale * factor));
    const k = next / img.scale;
    img.x = px + (img.x - px) * k;
    img.y = py + (img.y - py) * k;
    img.scale = next;
    img.fit = false;
    applyImage(animate);
  }

  function setupImageInteractions() {
    const view = $('image-view');
    view.addEventListener('wheel', (event) => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) zoomImage(Math.exp(-event.deltaY / 100), event.clientX, event.clientY);
      else {
        img.x -= event.deltaX;
        img.y -= event.deltaY;
        img.fit = false;
        applyImage();
      }
    }, { passive: false });
    let drag = null;
    view.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, ix: img.x, iy: img.y };
      view.setPointerCapture(event.pointerId);
      view.classList.add('dragging');
    });
    view.addEventListener('pointermove', (event) => {
      if (!drag) return;
      img.x = drag.ix + event.clientX - drag.x;
      img.y = drag.iy + event.clientY - drag.y;
      img.fit = false;
      applyImage();
    });
    const end = () => { drag = null; view.classList.remove('dragging'); };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
    view.addEventListener('dblclick', (event) => {
      if (img.fit) zoomImage(1 / img.scale, event.clientX, event.clientY, true);
      else fitImage();
    });
    new ResizeObserver(() => { if (img.fit && currentView === 'image') fitImage(false); }).observe(view);
  }

  // ---------------------------------------------------------------------------
  // Video & audio
  // ---------------------------------------------------------------------------

  const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function waitForMetadata(media, message) {
    return new Promise((resolve, reject) => {
      media.onloadedmetadata = () => resolve();
      media.onerror = () => reject(new Error(message));
    });
  }

  async function renderVideo(info) {
    const video = $('video');
    video.loop = false;
    video.src = info.stream;
    video.playbackRate = 1;
    await waitForMetadata(video, L('这个视频的编码无法播放。', 'This video\'s codec can\'t be played.'));
    syncMedia(video, $('video-view'));
  }

  async function renderAudio(info) {
    const audio = $('audio');
    audio.loop = false;
    audio.src = info.stream;
    audio.playbackRate = 1;
    $('audio-name').textContent = info.name;
    const bits = [info.ext.slice(1).toUpperCase()];
    if (info.meta?.sampleRate) bits.push(`${(info.meta.sampleRate / 1000).toFixed(1)} kHz`);
    if (info.meta?.channels) bits.push(info.meta.channels === 1 ? L('单声道', 'Mono') : info.meta.channels === 2 ? L('立体声', 'Stereo') : L(`${info.meta.channels} 声道`, `${info.meta.channels} channels`));
    bits.push(formatSize(info.size));
    $('audio-meta').textContent = bits.join(' · ');
    peaks = null;
    await waitForMetadata(audio, L('这个音频无法播放。', 'This audio can\'t be played.'));
    syncMedia(audio, $('audio-view'));
    drawWave();
    loadPeaks(info);
  }

  function syncMedia(media, root) {
    const set = (sel, fn) => $$(sel, root).forEach(fn);
    set('[data-time="duration"]', (el) => { el.textContent = formatTime(media.duration); });
    set('[data-time="current"]', (el) => { el.textContent = formatTime(media.currentTime); });
    const playing = !media.paused;
    root.classList.toggle('playing', playing);
    set('[data-act="toggle"] use', (el) => el.setAttribute('href', playing ? '#i-pause' : '#i-play'));
    set('.play-main', (el) => el.classList.toggle('paused', !playing));
    set('[data-act="mute"] use', (el) => el.setAttribute('href', media.muted || media.volume === 0 ? '#i-mute' : '#i-volume'));
    set('[data-act="loop"]', (el) => el.setAttribute('aria-pressed', String(media.loop)));
    set('[data-act="speed"]', (el) => { el.textContent = `${media.playbackRate}×`; });
    const fraction = media.duration ? media.currentTime / media.duration : 0;
    set('.scrub-fill', (el) => { el.style.width = `${fraction * 100}%`; });
    set('.scrub-thumb', (el) => { el.style.left = `${fraction * 100}%`; });
    if (media.buffered.length && media.duration) {
      set('.scrub-buffer', (el) => { el.style.width = `${(media.buffered.end(media.buffered.length - 1) / media.duration) * 100}%`; });
    }
  }

  function mediaAction(media, root, act, anchor) {
    if (act === 'toggle') {
      if (media.paused) media.play().catch(() => {});
      else media.pause();
    } else if (act === 'mute') media.muted = !media.muted;
    else if (act === 'loop') media.loop = !media.loop;
    else if (act === 'back') media.currentTime = Math.max(0, media.currentTime - 10);
    else if (act === 'fwd') media.currentTime = Math.min(media.duration || 0, media.currentTime + 10);
    else if (act === 'pip') {
      if (document.pictureInPictureElement) document.exitPictureInPicture();
      else media.requestPictureInPicture?.().catch(() => toast(L('当前环境不支持画中画', 'Picture-in-picture isn\'t supported here')));
    } else if (act === 'speed') {
      const pop = $('speed-menu');
      pop.replaceChildren(...SPEEDS.map((rate) => {
        const item = document.createElement('button');
        item.className = 'menu-item';
        item.type = 'button';
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(media.playbackRate === rate));
        item.textContent = rate === 1 ? L('正常速度', 'Normal speed') : `${rate}×`;
        item.addEventListener('click', () => { media.playbackRate = rate; closePopovers(); syncMedia(media, root); });
        return item;
      }));
      openPopover(pop, anchor);
    }
    syncMedia(media, root);
  }

  function setupMedia(media, root) {
    for (const ev of ['play', 'pause', 'timeupdate', 'durationchange', 'progress', 'volumechange', 'ratechange', 'ended']) {
      media.addEventListener(ev, () => {
        syncMedia(media, root);
        if (media === $('audio') && (ev === 'play' || ev === 'pause')) animateWave();
        if (ev === 'play' || ev === 'pause') wake();
      });
    }
    root.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-act]');
      if (btn) mediaAction(media, root, btn.dataset.act, btn);
      else if (event.target === media) mediaAction(media, root, 'toggle');
    });
    const range = root.querySelector('.volume-range');
    range?.addEventListener('input', () => { media.volume = Number(range.value); media.muted = false; });

    const scrub = root.querySelector('[data-scrub]');
    const tip = scrub.querySelector('.scrub-tip');
    const at = (event) => {
      const r = scrub.getBoundingClientRect();
      return Math.min(1, Math.max(0, (event.clientX - r.left) / r.width));
    };
    let dragging = false;
    scrub.addEventListener('pointerdown', (event) => {
      dragging = true;
      scrub.setPointerCapture(event.pointerId);
      scrub.classList.add('active');
      if (media.duration) media.currentTime = at(event) * media.duration;
    });
    scrub.addEventListener('pointermove', (event) => {
      const f = at(event);
      tip.hidden = !media.duration;
      tip.textContent = formatTime(f * media.duration);
      tip.style.left = `${f * 100}%`;
      if (dragging && media.duration) media.currentTime = f * media.duration;
      if (media === $('audio')) { hoverFraction = f; drawWave(); }
    });
    scrub.addEventListener('pointerleave', () => {
      tip.hidden = true;
      if (media === $('audio')) { hoverFraction = null; drawWave(); }
    });
    const stop = () => { dragging = false; scrub.classList.remove('active'); };
    scrub.addEventListener('pointerup', stop);
    scrub.addEventListener('pointercancel', stop);
    scrub.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') media.currentTime -= 5;
      else if (event.key === 'ArrowRight') media.currentTime += 5;
      else return;
      event.preventDefault();
    });
  }

  function mediaKeys(event) {
    const media = currentView === 'video' ? $('video') : currentView === 'audio' ? $('audio') : null;
    if (!media || event.target.closest('input, [data-scrub]')) return false;
    const root = $(VIEWS[currentView]);
    const k = event.key.toLowerCase();
    if (k === ' ' || k === 'k') mediaAction(media, root, 'toggle');
    else if (k === 'arrowleft') media.currentTime = Math.max(0, media.currentTime - 5);
    else if (k === 'arrowright') media.currentTime += 5;
    else if (k === 'arrowup') media.volume = Math.min(1, media.volume + 0.1);
    else if (k === 'arrowdown') media.volume = Math.max(0, media.volume - 0.1);
    else if (k === 'm') mediaAction(media, root, 'mute');
    else if (k === 'l') mediaAction(media, root, 'loop');
    else return false;
    return true;
  }

  // Waveform -------------------------------------------------------------------

  let peaks = null;
  let hoverFraction = null;
  let waveRaf = 0;

  async function loadPeaks(info) {
    if (info.size > 80 * 1024 * 1024) return;
    try {
      const buffer = await (await fetch(info.src)).arrayBuffer();
      const ctx = new AudioContext();
      const audioBuffer = await ctx.decodeAudioData(buffer);
      ctx.close();
      if (current?.id !== info.id) return;
      const data = audioBuffer.getChannelData(0);
      const bins = 240;
      const step = Math.floor(data.length / bins) || 1;
      const out = new Float32Array(bins);
      for (let i = 0; i < bins; i++) {
        let sum = 0;
        let n = 0;
        for (let j = i * step, end = Math.min(data.length, j + step); j < end; j += 8, n++) sum += data[j] * data[j];
        out[i] = Math.sqrt(sum / (n || 1));
      }
      const max = Math.max(...out) || 1;
      peaks = out.map((v) => Math.pow(v / max, 0.7));
      drawWave();
    } catch { /* keep the flat placeholder */ }
  }

  function drawWave() {
    const canvas = $('wave-canvas');
    const dpr = devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--primary').trim() || '#4c8dff';
    const rest = css.getPropertyValue('--foreground').trim() || '#888';
    const audio = $('audio');
    const played = audio.duration ? audio.currentTime / audio.duration : 0;
    const barW = 3;
    const gap = 2;
    const count = Math.floor((w + gap) / (barW + gap));
    for (let i = 0; i < count; i++) {
      const f = i / count;
      const v = peaks ? peaks[Math.floor(f * peaks.length)] : 0.16;
      const bh = Math.max(3, v * h * 0.94);
      const isPlayed = f < played;
      ctx.globalAlpha = isPlayed ? 1 : hoverFraction != null && f < hoverFraction ? 0.45 : 0.22;
      ctx.fillStyle = isPlayed ? accent : rest;
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), (h - bh) / 2, barW, bh, 1.5);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function animateWave() {
    cancelAnimationFrame(waveRaf);
    const tick = () => {
      drawWave();
      if (!$('audio').paused) waveRaf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------------------------------------------------------------------------
  // Table (CSV/TSV), text, font, archive
  // ---------------------------------------------------------------------------

  // CSV from Excel on Chinese Windows is usually GBK, not UTF-8.
  async function fetchText(src) {
    const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer());
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
    } catch {
      return new TextDecoder('gb18030').decode(bytes);
    }
  }

  function parseCsv(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
        } else field += c;
      } else if (c === '"' && field === '') quoted = true;
      else if (c === delimiter) { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  let table = { header: [], rows: [], matches: [], shown: 0, filter: '' };
  const NUMERIC = /^-?[\d,]*\.?\d+(e[+-]?\d+)?%?$/i;

  async function renderTable(info) {
    const text = await fetchText(info.src);
    const nl = text.indexOf('\n');
    const firstLine = nl === -1 ? text : text.slice(0, nl);
    const delimiter = info.ext === '.tsv' ? '\t' : (firstLine.split(';').length > firstLine.split(',').length ? ';' : ',');
    const rows = parseCsv(text, delimiter).map((row, index) => ({ row, index }));
    const header = rows.shift()?.row ?? [];
    table = { header, rows, matches: rows, shown: 0, filter: '' };
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('th'), { className: 'rn' }));
    for (const cell of header) tr.append(Object.assign(document.createElement('th'), { textContent: cell, title: cell }));
    $('table').tHead.replaceChildren(tr);
    $('table').tBodies[0].replaceChildren();
    appendRows(1000);
  }

  function appendRows(count) {
    const frag = document.createDocumentFragment();
    const end = Math.min(table.matches.length, table.shown + count);
    const q = table.filter.toLowerCase();
    const cols = table.header.length;
    for (let i = table.shown; i < end; i++) {
      const { row, index } = table.matches[i];
      const tr = document.createElement('tr');
      tr.append(Object.assign(document.createElement('td'), { className: 'rn', textContent: String(index + 1) }));
      for (let c = 0; c < Math.max(row.length, cols); c++) {
        const value = row[c] ?? '';
        const td = document.createElement('td');
        if (NUMERIC.test(value.trim())) td.className = 'num';
        if (value.length > 40) td.title = value;
        const at = q ? value.toLowerCase().indexOf(q) : -1;
        if (at !== -1) {
          td.append(value.slice(0, at), Object.assign(document.createElement('mark'), { textContent: value.slice(at, at + q.length) }), value.slice(at + q.length));
        } else td.textContent = value;
        tr.append(td);
      }
      frag.append(tr);
    }
    $('table').tBodies[0].append(frag);
    table.shown = end;
    const left = table.matches.length - table.shown;
    $('table-more').hidden = left <= 0;
    $('table-more').querySelector('button').textContent = L(`显示更多（还有 ${left} 行）`, `Show more (${left} rows left)`);
  }

  function filterTable(query) {
    table.filter = query;
    const q = query.toLowerCase();
    table.matches = q ? table.rows.filter(({ row }) => row.some((v) => v.toLowerCase().includes(q))) : table.rows;
    table.shown = 0;
    $('table').tBodies[0].replaceChildren();
    appendRows(1000);
    setFindCount(null, q ? table.matches.length : null, L('行', 'rows'));
  }

  let textMarks = [];
  let textIndex = -1;
  let textSource = '';

  async function renderText(info) {
    textSource = await fetchText(info.src);
    $('text').textContent = textSource;
  }

  function findText(query, step = 0) {
    const pre = $('text');
    if (step === 0) {
      textMarks = [];
      textIndex = -1;
      if (!query) { pre.textContent = textSource; return setFindCount(); }
      const lower = textSource.toLowerCase();
      const q = query.toLowerCase();
      const frag = document.createDocumentFragment();
      let pos = 0;
      for (let at = lower.indexOf(q); at !== -1 && textMarks.length < 2000; at = lower.indexOf(q, at + q.length)) {
        frag.append(textSource.slice(pos, at));
        const mark = Object.assign(document.createElement('mark'), { textContent: textSource.slice(at, at + q.length) });
        textMarks.push(mark);
        frag.append(mark);
        pos = at + q.length;
      }
      frag.append(textSource.slice(pos));
      pre.replaceChildren(frag);
      step = 1;
    }
    if (!textMarks.length) return setFindCount(0, 0);
    textMarks[textIndex]?.classList.remove('current');
    textIndex = (textIndex + step + textMarks.length) % textMarks.length;
    textMarks[textIndex].classList.add('current');
    textMarks[textIndex].scrollIntoView({ block: 'center' });
    setFindCount(textIndex + 1, textMarks.length);
  }

  let fontScale = 1;
  let fontCounter = 0;

  async function renderFont(info) {
    const family = `PreviewFont${++fontCounter}`;
    const face = new FontFace(family, `url("${info.src}")`);
    try {
      await face.load();
    } catch {
      throw new Error(L('字体文件无法解析。', 'The font file can\'t be read.'));
    }
    document.fonts.add(face);
    $('font-view').style.fontFamily = `"${family}", system-ui`;
    fontScale = 1;
    drawFontSizes();
  }

  function drawFontSizes() {
    const text = $('font-input').value || 'Aa';
    $('font-sizes').replaceChildren(...[12, 16, 24, 36, 48, 72].map((size) => {
      const row = document.createElement('div');
      const sample = Object.assign(document.createElement('span'), { className: 'sample', textContent: text });
      sample.style.fontSize = `${size * fontScale}px`;
      row.append(Object.assign(document.createElement('span'), { className: 'size', textContent: String(size) }), sample);
      return row;
    }));
    $('font-view').querySelector('.font-hero').style.fontSize = `${96 * fontScale}px`;
    $('zoom-label').textContent = `${Math.round(fontScale * 100)}%`;
  }

  let archiveEntries = [];

  function renderArchive(info) {
    const { entries, count, total, truncated } = info.listing;
    archiveEntries = entries;
    const files = entries.filter((e) => !e.dir).length;
    const parts = [L(`${files} 个文件`, `${files} files`)];
    if (count > files) parts.push(L(`${count - files} 个文件夹`, `${count - files} folders`));
    parts.push(L(`解压后约 ${formatSize(total)}`, `~${formatSize(total)} unpacked`));
    if (truncated) parts.push(L('仅显示前 5000 项', 'showing first 5000'));
    $('archive-summary').textContent = parts.join(' · ');
    drawArchive('');
  }

  function drawArchive(query) {
    const q = query.toLowerCase();
    const list = archiveEntries.filter((e) => !q || e.name.toLowerCase().includes(q)).slice(0, 3000);
    $('archive-list').replaceChildren(...list.map((entry) => {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row';
      const parts = entry.name.replace(/\/$/, '').split('/');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('row-icon');
      icon.innerHTML = `<use href="#${entry.dir ? 'i-folder' : 'i-file'}"/>`;
      const main = Object.assign(document.createElement('span'), { className: 'row-main' });
      main.append(
        Object.assign(document.createElement('span'), { className: 'row-name', textContent: parts.at(-1) }),
        Object.assign(document.createElement('span'), { className: 'row-sub', textContent: parts.slice(0, -1).join(' / ') || L('根目录', 'root') }),
      );
      row.append(icon, main, Object.assign(document.createElement('span'), { className: 'row-side', textContent: entry.dir ? '' : formatSize(entry.size) }));
      li.append(row);
      return li;
    }));
    if (q) setFindCount(null, list.length, L('项', 'items'));
  }

  const RENDER = {
    pdf: renderPdf, image: renderImage, video: renderVideo, audio: renderAudio,
    table: renderTable, text: renderText, font: renderFont, archive: renderArchive,
  };

  // ---------------------------------------------------------------------------
  // Find (PDF uses pdf.js; table/archive filter; text highlights)
  // ---------------------------------------------------------------------------

  function openFind() {
    if (!['pdf', 'table', 'text', 'archive'].includes(currentView)) return;
    $('find-bar').classList.remove('out');
    $('find-bar').hidden = false;
    $('find-input').placeholder = { pdf: L('在文档中查找', 'Find in document'), table: L('筛选行', 'Filter rows'), text: L('查找', 'Find'), archive: L('筛选文件', 'Filter files') }[currentView];
    $('find-input').select();
    $('find-input').focus();
    wake();
  }

  function closeFind() {
    const bar = $('find-bar');
    if (bar.hidden || bar.classList.contains('out')) return;
    bar.classList.add('out');
    const done = () => { bar.hidden = true; bar.classList.remove('out'); };
    bar.addEventListener('animationend', done, { once: true });
    setTimeout(() => { if (bar.classList.contains('out')) done(); }, 200);
    const had = $('find-input').value;
    $('find-input').value = '';
    setFindCount();
    if (currentView === 'pdf') eventBus?.dispatch('findbarclose', { source: null });
    if (had && currentView === 'table') filterTable('');
    if (had && currentView === 'archive') drawArchive('');
    if (had && currentView === 'text') findText('');
    if (currentView) $(VIEWS[currentView]).focus({ preventScroll: true });
  }

  function runFind(step = 0) {
    const query = $('find-input').value;
    if (currentView === 'pdf') {
      eventBus.dispatch('find', {
        source: null, type: step === 0 ? '' : 'again', query, caseSensitive: false, entireWord: false,
        highlightAll: true, findPrevious: step < 0, matchDiacritics: false,
      });
    } else if (currentView === 'table' && step === 0) filterTable(query);
    else if (currentView === 'archive' && step === 0) drawArchive(query);
    else if (currentView === 'text') findText(query, step);
  }

  function setFindCount(index, total, unit) {
    const q = $('find-input').value;
    $('find-bar').classList.toggle('not-found', !!q && total === 0);
    $('find-count').textContent = !q || total == null ? '' : unit ? `${total} ${unit}` : total ? `${index ?? 0}/${total}` : L('无结果', 'No results');
  }

  // ---------------------------------------------------------------------------
  // Zoom (shared dock buttons)
  // ---------------------------------------------------------------------------

  function zoom(direction) {
    if (currentView === 'pdf' && viewer) viewer.updateScale({ steps: direction });
    else if (currentView === 'image') zoomImage(direction > 0 ? 1.25 : 0.8, null, null, true);
    else if (currentView === 'font') { fontScale = Math.min(3, Math.max(0.5, fontScale * (direction > 0 ? 1.2 : 1 / 1.2))); drawFontSizes(); }
  }

  function zoomReset() {
    if (currentView === 'pdf' && viewer) viewer.currentScaleValue = viewer.currentScaleValue === 'page-fit' ? 'page-width' : 'page-fit';
    else if (currentView === 'image') { if (img.fit) zoomImage(1 / img.scale, null, null, true); else fitImage(); }
    else if (currentView === 'font') { fontScale = 1; drawFontSizes(); }
  }

  // ---------------------------------------------------------------------------
  // Library & switcher
  // ---------------------------------------------------------------------------

  const lib = { conversation: [], workspace: [], group: 'all', query: '', loaded: false };

  async function loadConversationFiles() {
    if (!sidecar?.conversationId) return;
    try {
      lib.conversation = (await callApi('/api/conversation-files', { conversationId: sidecar.conversationId })).files;
    } catch { /* optional */ }
  }

  async function loadWorkspaceFiles(uris) {
    if (!uris.length) { lib.workspace = []; return; }
    try {
      lib.workspace = (await callApi('/api/list', { uris })).files;
    } catch { lib.workspace = []; }
  }

  function matchesFilter(file, query, group) {
    if (group !== 'all' && file.group !== group) return false;
    return !query || `${file.name} ${file.dir ?? ''}`.toLowerCase().includes(query);
  }

  const dirLabel = (dir) => (dir === '对话产物' ? L('对话产物', 'Agent artifacts') : dir || '');

  function fileRow(file, { compact = false, onPick } = {}) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `row${current?.path === file.path ? ' current' : ''}`;
    btn.title = file.path;
    const main = Object.assign(document.createElement('span'), { className: 'row-main' });
    main.append(
      Object.assign(document.createElement('span'), { className: 'row-name', textContent: file.name }),
      Object.assign(document.createElement('span'), { className: 'row-sub', textContent: compact ? dirLabel(file.dir) : `${dirLabel(file.dir) || L('工作区根目录', 'workspace root')} · ${formatAgo(file.mtime)}` }),
    );
    btn.append(makeTile(file), main, Object.assign(document.createElement('span'), { className: 'row-side', textContent: formatSize(file.size) }));
    btn.addEventListener('click', () => onPick(file));
    li.append(btn);
    return li;
  }

  function renderLibrary() {
    const q = lib.query.toLowerCase();
    const seen = new Set();
    const sections = [];
    for (const [title, list] of [[L('本对话', 'This conversation'), lib.conversation], [L('工作区', 'Workspace'), lib.workspace]]) {
      const items = list.filter((f) => !seen.has(f.path) && matchesFilter(f, q, lib.group));
      items.forEach((f) => seen.add(f.path));
      if (!items.length) continue;
      const head = document.createElement('div');
      head.className = 'section-title';
      head.append(title, Object.assign(document.createElement('span'), { className: 'count', textContent: String(items.length) }));
      const ul = document.createElement('ul');
      ul.className = 'rows';
      ul.append(...items.slice(0, 400).map((f) => fileRow(f, { onPick: (file) => openFile(file.path, { fromList: true }) })));
      sections.push(head, ul);
    }
    $('lib-sections').replaceChildren(...sections);
    const empty = $('library-empty');
    empty.hidden = sections.length > 0;
    const filtered = q || lib.group !== 'all';
    const strong = document.createElement('strong');
    strong.textContent = !lib.loaded ? L('正在查找文件…', 'Finding files…') : filtered ? L('没有匹配的文件', 'No matching files') : L('还没有可预览的文件', 'No previewable files yet');
    empty.replaceChildren(strong, !lib.loaded || filtered ? '' : L('对话里出现的 PDF、Office、表格、音视频等文件会显示在这里。', 'PDFs, Office files, spreadsheets and media from the conversation show up here.'));
  }

  async function showLibrary() {
    ++openToken;
    resetViews();
    current = null;
    fromLibrary = false;
    const url = new URL(location.href);
    url.searchParams.delete('file');
    history.replaceState(null, '', url);
    hideStatus();
    showView('library');
    renderLibrary();
    if (!lib.loaded) {
      await loadConversationFiles();
      lib.loaded = true;
      renderLibrary();
    }
  }

  function openSwitcher() {
    const pop = $('switch-pop');
    $('switch-filter').value = '';
    drawSwitcher();
    openPopover(pop, $('switcher'));
    $('switch-filter').focus();
    if (!lib.loaded) {
      loadConversationFiles().then(() => {
        lib.loaded = true;
        if (!pop.hidden) { drawSwitcher(); openPopover(pop, $('switcher')); }
      });
    }
  }

  function drawSwitcher() {
    const q = $('switch-filter').value.toLowerCase();
    const seen = new Set();
    const files = [...lib.conversation, ...lib.workspace].filter((f) => !seen.has(f.path) && seen.add(f.path) && matchesFilter(f, q, 'all'));
    const list = $('switch-list');
    list.replaceChildren(...files.slice(0, 200).map((f) => fileRow(f, {
      compact: true,
      onPick: (file) => { closePopovers(); openFile(file.path, { fromList: fromLibrary }); },
    })));
    if (!files.length) {
      list.append(Object.assign(document.createElement('li'), { className: 'empty', textContent: lib.loaded ? L('没有其他文件', 'No other files') : L('正在加载…', 'Loading…') }));
    }
  }


  // Static page text (index.html is written in Chinese).
  const STATIC_EN = {
      "文件预览": "File Preview",
      "显示更多行": "Show more rows",
      "全部": "All",
      "文档": "Docs",
      "表格": "Sheets",
      "图片": "Images",
      "音视频": "Media",
      "其他": "Other",
      "用默认应用打开": "Open in default app",
      "在 Finder 中显示": "Show in Finder",
      "夜间阅读": "Night reading",
      "复制文件路径": "Copy file path",
      "在对话中提及此文件": "Mention in conversation",
      "播放": "Play",
      "播放进度": "Playback position",
      "播放/暂停": "Play/Pause",
      "静音": "Mute",
      "音量": "Volume",
      "播放速度": "Playback speed",
      "循环播放": "Loop",
      "画中画": "Picture in picture",
      "后退 10 秒": "Back 10 s",
      "前进 10 秒": "Forward 10 s",
      "预览文字": "Preview text",
      "搜索文件": "Search files",
      "返回文件列表": "Back to file list",
      "切换文件": "Switch file",
      "页面缩略图": "Page thumbnails",
      "页码": "Page number",
      "缩小 (⌘−)": "Zoom out (⌘−)",
      "点击切换：适合宽度 / 适合页面": "Click: fit width / fit page",
      "放大 (⌘+)": "Zoom in (⌘+)",
      "旋转 (R)": "Rotate (R)",
      "查找 (⌘F)": "Find (⌘F)",
      "更多": "More",
      "本对话的文件": "Files in this conversation",
      "查找": "Find",
      "上一个 (⇧↩)": "Previous (⇧↩)",
      "下一个 (↩)": "Next (↩)",
      "关闭 (Esc)": "Close (Esc)",
      "点开对话或文件树里的文档、表格、媒体文件，会直接在这里打开。": "Documents, spreadsheets and media you open from the conversation or file tree appear here.",
      "搜索工作区文件": "Search workspace files",
      "用默认应用打开 ": "Open in default app",
      "在 Finder 中显示 ": "Show in Finder"
  };
  const originals = new WeakMap();
  function translateStatic() {
    const swap = (value) => (locale === 'en' ? STATIC_EN[value.trim()] : null);
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      if (n.parentElement?.closest('#lib-sections, #file-list, #switch-list, #table, #text, #archive-list, .font-sizes, .font-glyphs, .font-hero, #menu-info, #status, #audio-name, #audio-meta, #toast')) continue;
      if (!originals.has(n)) originals.set(n, n.textContent);
      const orig = originals.get(n);
      const en = swap(orig);
      n.textContent = en ? orig.replace(orig.trim(), en) : orig;
    }
    for (const el of document.querySelectorAll('[title],[placeholder],[aria-label]')) {
      for (const attr of ['title', 'placeholder', 'aria-label']) {
        if (!el.hasAttribute(attr)) continue;
        const key = `data-zh-${attr}`;
        if (!el.hasAttribute(key)) el.setAttribute(key, el.getAttribute(attr));
        const orig = el.getAttribute(key);
        el.setAttribute(attr, swap(orig) ?? orig);
      }
    }
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }

  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'agy-locale') return;
    const next = /^zh/i.test(event.data.locale || '') ? 'zh' : 'en';
    try { sessionStorage.setItem('agy-locale', next); } catch { /* ignore */ }
    if (next === locale) return;
    locale = next;
    translateStatic();
    if (currentView === 'library') renderLibrary();
    if (!$('switch-pop').hidden) drawSwitcher();
  });

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function init() {
    translateStatic();
    try { if (localStorage.getItem('night')) $('stage').classList.add('night'); } catch { /* ignore */ }

    $('back').addEventListener('click', showLibrary);
    $('switcher').addEventListener('click', () => ($('switch-pop').hidden ? openSwitcher() : closePopovers()));
    $('switch-filter').addEventListener('input', drawSwitcher);
    $('more').addEventListener('click', () => ($('menu').hidden ? openMenu() : closePopovers()));
    for (const item of $$('[data-menu]')) item.addEventListener('click', () => menuAction(item.dataset.menu));
    $('status-open').addEventListener('click', () => reveal('open'));
    $('status-reveal').addEventListener('click', () => reveal('reveal'));

    $('thumbs-toggle').addEventListener('click', toggleThumbs);
    $('page').addEventListener('focus', (e) => e.target.select());
    $('page').addEventListener('change', (e) => {
      const n = Number.parseInt(e.target.value, 10);
      if (viewer && n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
      else if (viewer) e.target.value = String(viewer.currentPageNumber);
    });
    $('zoom-in').addEventListener('click', () => zoom(1));
    $('zoom-out').addEventListener('click', () => zoom(-1));
    $('zoom-label').addEventListener('click', zoomReset);
    $('rotate').addEventListener('click', () => { img.rot = (img.rot + 90) % 360; fitImage(); });
    $('font-input').addEventListener('input', drawFontSizes);
    $('table-more').querySelector('button').addEventListener('click', () => appendRows(2000));

    $('find-toggle').addEventListener('click', () => ($('find-bar').hidden ? openFind() : closeFind()));
    $('find-close').addEventListener('click', closeFind);
    $('find-input').addEventListener('input', () => runFind(0));
    $('find-bar').addEventListener('submit', (e) => { e.preventDefault(); runFind(1); });
    $('find-prev').addEventListener('click', () => runFind(-1));
    $('find-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); runFind(-1); }
    });

    $('filter').addEventListener('input', (e) => { lib.query = e.target.value; renderLibrary(); });
    for (const chip of $$('.chip')) {
      chip.addEventListener('click', () => {
        lib.group = chip.dataset.group;
        for (const c of $$('.chip')) c.setAttribute('aria-selected', String(c === chip));
        renderLibrary();
      });
    }

    setupImageInteractions();
    setupMedia($('video'), $('video-view'));
    setupMedia($('audio'), $('audio-view'));
    new ResizeObserver(drawWave).observe($('wave-canvas'));

    document.addEventListener('pointermove', wake, { passive: true });
    document.addEventListener('keydown', (event) => {
      const mod = event.metaKey || event.ctrlKey;
      wake();
      if (event.key === 'Escape') {
        if ($$('.popover').some((p) => !p.hidden)) closePopovers();
        else closeFind();
        return;
      }
      if (mod && event.key === 'f') { event.preventDefault(); openFind(); return; }
      if (mod && (event.key === '=' || event.key === '+')) { event.preventDefault(); zoom(1); return; }
      if (mod && event.key === '-') { event.preventDefault(); zoom(-1); return; }
      if (mod && event.key === '0') {
        event.preventDefault();
        if (currentView === 'pdf' && viewer) viewer.currentScaleValue = 'auto';
        else if (currentView === 'image') fitImage();
        return;
      }
      if (event.target.closest('input, textarea')) return;
      if (mediaKeys(event)) { event.preventDefault(); return; }
      if (currentView === 'image' && event.key.toLowerCase() === 'r') { img.rot = (img.rot + 90) % 360; fitImage(); }
      else if (currentView === 'image' && event.key === '0') fitImage();
    });

    // Workspace files feed the library and the switcher.
    sidecar?.onWorkspaceChange(async (uris) => {
      await loadWorkspaceFiles(uris);
      if (currentView === 'library') renderLibrary();
    });

    const file = new URLSearchParams(location.search).get('file');
    if (file) openFile(file);
    else showLibrary();
  }

  init();
})();
