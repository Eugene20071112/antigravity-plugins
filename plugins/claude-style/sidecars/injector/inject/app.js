// Injected into the Antigravity window by the claude-style sidecar (see
// main.mjs). Talks to the sidecar through a DevTools binding; everything it
// adds is removed again by window.__claudeStyleUnload().

const BINDING = window.__CLAUDE_STYLE_BINDING__;
const cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Language: Chinese when the 中文汉化包 plugin is on (it sets data-agy-locale),
// otherwise follow the system language Antigravity runs with.
function currentLocale() {
  const forced = document.documentElement.dataset.agyLocale;
  if (forced) return /^zh/i.test(forced) ? 'zh' : 'en';
  return /^zh/i.test(navigator.language) ? 'zh' : 'en';
}
let locale = currentLocale();
const L = (zh, en) => (locale === 'zh' ? zh : en);

// ---------------------------------------------------------------------------
// Bridge to the sidecar
// ---------------------------------------------------------------------------

let callId = 0;
const pending = new Map();
window.__claudeStyleReply = (id, reply) => {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (reply.ok) p.resolve(reply.data);
  else p.reject(new Error(reply.error));
};
function call(cmd, args) {
  const fn = window[BINDING];
  if (typeof fn !== 'function') return Promise.reject(new Error(L('Claude 风格插件未连接', 'Claude Style plugin not connected')));
  const id = ++callId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    fn(JSON.stringify({ id, cmd, args, lang: locale }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(L('请求超时', 'Request timed out')));
    }, 130000);
  });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child.nodeType ? child : String(child));
  return el;
}

const ICONS = {
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="7" r="2"/><path d="M6 7v10M18 9c0 4-6 3-11.5 8"/>',
  folder: '<path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
  spark: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4"/>',
  sliders: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  close: '<path d="m7 7 10 10M17 7 7 17"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  pr: '<circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4M13 3l-3 3 3 3"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  term: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3M13 15h4"/>',
  finder: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v16M8 9v1.5M16 9v1.5M8 15c2.5 1.5 5.5 1.5 8 0"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10"/>',
};
const icon = (name, cls = '') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  if (cls) s.setAttribute('class', cls);
  s.innerHTML = ICONS[name] || '';
  return s;
};

const fmt = (n) => (n >= 1e6 ? `${(n / 1048576 > 0.99 && n / 1048576 < 1.01 ? 1 : +(n / 1e6).toFixed(1))}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
const isMac = /Mac/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

let toastTimer;
function toast(message, error = false) {
  $$('.cs-toast').forEach((t) => t.remove());
  const el = h('div', { class: `cs-ui cs-toast${error ? ' err' : ''}`, role: 'status' }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => animateOut(el, 'cs-out', () => el.remove()), error ? 5000 : 2400);
}

function cascadeId() {
  return /\/c\/([0-9a-f-]{36})/i.exec(location.pathname)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Popovers
// ---------------------------------------------------------------------------

let openPop = null;

// Animate an element out with a CSS class, then run `done` (with a fallback
// in case animations are disabled or the window is in the background).
function animateOut(el, cls, done) {
  if (!el?.isConnected) return done?.();
  let finished = false;
  const finish = () => { if (finished) return; finished = true; done?.(); };
  el.classList.add(cls);
  el.addEventListener('animationend', finish, { once: true });
  setTimeout(finish, 260);
}

function closePop() {
  if (!openPop) return;
  const { el, anchor } = openPop;
  openPop = null;
  anchor?.setAttribute('aria-expanded', 'false');
  animateOut(el, 'cs-out', () => el.remove());
}

// Popovers grow out of the button that opened them and shrink back into it.
function showPop(anchor, content, { cls = '', align = 'end', above = false, width = null } = {}) {
  if (openPop?.anchor === anchor) return closePop();
  closePop();
  const el = h('div', { class: `cs-ui cs-pop ${cls}` }, content);
  if (width) el.style.width = `${width}px`;
  document.body.append(el);
  const a = anchor.getBoundingClientRect();
  // offset* ignores the opening scale animation; getBoundingClientRect would not.
  const r = { width: el.offsetWidth, height: el.offsetHeight };
  let left = align === 'end' ? a.right - r.width : a.left;
  left = Math.max(8, Math.min(left, innerWidth - r.width - 8));
  // Never cover the button that opened it: pick the side with room (preferring
  // the requested one) and let the popover scroll if it is still too tall.
  const roomAbove = a.top - 16;
  const roomBelow = innerHeight - a.bottom - 16;
  const fromBelow = above ? (r.height <= roomAbove || roomAbove >= roomBelow) : (r.height > roomBelow && roomAbove > roomBelow);
  const room = fromBelow ? roomAbove : roomBelow;
  if (r.height > room) el.style.maxHeight = `${Math.max(160, room)}px`;
  const height = Math.min(r.height, Math.max(160, room));
  const top = fromBelow ? a.top - 8 - height : a.bottom + 6;
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(8, top)}px`;
  const ox = Math.min(r.width, Math.max(0, a.left + a.width / 2 - left));
  el.style.transformOrigin = `${ox}px ${fromBelow ? '100%' : '0%'}`;
  el.style.setProperty('--cs-dy', fromBelow ? '6px' : '-6px');
  anchor.setAttribute('aria-expanded', 'true');
  openPop = { el, anchor };
  return el;
}
const onDocDown = (e) => {
  if (openPop && !openPop.el.contains(e.target) && !openPop.anchor.contains(e.target)) closePop();
};
document.addEventListener('pointerdown', onDocDown, true);
const onResize = () => closePop();
window.addEventListener('resize', onResize);
onCleanup(() => { document.removeEventListener('pointerdown', onDocDown, true); window.removeEventListener('resize', onResize); });

// ---------------------------------------------------------------------------
// Settings & theme
// ---------------------------------------------------------------------------

let settings = { theme: true, serif: true, serifAll: true, cjkSerif: false, fontSize: 16, wide: false, usage: true, quota: true, accent: '#d97757', tone: 'warm' };

const style = h('style', { id: 'claude-style-css' }, window.__CLAUDE_STYLE_CSS__ || '');
document.head.append(style);
onCleanup(() => style.remove());

const ACCENTS = [
  { hex: '#d97757', zh: '陶土', en: 'Clay' },
  { hex: '#4c8dff', zh: '天蓝', en: 'Blue' },
  { hex: '#30a46c', zh: '翠绿', en: 'Green' },
  { hex: '#8e4ec6', zh: '紫罗兰', en: 'Violet' },
  { hex: '#e5487a', zh: '玫红', en: 'Rose' },
  { hex: '#e2a336', zh: '琥珀', en: 'Amber' },
  { hex: '#8b8d98', zh: '石墨', en: 'Graphite' },
];
const TONES = [
  { id: 'warm', zh: '暖灰', en: 'Warm' },
  { id: 'neutral', zh: '中性', en: 'Neutral' },
  { id: 'deep', zh: '纯黑/纯白', en: 'Pure' },
];

function applySettings() {
  const root = document.documentElement;
  root.classList.toggle('cs-on', !!settings.theme);
  root.classList.toggle('cs-serif', !!settings.serif);
  root.classList.toggle('cs-serif-all', !!settings.serifAll);
  root.classList.toggle('cs-cjk-serif', !!settings.cjkSerif);
  root.classList.toggle('cs-wide', !!settings.wide);
  root.style.setProperty('--cs-size', `${settings.fontSize}px`);
  for (const t of TONES) root.classList.toggle(`cs-tone-${t.id}`, settings.tone === t.id);
  const accent = /^#[0-9a-f]{6}$/i.test(settings.accent || '') ? settings.accent : '#d97757';
  root.style.setProperty('--cs-user-accent', accent);
  $('.cs-usage')?.toggleAttribute('hidden', !settings.usage);
  if (quota.card) quota.card.hidden = !settings.quota;
  syncPanels();
}
onCleanup(() => {
  const root = document.documentElement;
  root.classList.remove('cs-on', 'cs-serif', 'cs-serif-all', 'cs-cjk-serif', 'cs-wide', ...TONES.map((t) => `cs-tone-${t.id}`));
  root.style.removeProperty('--cs-size');
  root.style.removeProperty('--cs-user-accent');
});

