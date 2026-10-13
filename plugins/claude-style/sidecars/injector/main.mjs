// Claude-style injector for the Antigravity window.
//
// Antigravity always starts Electron with a DevTools port (port 0 → recorded in
// <userData>/DevToolsActivePort). This sidecar attaches to the app's main page,
// injects inject/skin.css + inject/app.js on every load, and serves the
// injected UI through a private Runtime binding — no network port is opened.
// Stopping the sidecar (disabling the plugin) removes everything again.

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGit } from './git.mjs';
import { createUsageReader } from './usage.mjs';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const APP_DATA_DIR = process.env.ANTIGRAVITY_APP_DATA_DIR || join(os.homedir(), '.gemini', 'antigravity');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');
const PORT_FILES = ['Antigravity', 'Antigravity IDE'].map((n) => join(os.homedir(), 'Library', 'Application Support', n, 'DevToolsActivePort'));
const BINDING = '__claudeStyleCall';
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const DEFAULTS = { theme: true, serif: true, serifAll: true, cjkSerif: false, fontSize: 16, wide: false, usage: true, quota: true, accent: '#d97757', tone: 'warm' };
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) }; } catch { return { ...DEFAULTS }; }
}
function saveSettings(next) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------
// Language server (same Connect/JSON API the app's UI uses)
// ---------------------------------------------------------------------------

let lsOrigin = null; // e.g. https://127.0.0.1:51735, learned from the page URL

function lsCall(method, body) {
  if (!lsOrigin) return Promise.reject(new Error('language server not found'));
  const url = new URL(`/exa.language_server_pb.LanguageServerService/${method}`, lsOrigin);
  const payload = JSON.stringify(body ?? {});
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      rejectUnauthorized: false, // loopback with the app's self-signed certificate
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'x-codeium-csrf-token': process.env.ANTIGRAVITY_CSRF_TOKEN || '',
      },
      timeout: 15000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`${method}: HTTP ${res.statusCode} ${text.slice(0, 200)}`));
        try { resolve(JSON.parse(text)); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`${method}: timeout`)));
    req.end(payload);
  });
}

const usage = createUsageReader(lsCall);

async function summaries() {
  const res = await lsCall('GetAllCascadeTrajectories', {});
  const out = {};
  for (const [id, s] of Object.entries(res.trajectorySummaries ?? {})) {
    out[id] = {
      title: s.annotations?.title || s.summary || '',
      status: String(s.status || '').replace('CASCADE_RUN_STATUS_', ''),
      steps: s.stepCount ?? 0,
      modified: s.lastModifiedTime,
      workspaces: (s.workspaces ?? s.trajectoryMetadata?.workspaces ?? []).map((w) => w.workspaceFolderAbsoluteUri).filter(Boolean),
    };
  }
  return out;
}

