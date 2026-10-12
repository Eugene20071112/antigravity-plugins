// Injected by the antigravity-zh sidecar. Translates Antigravity's own UI
// text to Chinese in place and restores it when turned off. Conversation
// content, code, editors, file names and other plugins are never touched.

const DICT = window.__AGY_ZH_DICT__;
const BINDING = window.__AGY_ZH_BINDING__;
const EXACT = new Map(Object.entries(DICT.exact));
const compile = (list) => list.map(([re, to, scope]) => ({ re: new RegExp(re), to, scope }));
const PATTERNS = compile(DICT.patterns);
const UNITS = compile(DICT.units).map((u) => ({ ...u, re: new RegExp(u.re.source, 'g') }));
const TIME = compile(DICT.time);

// Never translate inside these (user / agent content and editors).
const HARD_SKIP = [
  '[aria-label="Agent response"]', '[aria-label="User message"]', '[data-lexical-editor]', '[contenteditable="true"]',
  'pre', 'code', 'kbd', 'textarea', 'input', '.monaco-editor', '.xterm', '[data-testid="artifact-view"]',
  '[data-print-root]', 'iframe', '.cs-ui', 'script', 'style', '[data-agy-zh-skip]',
].join(',');
// Conversation / project titles: only translate relative times like "3d".
const SOFT_SKIP = '[data-testid="conversation-row-sidebar"], [data-project-card], [data-testid="breadcrumb-segment"], [data-turn-content]';
const ATTRS = ['placeholder', 'title', 'aria-label'];

let enabled = true;
let disposed = false;
let frameId = null;
const textOriginals = new Map(); // Text node -> original English
const attrOriginals = new Map(); // Element -> { attr: original }

function translateString(text, soft) {
  const t = text.trim();
  if (!t || t.length > 400 || !/[A-Za-z]/.test(t)) return null;
  if (!soft && EXACT.has(t)) return text.replace(t, EXACT.get(t));
  for (const p of TIME) if (p.re.test(t)) return text.replace(t, t.replace(p.re, p.to));
  if (soft) return null;
  for (const p of PATTERNS) {
    if (p.scope === 'attr') continue;
    if (p.re.test(t)) {
      let out = t.replace(p.re, p.to);
      for (const u of UNITS) out = out.replace(u.re, u.to);
      return text.replace(t, out);
    }
  }
  return null;
}

function translateAttr(value) {
  const t = value.trim();
  if (EXACT.has(t)) return EXACT.get(t);
  for (const p of PATTERNS) if (p.re.test(t)) return t.replace(p.re, p.to);
  return null;
}

function translateTextNode(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(HARD_SKIP)) return;
  const original = textOriginals.has(node) ? textOriginals.get(node) : node.textContent;
  // React updated the text since we translated it: take the new English.
  if (textOriginals.has(node) && node.textContent !== node.__agyZh) {
    textOriginals.delete(node);
    return translateTextNode(node);
  }
  const out = translateString(original, !!parent.closest(SOFT_SKIP));
  if (out == null || out === node.textContent) return;
  textOriginals.set(node, original);
  node.__agyZh = out;
  node.textContent = out;
}

function translateElementAttrs(el) {
  if (el.closest(HARD_SKIP)) return;
  for (const attr of ATTRS) {
    const value = el.getAttribute(attr);
    if (!value) continue;
    const saved = attrOriginals.get(el) ?? {};
    if (saved[attr] != null && value === saved[`${attr}__zh`]) continue;
    const out = translateAttr(value);
    if (out == null) continue;
    saved[attr] = value;
    saved[`${attr}__zh`] = out;
    attrOriginals.set(el, saved);
    el.setAttribute(attr, out);
  }
}

function translateTree(root) {
  if (!enabled || !root) return;
  if (root.nodeType === Node.TEXT_NODE) return translateTextNode(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode());) translateTextNode(n);
  if (root.matches?.('[placeholder],[title],[aria-label]')) translateElementAttrs(root);
  for (const el of root.querySelectorAll?.('[placeholder],[title],[aria-label]') ?? []) translateElementAttrs(el);
}

function restoreAll() {
  for (const [node, original] of textOriginals) if (node.isConnected && node.textContent === node.__agyZh) node.textContent = original;
  for (const [el, saved] of attrOriginals) {
    if (!el.isConnected) continue;
    for (const attr of ATTRS) if (saved[attr] != null && el.getAttribute(attr) === saved[`${attr}__zh`]) el.setAttribute(attr, saved[attr]);
  }
  textOriginals.clear();
  attrOriginals.clear();
}

// Batch DOM changes into one pass per frame.
let pending = new Set();
let scheduled = false;
const observer = new MutationObserver((records) => {
  if (!enabled) return;
  for (const r of records) {
    if (r.type === 'childList') r.addedNodes.forEach((n) => pending.add(n));
    else if (r.type === 'characterData') pending.add(r.target);
    else if (r.type === 'attributes') pending.add(r.target);
  }
  if (!scheduled) {
    scheduled = true;
    frameId = requestAnimationFrame(() => {
      frameId = null;
      scheduled = false;
      if (!enabled || disposed) { pending.clear(); return; }
      // Maps must not retain detached conversation trees forever.
      for (const node of textOriginals.keys()) if (!node.isConnected) textOriginals.delete(node);
      for (const el of attrOriginals.keys()) if (!el.isConnected) attrOriginals.delete(el);
      const batch = pending;
      pending = new Set();
      observer.disconnect();
      for (const n of batch) if (n.isConnected) translateTree(n);
      observe();
    });
  }
});
const observe = () => observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });

function announce() {
  // Tell claude-style and plugin panels which language is active.
  if (enabled) document.documentElement.dataset.agyLocale = 'zh-CN';
  else delete document.documentElement.dataset.agyLocale;
  const locale = enabled ? 'zh' : (/^zh/i.test(navigator.language) ? 'zh' : 'en');
  for (const f of document.querySelectorAll('iframe[data-testid="sidecar-iframe"]')) {
    try { f.contentWindow?.postMessage({ type: 'agy-locale', locale }, '*'); } catch { /* gone */ }
  }
}
const onFrameLoad = (e) => { if (e.target?.matches?.('iframe[data-testid="sidecar-iframe"]')) setTimeout(announce, 300); };
document.addEventListener('load', onFrameLoad, true);

function setEnabled(next, persist = true) {
  if (disposed) return;
  enabled = !!next;
  if (enabled) { translateTree(document.body); observe(); } else { observer.disconnect(); restoreAll(); }
  announce();
  if (persist && typeof window[BINDING] === 'function') window[BINDING](JSON.stringify({ cmd: 'set', enabled }));
}

window.__agyZh = {
  get enabled() { return enabled; },
  setEnabled: (v) => setEnabled(v),
};

window.__agyZhUnload = () => {
  disposed = true;
  enabled = false;
  if (frameId != null) cancelAnimationFrame(frameId);
  pending.clear();
  observer.disconnect();
  restoreAll();
  delete document.documentElement.dataset.agyLocale;
  document.removeEventListener('load', onFrameLoad, true);
  delete window.__agyZh;
  delete window.__agyZhUnload;
};

setEnabled(window.__AGY_ZH_ENABLED__ !== false, false);