async function setSetting(patch) {
  settings = { ...settings, ...patch };
  applySettings();
  try { settings = await call('settings.set', patch); } catch { /* keep local */ }
}

// Plugin panels (sidecar iframes) get theme tokens by postMessage; resend
// ours after the host's so panels match the skin.
const TOKENS = ['--background', '--foreground', '--primary', '--primary-foreground', '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground', '--placeholder', '--sidebar', '--sidebar-secondary', '--sidebar-muted', '--content',
  '--card', '--card-border', '--border', '--accent'];
function syncPanels() {
  const cs = getComputedStyle(document.documentElement);
  const cssVariables = {};
  for (const t of TOKENS) {
    const v = cs.getPropertyValue(t).trim();
    if (v) cssVariables[t] = v;
  }
  for (const frame of $$('iframe[data-testid="sidecar-iframe"]')) {
    try {
      frame.contentWindow?.postMessage({ type: 'theme-change', payload: { cssVariables } }, '*');
      frame.contentWindow?.postMessage({ type: 'agy-locale', locale }, '*');
    } catch { /* gone */ }
  }
}
const onFrameLoad = (e) => {
  if (e.target?.matches?.('iframe[data-testid="sidecar-iframe"]')) setTimeout(syncPanels, 400);
};
document.addEventListener('load', onFrameLoad, true);
onCleanup(() => document.removeEventListener('load', onFrameLoad, true));
const themeObserver = new MutationObserver(() => setTimeout(syncPanels, 50));
themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
onCleanup(() => themeObserver.disconnect());

function colorPicker() {
  const row = h('div', { class: 'cs-swatches' });
  const custom = h('input', { type: 'color', class: 'cs-swatch-input', value: settings.accent || '#d97757', title: L('自定义颜色', 'Custom color') });
  const mark = () => {
    for (const b of row.querySelectorAll('.cs-swatch')) b.setAttribute('aria-pressed', String(b.dataset.hex === settings.accent));
    customWrap.setAttribute('aria-pressed', String(!ACCENTS.some((x) => x.hex === settings.accent)));
    customWrap.style.setProperty('--sw', settings.accent);
  };
  for (const acc of ACCENTS) {
    const b = h('button', { type: 'button', class: 'cs-swatch', title: L(acc.zh, acc.en), style: `--sw:${acc.hex}`, 'data-hex': acc.hex });
    b.addEventListener('click', () => { setSetting({ accent: acc.hex }); custom.value = acc.hex; mark(); });
    row.append(b);
  }
  const customWrap = h('label', { class: 'cs-swatch custom', title: L('自定义颜色', 'Custom color') }, custom);
  custom.addEventListener('input', () => { settings.accent = custom.value; applySettings(); mark(); });
  custom.addEventListener('change', () => { setSetting({ accent: custom.value }); mark(); });
  row.append(customWrap);
  mark();
  return h('div', { class: 'cs-row' }, h('label', {}, L('强调色', 'Accent')), row);
}

function toneSeg() {
  const seg = h('div', { class: 'cs-seg' }, TONES.map((t) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(settings.tone === t.id) }, L(t.zh, t.en));
    b.addEventListener('click', () => {
      setSetting({ tone: t.id });
      for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b));
    });
    return b;
  }));
  return h('div', { class: 'cs-row' }, h('label', {}, L('背景色调', 'Background')), seg);
}

function settingsPopover(anchor) {
  const sw = (key, label, hint) => {
    const id = `cs-${key}`;
    const input = h('input', { type: 'checkbox', class: 'cs-switch', id });
    input.checked = !!settings[key];
    input.addEventListener('change', () => setSetting({ [key]: input.checked }));
    return h('div', { class: 'cs-row' }, h('label', { for: id }, label, hint ? h('span', { class: 'cs-hint' }, hint) : null), input);
  };
  const sizes = [14, 15, 16, 17, 18];
  const seg = h('div', { class: 'cs-seg' }, sizes.map((s) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(settings.fontSize === s) }, String(s));
    b.addEventListener('click', () => {
      setSetting({ fontSize: s });
      for (const x of seg.children) x.setAttribute('aria-pressed', String(x === b));
    });
    return b;
  }));
  const shortcut = (keys, label) => h('div', { class: 'cs-item', style: 'cursor:default' }, label, h('span', { class: 'cs-kbd' }, keys));
  // Language pack switch (only when the antigravity-zh plugin is installed).
  let zhRow = null;
  if (window.__agyZh) {
    const input = h('input', { type: 'checkbox', class: 'cs-switch', id: 'cs-zh' });
    input.checked = !!window.__agyZh.enabled;
    input.addEventListener('change', () => { closePop(); window.__agyZh.setEnabled(input.checked); });
    zhRow = h('div', { class: 'cs-row' }, h('label', { for: 'cs-zh' }, L('中文界面', 'Chinese interface'), h('span', { class: 'cs-hint' }, L('汉化包：把 Antigravity 界面翻译成中文', 'Language pack: translate Antigravity into Chinese'))), input);
  }
  showPop(anchor, [
    h('div', { class: 'cs-pop-title' }, L('CLAUDE 风格', 'CLAUDE STYLE')),
    zhRow,
    sw('theme', L('Claude 配色', 'Claude colors'), L('暖色纸感浅色 / 炭灰深色，跟随 Antigravity 主题', 'Warm paper light / charcoal dark, follows Antigravity theme')),
    sw('serifAll', L('全局衬线字体', 'Serif everywhere'), L('整个界面使用 Claude 风格衬线字体', 'Use the Claude-style serif across the whole app')),
    sw('serif', L('回复使用衬线字体', 'Serif replies'), L('像 claude.ai 一样的阅读排版', 'Reading typography like claude.ai')),
    sw('cjkSerif', L('中文也用衬线（宋体）', 'Serif for Chinese too (Songti)')),
    sw('wide', L('宽版阅读', 'Wide reading column')),
    sw('usage', L('显示 TPS / 上下文用量', 'Show TPS / context usage')),
    sw('quota', L('侧边栏显示用量额度', 'Show quota in sidebar'), L('5 小时额度；本周额度快用完时自动切换', '5-hour quota; switches to weekly when it runs low')),
    h('div', { class: 'cs-row' }, h('label', {}, L('回复字号', 'Reply font size')), seg),
    h('div', { class: 'cs-sep' }),
    h('div', { class: 'cs-pop-title' }, L('配色', 'COLORS')),
    colorPicker(),
    toneSeg(),
    h('div', { class: 'cs-sep' }),
    h('div', { class: 'cs-pop-title' }, L('快捷键', 'Shortcuts')),
    shortcut(`${MOD}⇧G`, L('Git 面板', 'Git panel')),
    shortcut(`${MOD}⌥E`, L('在编辑器中打开工作区', 'Open workspace in editor')),
    shortcut(`${MOD}⌥U`, L('用量详情', 'Usage details')),
    shortcut(`${MOD}?`, L('Antigravity 全部快捷键', 'All Antigravity shortcuts')),
  ], { cls: 'cs-settings', align: 'end', width: 300 });
}

// ---------------------------------------------------------------------------
// Header buttons (next to "Open IDE")
// ---------------------------------------------------------------------------

let header = null;
function ensureHeader() {
  // Header actions: [⋮][Open IDE][Overview]; ours go before them.
  const anchor = $('[data-testid="titlebar-more-actions"]') ?? $('[data-testid^="open-editor"]');
  const host = anchor?.parentElement;
  if (!host) return;
  if (header && header.isConnected && header.parentElement === host) return;
  header?.remove();
  const gitBtn = h('button', { class: 'cs-hbtn', type: 'button', title: `Git（${MOD}⇧G）` }, icon('branch'), h('span', { class: 'cs-branch cs-label' }, 'Git'), h('span', { class: 'cs-badge', hidden: true }));
  gitBtn.addEventListener('click', () => toggleGit());
  const openBtn = h('button', { class: 'cs-hbtn', type: 'button', title: L(`打开方式（${MOD}⌥E 用编辑器打开）`, `Open in (${MOD}⌥E opens your editor)`) }, icon('folder'), h('span', { class: 'cs-label' }, L('打开', 'Open')), icon('chev', 'cs-chev'));
  openBtn.addEventListener('click', () => openInPopover(openBtn));
  const setBtn = h('button', { class: 'cs-hbtn icon', type: 'button', title: L('外观设置', 'Appearance') }, icon('sliders'));
  setBtn.addEventListener('click', () => settingsPopover(setBtn));
  header = h('div', { class: 'cs-ui cs-header' }, gitBtn, openBtn, setBtn);
  gitBtn.classList.add('cs-needs-convo');
  openBtn.classList.add('cs-needs-convo');
  host.insertBefore(header, anchor);
  refreshGitBadge();
}
onCleanup(() => header?.remove());

