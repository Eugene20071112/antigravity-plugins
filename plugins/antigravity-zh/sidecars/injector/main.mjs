// Chinese language pack for the Antigravity window.
//
// Attaches to the app's main page through its DevTools port (Antigravity
// always opens one and records it in DevToolsActivePort) and injects
// inject/translate.js with the dictionary in inject/zh.json. The on/off state
// is stored in this sidecar's data folder. Stopping the sidecar restores the
// English UI.

import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const STATE_FILE = join(DATA_DIR, 'state.json');
const PORT_FILES = ['Antigravity', 'Antigravity IDE'].map((n) => join(os.homedir(), 'Library', 'Application Support', n, 'DevToolsActivePort'));
const BINDING = '__agyZhCall';
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

function enabled() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')).enabled !== false; } catch { return true; }
}
function setEnabled(value) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify({ enabled: !!value }));
}

function bootSource() {
  const dict = readFileSync(join(HERE, 'inject', 'zh.json'), 'utf8');
  const js = readFileSync(join(HERE, 'inject', 'translate.js'), 'utf8');
  return `(() => {
  if (!/^https:\\/\\/127\\.0\\.0\\.1:/.test(location.href) || window.top !== window) return;
  const start = () => {
    window.__agyZhUnload?.();
    window.__AGY_ZH_DICT__ = ${dict};
    window.__AGY_ZH_BINDING__ = ${JSON.stringify(BINDING)};
    window.__AGY_ZH_ENABLED__ = ${enabled()};
    ${js}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();`;
}

function devtoolsPort() {
  for (const file of PORT_FILES) {
    try { const port = Number(readFileSync(file, 'utf8').split('\n')[0]); if (port) return port; } catch { /* next */ }
  }
  return null;
}

const sessions = new Map();

class Session {
  constructor(target) {
    this.target = target;
    this.id = 0;
    this.pending = new Map();
    this.scriptId = null;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    this.ws.onmessage = (msg) => this.onMessage(JSON.parse(msg.data));
    this.ws.onclose = () => sessions.delete(target.id);
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  onMessage(msg) {
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === BINDING) {
      try {
        const req = JSON.parse(msg.params.payload);
        if (req.cmd === 'set') { setEnabled(req.enabled); this.inject().catch(() => {}); }
      } catch { /* ignore */ }
    }
  }
  async attach() {
    await this.ready;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Runtime.addBinding', { name: BINDING });
    await this.inject();
    log('attached', this.target.url.slice(0, 60));
  }
  // Re-registers the boot script so a reload picks up the current on/off state.
  async inject({ evaluate = false } = {}) {
    const source = bootSource();
    if (this.scriptId) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }).catch(() => {});
    ({ identifier: this.scriptId } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }));
    if (evaluate || !this.evaluated) { await this.send('Runtime.evaluate', { expression: source }); this.evaluated = true; }
  }
  async detach() {
    try {
      if (this.scriptId) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId });
      await this.send('Runtime.evaluate', { expression: 'window.__agyZhUnload && window.__agyZhUnload()' });
      await this.send('Runtime.removeBinding', { name: BINDING });
    } catch { /* window gone */ }
    this.ws.close();
  }
}

async function scan() {
  const port = devtoolsPort();
  if (!port) return;
  let targets;
  try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); } catch { return; }
  for (const target of targets) {
    if (target.type !== 'page' || !/^https:\/\/127\.0\.0\.1:\d+\//.test(target.url) || sessions.has(target.id)) continue;
    const session = new Session(target);
    sessions.set(target.id, session);
    session.attach().catch((err) => { log('attach failed', err.message); sessions.delete(target.id); });
  }
}

// Reload the dictionary when it is edited.
let reloadTimer;
watch(join(HERE, 'inject'), () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { for (const s of sessions.values()) s.inject({ evaluate: true }).catch(() => {}); }, 200);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...sessions.values()].map((s) => s.detach()));
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

log('antigravity-zh started');
await scan();
setInterval(scan, 3000);