// Workspace folder for a conversation: its first workspace, else the scratch
// folder the agent writes to when no workspace is open.
async function workspaceFor(cascadeId) {
  try {
    const all = await summaries();
    const uri = all[cascadeId]?.workspaces?.[0];
    if (uri) return fileURLToPath(uri);
  } catch { /* fall through */ }
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  if (exe && /^[0-9a-f-]{36}$/i.test(String(cascadeId))) {
    try {
      const { stdout } = await run(exe, ['agentapi', 'get-conversation-metadata', cascadeId], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
      const meta = JSON.parse(stdout)?.response?.conversationMetadata?.metadata;
      const uri = meta?.workspaceUris?.[0] ?? meta?.workspaces?.[0]?.workspaceFolderAbsoluteUri;
      if (uri) return fileURLToPath(uri);
    } catch { /* fall through */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// "Open in" targets
// ---------------------------------------------------------------------------

const APPS = [
  { id: 'vscode', name: 'VS Code', app: 'Visual Studio Code' },
  { id: 'cursor', name: 'Cursor', app: 'Cursor' },
  { id: 'windsurf', name: 'Windsurf', app: 'Windsurf' },
  { id: 'zed', name: 'Zed', app: 'Zed' },
  { id: 'sublime', name: 'Sublime Text', app: 'Sublime Text' },
  { id: 'xcode', name: 'Xcode', app: 'Xcode' },
  { id: 'idea', name: 'IntelliJ IDEA', app: 'IntelliJ IDEA' },
  { id: 'pycharm', name: 'PyCharm', app: 'PyCharm' },
  { id: 'finder', name: 'Finder', app: 'Finder' },
  { id: 'terminal', name: 'Terminal', app: 'Terminal' },
  { id: 'iterm', name: 'iTerm', app: 'iTerm' },
  { id: 'warp', name: 'Warp', app: 'Warp' },
  { id: 'ghostty', name: 'Ghostty', app: 'Ghostty' },
];

function appInstalled(name) {
  if (name === 'Finder' || name === 'Terminal') return true;
  return [`/Applications/${name}.app`, join(os.homedir(), 'Applications', `${name}.app`), `/System/Applications/Utilities/${name}.app`]
    .some(existsSync);
}

async function openIn(appId, target) {
  const app = APPS.find((a) => a.id === appId);
  // Folders only: `open -a Terminal x.command` would execute a file.
  if (!app || !target || !existsSync(target) || !statSync(target).isDirectory()) throw new Error('无法打开：文件夹不存在。');
  if (app.id === 'finder') await run('/usr/bin/open', [target]);
  else await run('/usr/bin/open', ['-a', app.app, target]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Command handlers (called from the page through the binding)
// ---------------------------------------------------------------------------

const git = createGit();

const HANDLERS = {
  'settings.get': () => loadSettings(),
  'settings.set': (patch) => saveSettings({ ...loadSettings(), ...patch }),
  'usage': ({ cascadeId }) => usage(cascadeId),
  // Same data as Settings → Models & Usage: 5-hour and weekly limits per model group.
  'quota': async () => {
    const res = await lsCall('RetrieveUserQuotaSummary', {});
    return (res.response?.groups ?? []).map((g) => ({
      name: g.displayName,
      description: g.description,
      buckets: (g.buckets ?? []).map((b) => ({
        id: b.bucketId, window: b.window, label: b.displayName,
        remaining: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
        reset: b.resetTime ?? null,
      })),
    }));
  },
  'status': async ({ cascadeId }) => (await summaries())[cascadeId] ?? null,
  'workspace': async ({ cascadeId }) => ({ path: await workspaceFor(cascadeId) }),
  'apps': () => APPS.filter((a) => appInstalled(a.app)).map(({ id, name }) => ({ id, name })),
  'openIn': ({ app, path }) => openIn(app, path),
  // /static/artifacts/<conversation>/<file> is served from the agent's brain folder.
  'artifactPath': ({ cascadeId, rel }) => {
    const parts = String(rel || '').split('/');
    if (!/^[0-9a-f-]{36}$/i.test(String(cascadeId)) || !rel || parts.includes('..') || rel.startsWith('/')) throw new Error('无效的路径');
    const full = join(APP_DATA_DIR, 'brain', cascadeId, ...parts);
    if (!existsSync(full)) throw new Error('找不到这个文件');
    return { path: full };
  },
  'reveal': async ({ path }) => { await run('/usr/bin/open', ['-R', path]); return { ok: true }; },
  'git': ({ op, cwd, ...args }) => git.run(op, cwd, args),
};

// Backend messages are written in Chinese; translate for English UIs.
const EN = {
  '无法打开：文件夹不存在。': 'Can\'t open: folder not found.',
  '无效的路径': 'Invalid path',
  '找不到这个文件': 'File not found',
  'git 命令失败': 'git command failed',
  '无效的文件路径': 'Invalid file path',
  '没有可用的工作区文件夹': 'No workspace folder available',
  '请填写提交信息': 'Enter a commit message',
  '无效的分支名': 'Invalid branch name',
  '分支名只能包含字母、数字、. _ / -': 'Branch names may only contain letters, numbers, . _ / -',
  '没有找到 origin 远程仓库': 'No "origin" remote found',
  '这个文件夹不是 Git 仓库': 'This folder is not a Git repository',
};
const localize = (msg, lang) => (lang === 'en' && EN[msg]) || msg;

// ---------------------------------------------------------------------------
// DevTools attachment
// ---------------------------------------------------------------------------

const sessions = new Map(); // targetId → session

// Antigravity's logo for the greeting. 2.23 dropped it from the "Open IDE"
// button we used to borrow it from, so read the app's own icon instead.
let logoCache;
function appLogo() {
  if (logoCache !== undefined) return logoCache;
  logoCache = null;
  const exe = process.env.ANTIGRAVITY_EXECUTABLE || process.execPath;
  const app = /^(.*?\.app)\//.exec(exe)?.[1];
  const icons = [app && join(app, 'Contents', 'Resources', 'icon.icns'), '/Applications/Antigravity.app/Contents/Resources/icon.icns'];
  for (const icon of icons) {
    if (!icon || !existsSync(icon)) continue;
    try {
      mkdirSync(DATA_DIR, { recursive: true });
      const out = join(DATA_DIR, 'antigravity-logo.png');
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '-Z', '128', icon, '--out', out], { stdio: 'ignore', timeout: 10000 });
      logoCache = `data:image/png;base64,${readFileSync(out).toString('base64')}`;
      break;
    } catch { /* try the next location */ }
  }
  return logoCache;
}

function bootSource() {
  const css = readFileSync(join(HERE, 'inject', 'skin.css'), 'utf8');
  const js = readFileSync(join(HERE, 'inject', 'app.js'), 'utf8');
  return `(() => {
  if (!/^https:\\/\\/127\\.0\\.0\\.1:/.test(location.href) || window.top !== window) return;
  const start = () => {
    window.__claudeStyleUnload?.();
    window.__CLAUDE_STYLE_CSS__ = ${JSON.stringify(css)};
    window.__CLAUDE_STYLE_BINDING__ = ${JSON.stringify(BINDING)};
    window.__CLAUDE_STYLE_LOGO__ = ${JSON.stringify(appLogo())};
    ${js}
  };
  // On a fresh load this runs before <head>/<body> exist.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();`;
}

function devtoolsPort() {
  for (const file of PORT_FILES) {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0]);
      if (port) return port;
    } catch { /* not this app */ }
  }
  return null;
}

class Session {
  constructor(target) {
    this.target = target;
    this.id = 0;
    this.pending = new Map();
    this.scriptId = null;
    this.ws = new WebSocket(target.webSocketDebuggerUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (msg) => this.onMessage(JSON.parse(msg.data));
    this.ws.onclose = () => {
      sessions.delete(target.id);
      log('detached', target.url.slice(0, 60));
    };
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
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.bindingCalled' && msg.params.name === BINDING) this.onCall(msg.params);
  }

  async onCall({ payload, executionContextId }) {
    let req;
    try { req = JSON.parse(payload); } catch { return; }
    let reply;
    try {
      const handler = HANDLERS[req.cmd];
      if (!handler) throw new Error(`unknown command ${req.cmd}`);
      reply = { ok: true, data: await handler(req.args ?? {}) };
    } catch (err) {
      reply = { ok: false, error: localize(err.message || String(err), req.lang) };
    }
    this.send('Runtime.evaluate', {
      expression: `window.__claudeStyleReply && window.__claudeStyleReply(${JSON.stringify(req.id)}, ${JSON.stringify(reply)})`,
      contextId: executionContextId,
    }).catch(() => {});
  }

  async attach() {
    await this.ready;
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Runtime.addBinding', { name: BINDING });
    await this.inject();
    log('attached', this.target.url.slice(0, 60));
  }

  async inject() {
    const source = bootSource();
    if (this.scriptId) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId }).catch(() => {});
    ({ identifier: this.scriptId } = await this.send('Page.addScriptToEvaluateOnNewDocument', { source }));
    await this.send('Runtime.evaluate', { expression: source });
  }

  async detach() {
    try {
      if (this.scriptId) await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this.scriptId });
      await this.send('Runtime.evaluate', { expression: 'window.__claudeStyleUnload && window.__claudeStyleUnload()' });
      await this.send('Runtime.removeBinding', { name: BINDING });
    } catch { /* window may be gone */ }
    this.ws.close();
  }
}

async function scan() {
  const port = devtoolsPort();
  if (!port) return;
  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch {
    return;
  }
  for (const target of targets) {
    if (target.type !== 'page' || !/^https:\/\/127\.0\.0\.1:\d+\//.test(target.url) || sessions.has(target.id)) continue;
    lsOrigin = new URL(target.url).origin;
    const session = new Session(target);
    sessions.set(target.id, session);
    session.attach().catch((err) => {
      log('attach failed', err.message);
      sessions.delete(target.id);
    });
  }
}

// Hot-reload injected files while editing them.
let reloadTimer;
watch(join(HERE, 'inject'), () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    for (const s of sessions.values()) s.inject().catch(() => {});
    log('re-injected');
  }, 200);
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

log('claude-style injector started');
await scan();
setInterval(scan, 3000);