// ---------------------------------------------------------------------------
// "Open in" menu
// ---------------------------------------------------------------------------

let appsCache = null;
const APP_ICON = { finder: 'finder', terminal: 'term', iterm: 'term', warp: 'term', ghostty: 'term' };

// A conversation's workspace rarely changes; cache it for a minute.
const workspaceCache = new Map();
async function currentWorkspace() {
  const id = cascadeId();
  if (!id) return null;
  const hit = workspaceCache.get(id);
  if (hit && Date.now() - hit.at < 60000) return hit.path;
  try {
    const { path } = await call('workspace', { cascadeId: id });
    workspaceCache.set(id, { path, at: Date.now() });
    return path;
  } catch { return null; }
}

async function openInPopover(anchor) {
  const list = h('div', {}, h('div', { class: 'cs-pop-title' }, L('打开方式', 'Open in')), h('div', { class: 'cs-pop-sub' }, L('正在查找工作区…', 'Finding workspace…')));
  const pop = showPop(anchor, list, { align: 'end' });
  if (!pop) return;
  const [path, apps] = await Promise.all([currentWorkspace(), appsCache ?? call('apps').then((a) => (appsCache = a)).catch(() => [])]);
  if (!pop.isConnected) return;
  list.replaceChildren(h('div', { class: 'cs-pop-title' }, L('打开方式', 'Open in')));
  if (!path) {
    list.append(h('div', { class: 'cs-pop-sub' }, L('这个对话没有打开工作区。', 'This conversation has no workspace.')));
    return;
  }
  list.append(h('div', { class: 'cs-pop-sub', title: path }, path.replace(/^\/Users\/[^/]+/, '~')));
  for (const app of apps) {
    const item = h('button', { class: 'cs-item', type: 'button' }, icon(APP_ICON[app.id] ?? 'code', 'cs-ico'), app.id === 'terminal' ? L('终端', 'Terminal') : app.name);
    item.addEventListener('click', async () => {
      closePop();
      try { await call('openIn', { app: app.id, path }); } catch (err) { toast(err.message, true); }
    });
    list.append(item);
  }
  list.append(h('div', { class: 'cs-sep' }));
  const copy = h('button', { class: 'cs-item', type: 'button' }, icon('copy', 'cs-ico'), L('复制路径', 'Copy path'));
  copy.addEventListener('click', async () => {
    closePop();
    await navigator.clipboard.writeText(path).catch(() => {});
    toast(L('已复制路径', 'Path copied'));
  });
  list.append(copy);
}

async function openInDefaultEditor() {
  const path = await currentWorkspace();
  if (!path) return toast(L('这个对话没有打开工作区', 'This conversation has no workspace'), true);
  const apps = appsCache ?? (appsCache = await call('apps').catch(() => []));
  const editor = apps.find((a) => !['finder', 'terminal', 'iterm', 'warp', 'ghostty'].includes(a.id));
  try {
    await call('openIn', { app: editor?.id ?? 'finder', path });
    toast(L(`已在 ${editor?.name ?? 'Finder'} 中打开`, `Opened in ${editor?.name ?? 'Finder'}`));
  } catch (err) { toast(err.message, true); }
}

// ---------------------------------------------------------------------------
// Usage chip: client-observed reply reception rate and backend metadata.
// DOM character counts are deliberately not treated as token measurements.
// ---------------------------------------------------------------------------

let usageState = { id: null, data: null, status: null, steps: null, live: null, updated: 0, error: false };
let chip = null;

function ensureChip() {
  const trigger = $('[data-testid="model-selector-trigger"]');
  if (!trigger) return;
  if (chip && chip.isConnected && chip.previousElementSibling === trigger) return;
  chip?.remove();
  chip = h('button', { class: 'cs-ui cs-usage', type: 'button', title: L(`用量（${MOD}⌥U）`, `Usage (${MOD}⌥U)`) }, h('span', { class: 'cs-dot' }), h('span', { class: 'cs-usage-text' }, '—'));
  chip.addEventListener('click', () => usagePopover(chip));
  trigger.after(chip);
  chip.toggleAttribute('hidden', !settings.usage);
  renderChip();
}
onCleanup(() => chip?.remove());

const pct = (f) => `${f < 0.1 ? (f * 100).toFixed(1) : Math.round(f * 100)}%`;

function ring(fraction) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 20 20');
  s.setAttribute('class', 'cs-ring');
  const c = 2 * Math.PI * 7;
  const color = fraction > 0.85 ? 'var(--error)' : fraction > 0.6 ? 'var(--warning)' : 'var(--cs-acc)';
  s.innerHTML = `<circle cx="10" cy="10" r="7" stroke="currentColor" opacity=".25"/><circle cx="10" cy="10" r="7" stroke="${color}" stroke-dasharray="${c * fraction} ${c}" transform="rotate(-90 10 10)"/>`;
  return s;
}

function renderChip() {
  if (!chip) return;
  const text = chip.querySelector('.cs-usage-text');
  const last = usageState.id === cascadeId() ? usageState.data?.last : null;
  chip.title = L(`用量（${MOD}⌥U）`, `Usage (${MOD}⌥U)`);
  chip.classList.toggle('live', !!usageState.live);
  chip.querySelector('.cs-ring')?.remove();
  if (usageState.live) {
    text.textContent = L('生成中…', 'Generating…');
  } else if (usageState.error) {
    text.textContent = '—';
  } else if (last?.tps) {
    text.textContent = `${Math.round(last.tps)} tok/s`;
  } else {
    text.textContent = last ? `${fmt(last.output)} tok` : '—';
  }
  if (last?.contextMax && last?.contextUsed != null) {
    // contextMax is read from every generation, so it follows Antigravity's
    // own limit (and any change to it) automatically.
    const f = Math.min(1, last.contextUsed / last.contextMax);
    chip.append(ring(f));
    chip.title = L(`上下文 ${fmt(last.contextUsed)} / ${fmt(last.contextMax)}（${pct(f)}）· 超过后 Antigravity 会自动压缩旧内容 · ${MOD}⌥U 查看详情`, `Context ${fmt(last.contextUsed)} / ${fmt(last.contextMax)} (${pct(f)}) · Antigravity compacts older messages past the limit · ${MOD}⌥U for details`);
  }
}

const GROUP_COLORS = ['#d97757', '#6a9bcc', '#bcd1a2', '#c4a7e7', '#e3c07b', '#9ca3af'];
function usagePopover(anchor) {
  const data = usageState.id === cascadeId() ? usageState.data : null;
  const last = data?.last;
  if (!last) {
    showPop(anchor, h('div', { class: 'cs-pop-sub', style: 'padding:10px' }, L('这个对话还没有生成记录。', 'No generations in this conversation yet.')), { above: true, align: 'start' });
    return;
  }
  const stat = (value, label) => h('div', { class: 'cs-stat' }, h('b', {}, value), h('span', {}, label));
  const children = [
    h('h4', {}, L('最近一次生成', 'Last generation')),
    h('div', { class: 'cs-model' }, last.responseModel || ''),
    h('div', { class: 'cs-stats' },
      stat(last.tps ? `${Math.round(last.tps)}` : '—', L('tokens / 秒', 'tokens / sec')),
      stat(last.ttft != null ? `${last.ttft.toFixed(1)}s` : '—', L('首字延迟', 'Time to first token')),
      stat(fmt(last.output), L('输出 tokens', 'Output tokens'))),
  ];
  if (last.contextMax && last.contextUsed != null) {
    const used = last.contextUsed ?? 0;
    const max = last.contextMax;
    const groups = last.breakdown.length ? last.breakdown : [{ name: L('已用', 'Used'), tokens: used }];
    const meter = h('div', { class: 'cs-meter' }, groups.map((g, i) => h('i', { style: `width:${(g.tokens / max) * 100}%;background:${GROUP_COLORS[i % GROUP_COLORS.length]}` })));
    const NAMES = { 'System Prompt': L('系统提示', 'System prompt'), Tools: L('工具定义', 'Tools'), 'Chat Messages': L('对话消息', 'Messages') };
    children.push(
      h('h4', {}, L('上下文 ', 'Context '), h('span', { class: 'cs-ctx' }, `${fmt(used)} / ${fmt(max)}`), h('span', { class: 'cs-ctx-pct' }, pct(used / max))),
      meter,
      h('div', { class: 'cs-legend' }, groups.flatMap((g, i) => [
        h('span', { class: 'sw', style: `background:${GROUP_COLORS[i % GROUP_COLORS.length]}` }),
        h('span', {}, NAMES[g.name] ?? g.name),
        h('span', { class: 'v' }, `${fmt(g.tokens)} · ${pct(g.tokens / max)}`),
      ]), h('span', {}), h('span', {}, L('剩余', 'Left')), h('span', { class: 'v' }, fmt(Math.max(0, max - used)))),
      h('div', { class: 'cs-note' }, L(`上限 ${fmt(max)} 由 Antigravity 设定并随官方调整自动更新；用满后会自动压缩较早的对话。`, `The ${fmt(max)} limit comes from Antigravity and updates automatically; once full, older messages are compacted.`)),
    );
  }

  const t = data.totals;
  children.push(h('div', { class: 'cs-kv' },
    h('span', {}, L('本次输入 / 缓存命中', 'Input / cache hit')), h('span', {}, `${fmt(last.input)} / ${fmt(last.cacheRead)}`),
    h('span', {}, L('本次思考 / 回复', 'Thinking / reply')), h('span', {}, `${fmt(last.thinking)} / ${(last.response == null ? '—' : fmt(last.response))}`),
    h('span', {}, L('对话累计输出', 'Conversation output')), h('span', {}, L(`${fmt(t.output)} tokens · ${t.generations} 次生成`, `${fmt(t.output)} tokens · ${t.generations} generations`)),
    h('span', {}, L('对话累计输入', 'Conversation input')), h('span', {}, L(`${fmt(t.input)} + 缓存 ${fmt(t.cacheRead)}`, `${fmt(t.input)} + ${fmt(t.cacheRead)} cached`)),
    h('span', {}, L('平均速度', 'Average speed')), h('span', {}, t.streaming ? `${Math.round((t.streamedOutput ?? t.output) / t.streaming)} tok/s` : '—'),
  ));
  showPop(anchor, children, { cls: 'cs-usage-pop', above: true, align: 'start' });
}

// Refresh snapshots even when step count is unchanged: usage may arrive late.
let polling = false;
let pollCount = 0;
async function poll() {
  if (polling || (document.hidden && ++pollCount % 4 !== 0 && usageState.id === cascadeId())) return;
  polling = true;
  const id = cascadeId();
  const current = () => usageState.id === id && cascadeId() === id;
  try {
    if (id !== usageState.id) {
      if (openPop?.el.classList.contains('cs-usage-pop')) closePop();
      usageState = { id, data: null, status: null, steps: null, live: null, updated: 0, error: false };
      renderChip();
    }
    if (!id) return;
    const status = await call('status', { cascadeId: id }).catch(() => null);
    if (!current()) return;
    const changed = status && (status.steps !== usageState.steps || status.status !== usageState.status);
    usageState.live = status?.status === 'RUNNING' ? {} : null;
    usageState.status = status?.status;
    usageState.steps = status?.steps;
    if (changed || !usageState.updated || Date.now() - usageState.updated >= 5000) {
      try {
        const data = await call('usage', { cascadeId: id });
        if (!current()) return;
        usageState.data = data;
        usageState.updated = Date.now();
        usageState.error = false;
      } catch {
        if (!current()) return;
        usageState.error = true;
      }
      if (changed && !usageState.live) refreshQuota(true);
    }
    renderChip();
  } finally {
    polling = false;
  }
}

// ---------------------------------------------------------------------------
// Git drawer
// ---------------------------------------------------------------------------

let drawer = null;
let gitState = { dir: null, status: null, open: new Set(), busy: false };

async function gitCall(op, args = {}) {
  return call('git', { op, cwd: gitState.status?.root ?? gitState.dir, ...args });
}

async function refreshGitBadge() {
  const badge = header?.querySelector('.cs-badge');
  const label = header?.querySelector('.cs-branch');
  if (!badge) return;
  const dir = await currentWorkspace();
  if (!dir) { badge.hidden = true; label.textContent = 'Git'; return; }
  try {
    const st = await call('git', { op: 'status', cwd: dir });
    if (!st.repo) { badge.hidden = true; label.textContent = 'Git'; return; }
    label.textContent = st.branch || 'Git';
    badge.textContent = String(st.files.length);
    badge.hidden = st.files.length === 0;
  } catch { badge.hidden = true; }
}

function gitButton() { return header?.querySelector('.cs-hbtn'); }

function toggleGit() {
  if (drawer) return closeGit();
  closePop();
  drawer = h('div', { class: 'cs-ui cs-drawer', role: 'dialog', 'aria-label': 'Git' },
    h('div', { class: 'cs-dhead' }, icon('branch'), h('h3', {}, 'Git', h('span', { class: 'sub' }, L('正在读取…', 'Loading…')))),
    h('div', { class: 'cs-dbody' }, h('div', { class: 'cs-skel' }), h('div', { class: 'cs-skel' }), h('div', { class: 'cs-skel short' })));
  document.body.append(drawer);
  gitButton()?.setAttribute('aria-expanded', 'true');
  loadGit();
}
function closeGit() {
  const el = drawer;
  drawer = null;
  gitButton()?.setAttribute('aria-expanded', 'false');
  animateOut(el, 'cs-out', () => el?.remove());
  refreshGitBadge();
}
onCleanup(() => drawer?.remove());

async function loadGit() {
  if (!drawer) return;
  gitState.dir = await currentWorkspace();
  if (!gitState.dir) {
    renderGit(null, L('这个对话没有打开工作区', 'This conversation has no workspace'));
    return;
  }
  try {
    gitState.status = await call('git', { op: 'status', cwd: gitState.dir });
    renderGit(gitState.status);
  } catch (err) {
    renderGit(null, err.message);
  }
}

async function gitAction(btn, op, args, done) {
  if (gitState.busy) return;
  gitState.busy = true;
  btn?.classList.add('spin');
  if (btn) btn.disabled = true;
  try {
    const res = await gitCall(op, args);
    if (done) toast(done);
    gitState.status = await gitCall('status');
    renderGit(gitState.status);
    return res;
  } catch (err) {
    toast(err.message, true);
  } finally {
    gitState.busy = false;
    if (btn?.isConnected) { btn.disabled = false; btn.classList.remove('spin'); }
  }
}

function renderGit(st, problem) {
  if (!drawer) return;
  const close = h('button', { class: 'cs-ibtn', type: 'button', title: L('关闭 (Esc)', 'Close (Esc)') }, icon('close'));
  close.addEventListener('click', closeGit);
  const reload = h('button', { class: 'cs-ibtn', type: 'button', title: L('刷新', 'Refresh') }, icon('refresh'));
  reload.addEventListener('click', () => loadGit());
  const name = st?.root?.split('/').pop() ?? 'Git';
  const head = h('div', { class: 'cs-dhead' }, icon('branch'),
    h('h3', {}, name, h('span', { class: 'sub' }, (st?.root ?? gitState.dir ?? '').replace(/^\/Users\/[^/]+/, '~'))), reload, close);

  if (!st?.repo) {
    const body = h('div', { class: 'cs-dbody' });
    if (problem) body.append(h('div', { class: 'cs-empty' }, h('b', {}, L('无法读取', 'Couldn\'t read')), problem));
    else {
      const init = h('button', { class: 'cs-btn primary', type: 'button' }, L('初始化 Git 仓库', 'Initialize Git repository'));
      init.addEventListener('click', async () => {
        try { await call('git', { op: 'init', cwd: gitState.dir }); toast(L('已初始化', 'Initialized')); loadGit(); } catch (err) { toast(err.message, true); }
      });
      body.append(h('div', { class: 'cs-empty' }, h('b', {}, L('不是 Git 仓库', 'Not a Git repository')), h('div', { style: 'margin:6px 0 14px' }, L('这个工作区还没有版本管理。', 'This workspace isn\'t under version control yet.')), init));
    }
    drawer.replaceChildren(head, body);
    return;
  }

  // Branch / sync bar
  const branchBtn = h('button', { class: 'cs-chip', type: 'button' }, icon('branch'), st.branch ?? '(detached)', icon('chev', 'cs-chev'));
  branchBtn.addEventListener('click', () => branchPopover(branchBtn));
  const pull = h('button', { class: 'cs-chip', type: 'button', title: 'git pull --ff-only' }, icon('down'), L('拉取', 'Pull'), st.behind ? h('span', { class: 'n' }, String(st.behind)) : null);
  pull.addEventListener('click', () => gitAction(pull, 'pull', {}, L('已拉取', 'Pulled')));
  const push = h('button', { class: 'cs-chip', type: 'button', title: st.upstream ? L(`推送到 ${st.upstream}`, `Push to ${st.upstream}`) : '推送并设置上游分支' }, icon('up'), L('推送', 'Push'), st.ahead ? h('span', { class: 'n' }, String(st.ahead)) : null);
  push.addEventListener('click', () => gitAction(push, 'push', {}, L('已推送', 'Pushed')));
  const pr = h('button', { class: 'cs-chip', type: 'button', title: st.gh ? 'gh pr create --web' : L('在浏览器中打开 PR 页面', 'Open PR page in browser'), disabled: !st.remote }, icon('pr'), L('创建 PR', 'Create PR'));
  pr.addEventListener('click', () => gitAction(pr, 'pr', {}, L('已在浏览器中打开', 'Opened in browser')));
  const bar = h('div', { class: 'cs-bar' }, branchBtn, h('span', { style: 'flex:1' }), pull, push, pr);

  // File lists
  const staged = st.files.filter((f) => f.index !== '.' && f.index !== '?' && f.index !== 'U');
  const unstaged = st.files.filter((f) => f.work !== '.' && f.index !== '?' && f.index !== 'U');
  const untracked = st.files.filter((f) => f.index === '?');
  const conflicts = st.files.filter((f) => f.index === 'U');
  const body = h('div', { class: 'cs-dbody' });

  const section = (title, files, kind) => {
    if (!files.length) return;
    const bulk = kind === 'staged'
      ? h('button', { class: 'act', type: 'button' }, L('全部取消暂存', 'Unstage all'))
      : h('button', { class: 'act', type: 'button' }, L('全部暂存', 'Stage all'));
    bulk.addEventListener('click', () => (kind === 'staged'
      ? gitAction(null, 'unstage', { paths: files.map((f) => f.path) })
      : gitAction(null, 'stage', { paths: files.map((f) => f.path) })));
    body.append(h('div', { class: 'cs-sec' }, title, h('span', {}, String(files.length)), kind === 'conflict' ? null : bulk));
    for (const f of files) body.append(...fileRow(f, kind));
  };
  section(L('冲突', 'Conflicts'), conflicts, 'conflict');
  section(L('已暂存', 'Staged'), staged, 'staged');
  section(L('已修改', 'Modified'), unstaged, 'unstaged');
  section(L('未跟踪', 'Untracked'), untracked, 'untracked');
  if (!st.files.length) body.append(h('div', { class: 'cs-empty' }, h('b', {}, L('工作区很干净', 'Working tree clean')), L('没有未提交的改动。', 'No uncommitted changes.')));

  // Recent commits
  const logHost = h('div', { class: 'cs-log' });
  body.append(h('div', { class: 'cs-sec' }, L('最近提交', 'Recent commits')), logHost);
  gitCall('log').then(({ commits }) => {
    logHost.replaceChildren(...commits.map((c) => h('div', {}, h('code', {}, c.hash), h('span', { class: 's', title: `${c.subject} — ${c.author}` }, c.subject), h('span', { class: 'w' }, c.when))));
    if (!commits.length) logHost.append(h('div', { class: 'w' }, L('还没有提交', 'No commits yet')));
  }).catch(() => logHost.append(h('div', { class: 'w' }, L('还没有提交', 'No commits yet'))));

  // Commit box
  const msg = h('textarea', { placeholder: L(`提交信息（${MOD}↩ 提交）`, `Commit message (${MOD}↩ to commit)`), spellcheck: 'false' });
  msg.value = gitState.draft ?? '';
  msg.addEventListener('input', () => { gitState.draft = msg.value; });
  const all = !staged.length;
  const hint = h('span', { class: 'hint' }, all ? (st.files.length ? L(`将提交全部 ${st.files.length} 个改动`, `Will commit all ${st.files.length} changes`) : '') : L(`将提交 ${staged.length} 个已暂存的文件`, `Will commit ${staged.length} staged files`));
  const commitBtn = h('button', { class: 'cs-btn', type: 'button', disabled: !st.files.length }, L('提交', 'Commit'));
  const commitPush = h('button', { class: 'cs-btn primary', type: 'button', disabled: !st.files.length }, L('提交并推送', 'Commit & push'));
  const doCommit = async (andPush) => {
    if (!msg.value.trim()) { msg.focus(); return toast(L('请填写提交信息', 'Enter a commit message'), true); }
    const res = await gitAction(andPush ? commitPush : commitBtn, 'commit', { message: msg.value, all }, andPush ? null : L('已提交', 'Committed'));
    if (!res) return;
    gitState.draft = '';
    if (andPush) await gitAction(commitPush, 'push', {}, L('已提交并推送', 'Committed and pushed'));
  };
  commitBtn.addEventListener('click', () => doCommit(false));
  commitPush.addEventListener('click', () => doCommit(true));
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); doCommit(e.shiftKey); }
  });
  const commit = h('div', { class: 'cs-commit' }, msg, h('div', { class: 'row' }, hint, commitBtn, commitPush));

  drawer.replaceChildren(head, bar, body, commit);
  // Fade content in on first open only, not on every refresh.
  setTimeout(() => drawer?.classList.add('cs-ready'), 300);
}

function fileRow(f, kind) {
  const status = kind === 'staged' ? f.index : kind === 'untracked' ? '?' : kind === 'conflict' ? 'U' : f.work;
  const parts = f.path.split('/');
  const key = `${kind}:${f.path}`;
  const row = h('div', { class: `cs-file${gitState.open.has(key) ? ' open' : ''}`, title: f.from ? `${f.from} → ${f.path}` : f.path },
    h('span', { class: `st ${status}` }, status),
    h('span', { class: 'p' }, h('bdi', {}, parts.length > 1 ? `${parts.slice(0, -1).join('/')}/` : '', h('b', {}, parts.at(-1)))));
  const acts = h('span', { class: 'acts' });
  const btn = (name, title, fn, cls = '') => {
    const b = h('button', { class: `cs-ibtn ${cls}`, type: 'button', title }, icon(name));
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(b); });
    acts.append(b);
    return b;
  };
  if (kind === 'staged') btn('minus', L('取消暂存', 'Unstage'), () => gitAction(null, 'unstage', { paths: [f.path] }));
  else {
    if (kind !== 'conflict') {
      // Two-step discard: first click arms, second click confirms.
      btn('undo', kind === 'untracked' ? L('删除这个未跟踪文件', 'Delete this untracked file') : L('丢弃改动', 'Discard changes'), (b) => {
        if (!b.classList.contains('confirm')) {
          b.classList.add('confirm');
          b.replaceChildren(kind === 'untracked' ? L('删除？', 'Delete?') : L('丢弃？', 'Discard?'));
          setTimeout(() => { if (b.isConnected) { b.classList.remove('confirm'); b.replaceChildren(icon('undo')); } }, 3000);
          return;
        }
        gitAction(null, 'discard', { paths: [f.path], untracked: kind === 'untracked' }, kind === 'untracked' ? L('已删除', 'Deleted') : L('已丢弃改动', 'Changes discarded'));
      }, 'warn');
    }
    btn('plus', L('暂存', 'Stage'), () => gitAction(null, 'stage', { paths: [f.path] }));
  }
  row.append(acts);
  const diffBox = h('div', { class: 'cs-diff', hidden: !gitState.open.has(key) });
  const loadDiff = async () => {
    diffBox.replaceChildren(h('div', { class: 'meta' }, L('载入中…', 'Loading…')));
    try {
      const { diff } = await gitCall('diff', { path: f.path, staged: kind === 'staged', untracked: kind === 'untracked' });
      const lines = diff.split('\n').slice(0, 3000);
      diffBox.replaceChildren(...lines.filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).map((l) => h('div', {
        class: l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('\\') ? 'meta' : '',
      }, l || ' ')));
      if (!diff.trim()) diffBox.replaceChildren(h('div', { class: 'meta' }, L('（二进制文件或没有文本差异）', '(Binary file or no text changes)')));
    } catch (err) {
      diffBox.replaceChildren(h('div', { class: 'meta' }, err.message));
    }
  };
  if (gitState.open.has(key)) loadDiff();
  row.addEventListener('click', () => {
    const open = diffBox.hidden;
    diffBox.hidden = !open;
    row.classList.toggle('open', open);
    if (open) { gitState.open.add(key); loadDiff(); } else gitState.open.delete(key);
  });
  return [row, diffBox];
}

async function branchPopover(anchor) {
  const box = h('div', {}, h('div', { class: 'cs-pop-title' }, L('切换分支', 'Switch branch')));
  const input = h('input', { class: 'cs-input', placeholder: L('新分支名，回车创建', 'New branch name, Enter to create'), spellcheck: 'false' });
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    closePop();
    await gitAction(null, 'createBranch', { branch: input.value.trim() }, L(`已创建并切换到 ${input.value.trim()}`, `Created and switched to ${input.value.trim()}`));
  });
  box.append(h('div', { style: 'padding:0 6px 6px' }, input));
  const pop = showPop(anchor, box, { align: 'start' });
  if (!pop) return;
  pop.style.zIndex = '2147483100';
  input.focus();
  try {
    const { branches } = await gitCall('branches');
    for (const b of branches.slice(0, 30)) {
      const item = h('button', { class: 'cs-item', type: 'button' }, icon('branch', 'cs-ico'), h('span', { style: b.current ? 'font-weight:600' : '' }, b.name), h('span', { class: 'cs-kbd', style: 'border:0;background:none' }, b.current ? L('当前', 'current') : b.when));
      item.addEventListener('click', () => { closePop(); if (!b.current) gitAction(null, 'checkout', { branch: b.name }, L(`已切换到 ${b.name}`, `Switched to ${b.name}`)); });
      box.append(item);
    }
  } catch (err) { box.append(h('div', { class: 'cs-pop-sub' }, err.message)); }
}

// ---------------------------------------------------------------------------
// Quota card above the sidebar's Settings button (Settings → Models & Usage)
// ---------------------------------------------------------------------------

let quota = { data: null, at: 0, card: null };
const GROUP_SHORT = (name) => (/gemini/i.test(name) ? 'Gemini' : /claude|gpt/i.test(name) ? 'Claude · GPT' : name);
const WINDOW_LABEL = { '5h': L('5 小时', '5 hours'), weekly: L('每周', 'Weekly') };

function untilText(iso) {
  if (!iso) return '';
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return L('即将重置', 'Resets soon');
  const m = Math.round(ms / 60000);
  if (m < 60) return L(`${m} 分钟后重置`, `Resets in ${m} min`);
  const hrs = Math.floor(m / 60);
  if (hrs < 24) return L(`${hrs} 小时${m % 60 ? ` ${m % 60} 分` : ''}后重置`, `Resets in ${hrs}h${m % 60 ? ` ${m % 60}m` : ''}`);
  return L(`${Math.floor(hrs / 24)} 天${hrs % 24 ? ` ${hrs % 24} 小时` : ''}后重置`, `Resets in ${Math.floor(hrs / 24)}d${hrs % 24 ? ` ${hrs % 24}h` : ''}`);
}
const levelOf = (f) => (f == null ? '' : f < 0.1 ? 'crit' : f < 0.3 ? 'low' : '');
const pctText = (f) => (f == null ? '—' : `${Math.round(f * 100)}%`);

function bar(f) {
  return h('span', { class: `cs-qbar ${levelOf(f)}` }, h('i', { style: `width:${Math.max(0, Math.min(1, f ?? 0)) * 100}%` }));
}

async function refreshQuota(force = false) {
  if (!force && Date.now() - quota.at < 60000) return;
  quota.at = Date.now();
  try { quota.data = await call('quota'); } catch { /* keep last */ }
  renderQuotaCard();
}

function ensureQuotaCard() {
  const settingsBtn = $('[data-testid="settings-button"]');
  const host = settingsBtn?.parentElement;
  if (!host) return;
  if (quota.card?.isConnected && quota.card.parentElement === host) return;
  quota.card?.remove();
  host.classList.add('cs-quota-host');
  quota.card = h('button', { class: 'cs-ui cs-quota', type: 'button' });
  quota.card.addEventListener('click', (e) => { e.stopPropagation(); quotaPopover(quota.card); });
  host.append(quota.card);
  renderQuotaCard();
  refreshQuota();
}
onCleanup(() => quota.card?.remove());

// Card shows each group's 5-hour quota (it's what runs out day to day). A
// group switches to its weekly quota only when that is nearly used up, since
// then the weekly limit is what will actually stop you.
const WEEKLY_ALERT = 0.15;
function shownBucket(g) {
  const five = g.buckets.find((b) => b.window === '5h');
  const week = g.buckets.find((b) => b.window === 'weekly');
  if (week?.remaining != null && week.remaining < WEEKLY_ALERT && week.remaining <= (five?.remaining ?? 1)) return week;
  return five ?? week ?? g.buckets[0];
}
function shortUntil(b) {
  if (!b || b.remaining == null || b.remaining >= 1) return L('未使用', 'Unused');
  return untilText(b.reset);
}

// Small ring gauge: filled share = remaining quota.
function miniRing(f, level) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `cs-qring ${level}`);
  const c = 2 * Math.PI * 6;
  const v = Math.max(0, Math.min(1, f ?? 0));
  svg.innerHTML = `<circle cx="8" cy="8" r="6" class="trk"/><circle cx="8" cy="8" r="6" class="val" stroke-dasharray="${(c * v).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/>`;
  return svg;
}

function renderQuotaCard() {
  const card = quota.card;
  if (!card) return;
  card.hidden = !settings.quota;
  const groups = quota.data ?? [];
  if (!groups.length) { card.replaceChildren(); card.title = ''; return; }
  const tips = [];
  card.replaceChildren(...groups.map((g) => {
    const b = shownBucket(g);
    const weekly = b?.window === 'weekly';
    tips.push(L(`${GROUP_SHORT(g.name)} · ${weekly ? '本周' : '5 小时'}额度 ${pctText(b?.remaining)} · ${shortUntil(b)}`, `${GROUP_SHORT(g.name)} · ${weekly ? 'weekly' : '5-hour'} quota ${pctText(b?.remaining)} · ${shortUntil(b)}`));
    return h('span', { class: `cs-qchip ${levelOf(b?.remaining)}${weekly ? ' weekly' : ''}` },
      miniRing(b?.remaining, levelOf(b?.remaining)),
      h('span', { class: 'cs-qpct' }, pctText(b?.remaining)));
  }));
  card.title = `${tips.join('\n')}\n${L('点击查看详情', 'Click for details')}`;
}

function quotaPopover(anchor) {
  refreshQuota(true);
  const groups = quota.data ?? [];
  const body = [h('h4', {}, L('用量额度', 'Usage quota')), h('div', { class: 'cs-model' }, L('每组模型共享 5 小时额度和每周额度，按 token 成本消耗。', 'Each model group shares a 5-hour and a weekly limit, consumed by token cost.'))];
  for (const g of groups) {
    body.push(h('div', { class: 'cs-qgroup' }, h('b', {}, GROUP_SHORT(g.name)), h('span', {}, (g.description || '').replace(/^Models within this group:\s*/i, ''))));
    const order = { '5h': 0, weekly: 1 };
    for (const b of [...g.buckets].sort((x, y) => (order[x.window] ?? 2) - (order[y.window] ?? 2))) {
      body.push(h('div', { class: 'cs-qline' },
        h('span', { class: 'cs-qwin' }, WINDOW_LABEL[b.window] ?? b.label),
        bar(b.remaining),
        h('span', { class: `cs-qpct ${levelOf(b.remaining)}` }, pctText(b.remaining)),
        h('span', { class: 'cs-qreset', title: b.reset ? new Date(b.reset).toLocaleString('zh-CN') : '' }, b.remaining === 1 ? L('未使用', 'Unused') : untilText(b.reset))));
    }
  }
  const open = h('button', { class: 'cs-item', type: 'button', style: 'margin-top:8px' }, icon('sliders', 'cs-ico'), L('在设置中查看（模型与用量）', 'View in Settings (Models & Usage)'));
  open.addEventListener('click', () => {
    closePop();
    $('[data-testid="settings-button"]')?.click();
    setTimeout(() => $('[data-testid="settings-nav-item-Models"]')?.click(), 400);
  });
  body.push(h('div', { class: 'cs-sep' }), open);
  showPop(anchor, body, { cls: 'cs-usage-pop cs-quota-pop', align: 'start', above: true });
}

// ---------------------------------------------------------------------------
// Full-screen: macOS hides the window buttons but Antigravity keeps their
// 88px gap, leaving the sidebar icons floating. Track full-screen state.
// ---------------------------------------------------------------------------

function syncFullscreen() {
  const fs = innerWidth >= screen.width - 1 && innerHeight >= screen.height - 1;
  document.documentElement.classList.toggle('cs-fullscreen', fs);
}
window.addEventListener('resize', syncFullscreen);
onCleanup(() => { window.removeEventListener('resize', syncFullscreen); document.documentElement.classList.remove('cs-fullscreen'); });
syncFullscreen();

// ---------------------------------------------------------------------------
// New-conversation greeting
// ---------------------------------------------------------------------------

let greeting = null;
function greetingText() {
  const hr = new Date().getHours();
  return hr < 5 ? L('夜深了', 'Good night') : hr < 11 ? L('早上好', 'Good morning') : hr < 13 ? L('中午好', 'Good afternoon') : hr < 18 ? L('下午好', 'Good afternoon') : L('晚上好', 'Good evening');
}
// The app icon is a white macOS tile with the mark on it: drop the tile so only
// the mark shows, like the SVG the "Open IDE" button used to carry.
let iconLogoUrl = null;
function iconLogo() {
  const src = window.__CLAUDE_STYLE_LOGO__;
  if (!src) return null;
  const img = h('img', { alt: '', draggable: 'false' });
  if (iconLogoUrl) { img.src = iconLogoUrl; return img; }
  img.style.visibility = 'hidden';
  const raw = new Image();
  raw.onload = () => {
    const c = document.createElement('canvas');
    c.width = raw.naturalWidth; c.height = raw.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(raw, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const px = data.data;
    let x0 = c.width, y0 = c.height, x1 = 0, y1 = 0;
    for (let i = 0; i < px.length; i += 4) {
      // The white tile becomes transparent; the mark (never close to white) stays.
      // Edge pixels are un-blended from white so they don't leave a light halo.
      const min = Math.min(px[i], px[i + 1], px[i + 2]);
      const a = Math.min(1, Math.max(0, (248 - min) / 70));
      if (a > 0 && a < 1) for (let k = 0; k < 3; k++) px[i + k] = Math.max(0, Math.min(255, (px[i + k] - 255 * (1 - a)) / a));
      px[i + 3] = Math.round(px[i + 3] * a);
      if (px[i + 3] > 24) {
        const x = (i / 4) % c.width, y = Math.floor(i / 4 / c.width);
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      }
    }
    ctx.putImageData(data, 0, 0);
    if (x1 <= x0) { img.remove(); return; }
    const side = Math.max(x1 - x0, y1 - y0) + 2;
    const out = document.createElement('canvas');
    out.width = out.height = side;
    out.getContext('2d').drawImage(c, x0 - (side - (x1 - x0)) / 2, y0 - (side - (y1 - y0)) / 2, side, side, 0, 0, side, side);
    iconLogoUrl = out.toDataURL('image/png');
    img.src = iconLogoUrl;
    img.style.visibility = '';
  };
  raw.src = src;
  return img;
}

function ensureGreeting() {
  const box = document.getElementById('antigravity.agentSidePanelInputBox');
  const page = !cascadeId() && settings.theme ? box?.closest('.animate-fade-in.items-center') : null;
  if (!page) { greeting?.remove(); greeting = null; return; }
  if (greeting?.isConnected && page.contains(greeting)) return;
  greeting?.remove();
  // Insert above the block holding the project selector + composer.
  let block = box;
  while (block.parentElement && block.parentElement !== page) block = block.parentElement;
  const prev = block.previousElementSibling;
  if (prev && /Project|Workspace|项目|工作区/.test(prev.textContent || '')) block = prev;
  // Antigravity's own logo: from the "Open IDE" button when it has one (up to
  // 2.22), otherwise the app icon read by the sidecar.
  const logo = $('[data-testid^="open-editor"] svg')?.cloneNode(true) ?? iconLogo();
  greeting = h('div', { class: 'cs-ui cs-greeting' }, logo ? h('span', { class: 'cs-logo' }, logo) : null, greetingText());
  page.insertBefore(greeting, block);
}
onCleanup(() => greeting?.remove());

// ---------------------------------------------------------------------------
// Artifacts with no built-in preview (e.g. PDFs under Overview → Documents):
// show them in the 文件预览 plugin instead.
// ---------------------------------------------------------------------------

const PREVIEWABLE = /\.(pdf|ai|docx?|docm|dotx?|rtf|odt|ott|pages|wps|wpt|pptx?|pptm|ppsx?|potx?|odp|dps|xlsx?|xlsm|xlsb|xltx?|ods|numbers|et|ett|vsdx?|odg|csv|tsv|heic|heif|tiff?|psd|dng|cr2|cr3|nef|arw|mov|mkv|avi|flac|aiff?|zip|7z|rar|ttf|otf|woff2?)$/i;

async function artifactPath(link) {
  let url;
  try { url = new URL(link.href, location.href); } catch { return null; }
  const m = /^\/static\/artifacts\/([0-9a-f-]{36})\/(.+)$/i.exec(url.pathname);
  if (m) {
    const rel = m[2].split('/').map((p) => decodeURIComponent(p)).join('/');
    try { return (await call('artifactPath', { cascadeId: m[1], rel })).path; } catch { return null; }
  }
  for (let c of [url.pathname, ...url.searchParams.values()]) {
    for (let i = 0; i < 3; i++) { try { c = decodeURIComponent(c); } catch { break; } }
    const f = /(\/(?:Users|Volumes|private|tmp|home)\/[^?#]+?\.[A-Za-z0-9]{2,5})$/.exec(c.replace(/^file:\/\//, ''));
    if (f) return f[1];
  }
  return null;
}

// Re-clicking an already open file must reload its bytes, even when React
// keeps the same sidecar tab and URL. Only target this preview plugin.
const previewFrames = () => $$('iframe[data-testid="sidecar-iframe"]').filter((f) => /^plugin:\/\/document-preview--/.test(f.src));
const onPreviewFileMessage = (event) => {
  if (event.data?.type !== 'agy-preview-file') return;
  const frame = previewFrames().find((f) => f.contentWindow === event.source);
  if (!frame) return;
  frame.csPreviewPath = typeof event.data.path === 'string' ? event.data.path : null;
  frame.csPreviewRequestedPath = typeof event.data.requestedPath === 'string' ? event.data.requestedPath : null;
};
let previewReload = 0;
function refreshOpenPreview(path) {
  for (const frame of previewFrames()) {
    let url;
    try { url = new URL(frame.src); } catch { continue; }
    const active = frame.csPreviewPath ?? url.searchParams.get('file');
    if (path !== active && path !== frame.csPreviewRequestedPath) continue;
    url.searchParams.set('file', path);
    url.searchParams.set('_agy_reload', `${Date.now()}-${++previewReload}`);
    frame.src = url.href;
  }
}
let previewClick = 0;
const onPreviewLinkClick = async (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target.closest?.('a[href]');
  if (!link || !previewFrames().length) return;
  const serial = ++previewClick;
  const conversation = cascadeId();
  try {
    const path = await artifactPath(link);
    if (serial !== previewClick || conversation !== cascadeId() || !path || !PREVIEWABLE.test(path)) return;
    refreshOpenPreview(path);
  } catch { /* the app retains its normal link handling */ }
};
window.addEventListener('message', onPreviewFileMessage);
document.addEventListener('click', onPreviewLinkClick, true);
onCleanup(() => {
  ++previewClick;
  window.removeEventListener('message', onPreviewFileMessage);
  document.removeEventListener('click', onPreviewLinkClick, true);
});

function previewBase() {
  const frame = $$('iframe[data-testid="sidecar-iframe"]').find((f) => /^plugin:\/\/document-preview--/.test(f.src));
  if (!frame) return null;
  const url = new URL(frame.src);
  const base = new URL('/', url);
  base.searchParams.set('token', url.searchParams.get('token') || '');
  return base;
}

function ensureArtifactPreview() {
  // React may replace the "no preview" view (e.g. switching tabs); drop our
  // frame with it so it never covers other content.
  for (const frame of $$('.cs-artifact-frame')) if (!frame.csBox?.isConnected) frame.remove();
  for (const box of $$('[data-testid="artifact-no-preview"]:not([data-cs-done])')) {
    box.dataset.csDone = '1';
    const link = box.querySelector('a');
    const base = previewBase();
    if (!link || !base) continue;
    artifactPath(link).then((path) => {
      if (!path || !PREVIEWABLE.test(path) || !box.isConnected) return;
      showArtifactFrame(box, base, path);
    });
  }
}

function showArtifactFrame(box, base, path) {
  {
    base.searchParams.set('file', path);
    const host = box.parentElement;
    host.style.position = 'relative';
    const frame = h('iframe', { class: 'cs-artifact-frame', src: base.href, 'data-testid': 'sidecar-iframe', title: L('文件预览', 'File Preview'), allow: 'microphone' });
    frame.csBox = box;
    host.append(frame);
    box.style.visibility = 'hidden';
    frame.addEventListener('load', () => setTimeout(syncPanels, 300));
  }
}
onCleanup(() => {
  $$('.cs-artifact-frame').forEach((f) => f.remove());
  $$('[data-testid="artifact-no-preview"][data-cs-done]').forEach((b) => { b.style.visibility = ''; delete b.dataset.csDone; });
});

// ---------------------------------------------------------------------------
// Tooltip fix: Antigravity's tooltips also open on focus, so a menu that
// auto-focuses its first icon (e.g. "Agents ⓘ" → "Click to Open Docs") pops a
// tooltip without any hover. Let focus tooltips through only for keyboard
// focus (:focus-visible); hover tooltips are unaffected.
// ---------------------------------------------------------------------------

const onFocusCapture = (e) => {
  const el = e.target;
  if (!(el instanceof Element) || !el.closest('[data-tooltip-id]')) return;
  let keyboard = false;
  try { keyboard = el.matches(':focus-visible'); } catch { /* old engine */ }
  if (!keyboard) e.stopImmediatePropagation();
};
window.addEventListener('focus', onFocusCapture, true);
window.addEventListener('focusin', onFocusCapture, true);
onCleanup(() => {
  window.removeEventListener('focus', onFocusCapture, true);
  window.removeEventListener('focusin', onFocusCapture, true);
});

// ---------------------------------------------------------------------------
// Composer highlight: Antigravity keeps keyboard focus in the input even after
// clicking elsewhere, so :focus-within is always on. Track real intent: a
// click or typing inside the composer activates it, a click outside clears it.
// ---------------------------------------------------------------------------

const COMPOSER = '#antigravity\\.agentSidePanelInputBox';
function setComposerActive(on) {
  for (const box of $$(COMPOSER)) box.classList.toggle('cs-active', on && box.contains(document.activeElement));
}
// Focus moves after pointerdown, so check on the next tick.
const onComposerPointer = (e) => { const inside = !!e.target.closest?.(COMPOSER); setTimeout(() => setComposerActive(inside)); };
const onComposerKey = (e) => { if (e.target.closest?.(COMPOSER) && !e.metaKey && !e.ctrlKey) setTimeout(() => setComposerActive(true)); };
const onComposerBlur = () => setTimeout(() => setComposerActive(false));
document.addEventListener('pointerdown', onComposerPointer, true);
document.addEventListener('keydown', onComposerKey, true);
window.addEventListener('blur', onComposerBlur);
onCleanup(() => {
  document.removeEventListener('pointerdown', onComposerPointer, true);
  document.removeEventListener('keydown', onComposerKey, true);
  window.removeEventListener('blur', onComposerBlur);
  $$(COMPOSER).forEach((b) => b.classList.remove('cs-active'));
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts (all unused by Antigravity)
// ---------------------------------------------------------------------------

const onKey = (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'Escape') {
    if (openPop) { closePop(); e.stopPropagation(); return; }
    if (drawer && !e.defaultPrevented) { closeGit(); e.stopPropagation(); return; }
  }
  if (!mod) return;
  if (e.shiftKey && !e.altKey && e.code === 'KeyG') { e.preventDefault(); e.stopPropagation(); toggleGit(); }
  else if (e.altKey && !e.shiftKey && e.code === 'KeyE') { e.preventDefault(); e.stopPropagation(); openInDefaultEditor(); }
  else if (e.altKey && !e.shiftKey && e.code === 'KeyU') { e.preventDefault(); e.stopPropagation(); if (chip) usagePopover(chip); }
};
window.addEventListener('keydown', onKey, true);
onCleanup(() => window.removeEventListener('keydown', onKey, true));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

// Rebuild injected UI when the language pack is switched on or off.
const localeObserver = new MutationObserver(() => {
  const next = currentLocale();
  if (next === locale) return;
  locale = next;
  closePop();
  header?.remove(); header = null;
  chip?.remove(); chip = null;
  quota.card?.remove(); quota.card = null;
  greeting?.remove(); greeting = null;
  if (drawer) loadGit();
  syncPanels();
  tick();
});
localeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-agy-locale'] });
onCleanup(() => localeObserver.disconnect());

let lastPath = location.pathname;
const tick = () => {
  ensureHeader();
  ensureChip();
  ensureGreeting();
  ensureArtifactPreview();
  ensureQuotaCard();
  const inConvo = !!cascadeId();
  header?.querySelectorAll('.cs-needs-convo').forEach((b) => { b.hidden = !inConvo; });
  if (chip) chip.hidden = !settings.usage || !inConvo || !(usageState.data?.last || usageState.live);
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    closePop();
    if (drawer) loadGit();
    refreshGitBadge();
  }
};
const tickTimer = setInterval(tick, 700);
const pollTimer = setInterval(poll, 1200);
const onVisible = () => { if (!document.hidden) { poll(); refreshGitBadge(); refreshQuota(); } };
document.addEventListener('visibilitychange', onVisible);
onCleanup(() => document.removeEventListener('visibilitychange', onVisible));
const badgeTimer = setInterval(() => { if (!document.hidden) { refreshGitBadge(); refreshQuota(); } renderQuotaCard(); }, 15000);
onCleanup(() => { clearInterval(tickTimer); clearInterval(pollTimer); clearInterval(badgeTimer); });

window.__claudeStyleUnload = () => {
  for (const fn of cleanups.splice(0).reverse()) { try { fn(); } catch { /* ignore */ } }
  closePop();
  $$('.cs-toast').forEach((el) => el.remove());
  delete window.__claudeStyleUnload;
  delete window.__claudeStyleReply;
};

call('settings.get').then((s) => { settings = { ...settings, ...s }; applySettings(); }).catch(() => applySettings());
applySettings();
tick();
poll();
