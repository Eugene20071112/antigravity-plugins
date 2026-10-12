// Backend for the 文件预览 panel.
//
// Antigravity opens this view with `?file=<absolute path>` when the user
// clicks a file whose extension is listed in sidecar.json (generated from
// files.mjs). Formats the built-in viewer already handles well (PNG/JPG/SVG/
// GIF/WebP, MP4/WebM, MP3/WAV/OGG/M4A, Markdown, code) are not claimed.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';
import { createFiles, UserError } from './files.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR || join(HERE, '.data');
const PORT = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT);

const files = createFiles(DATA_DIR);
const app = new SidecarApp();

// ---------------------------------------------------------------------------
// Static files (re-read per request so frontend edits only need a reload)
// ---------------------------------------------------------------------------

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.gif': 'image/gif', '.png': 'image/png', '.wasm': 'application/wasm',
};
const serve = (route, file) => app.api(route, () => {
  const type = TYPES[file.slice(file.lastIndexOf('.'))] || 'application/octet-stream';
  return new Response(readFileSync(join(HERE, file)), { contentType: type, headers: { 'Cache-Control': 'no-cache' } });
}, 'GET');

serve('/', 'index.html');
serve('/app.js', 'app.js');
serve('/styles.css', 'styles.css');

// Vendored pdf.js (pdfjs-dist), served under /vendor/pdfjs/...
(function serveTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) serveTree(full);
    else {
      const rel = relative(HERE, full);
      serve(`/${rel.split(sep).join('/')}`, rel);
    }
  }
})(join(HERE, 'vendor'));

// ---------------------------------------------------------------------------
// APIs (POST, token-checked by the SDK)
// ---------------------------------------------------------------------------

// Backend messages are Chinese; translate for English UIs.
const EN = {
  "文件不存在，可能已被移动或删除。": "File not found; it may have been moved or deleted.",
  "无法访问此文件。": "Can't access this file.",
  "不支持预览此类型的文件。": "This file type can't be previewed.",
  "预览已过期，请重新打开文件。": "Preview expired, please reopen the file.",
  "预览 Office 文档需要安装 LibreOffice。": "Previewing Office documents requires LibreOffice.",
  "LibreOffice 无法转换这个文件。": "LibreOffice couldn't convert this file.",
  "无法解码这张图片。": "Can't decode this image.",
  "格式转换失败。": "Format conversion failed.",
  "播放此音频格式需要 ffmpeg（brew install ffmpeg）。": "Playing this audio format requires ffmpeg (brew install ffmpeg).",
  "播放此视频格式需要 ffmpeg（brew install ffmpeg）。": "Playing this video format requires ffmpeg (brew install ffmpeg).",
  "视频超过 30 分钟且编码不受支持，转换太慢，建议用默认应用打开。": "This video is over 30 minutes in an unsupported codec; converting would be too slow. Open it in the default app.",
  "无法读取这个压缩包（可能已加密或格式不受支持）。": "Can't read this archive (it may be encrypted or unsupported).",
  "这个 .ai 文件没有内嵌 PDF，无法预览。": "This .ai file has no embedded PDF to preview.",
  "表格超过 50 MB，请用默认应用打开。": "Spreadsheet is over 50 MB; open it in the default app.",
  "文件尚未准备好。": "File isn't ready yet.",
  "预览失败，请用默认应用打开。": "Preview failed; open it in the default app."
};
const localize = (msg, lang) => (lang === 'en' && EN[msg]) || msg;

const safe = (handler) => async (data) => {
  try {
    return await handler(data);
  } catch (err) {
    if (!(err instanceof UserError)) console.error(err);
    return new Response(JSON.stringify({ error: localize(err instanceof UserError ? err.message : '预览失败，请用默认应用打开。', data?.lang) }),
      { status: 400, contentType: 'application/json' });
  }
};

app.api('/api/open', safe((data) => files.open(data.path)));
app.api('/api/prepare', safe(async (data) => {
  const info = await files.prepare(data.id);
  const src = `/file?id=${info.id}&v=${encodeURIComponent(String(info.mtime))}`;
  // Media plays straight from the loopback port: the host's plugin:// proxy
  // isn't a streaming scheme, so <video>/<audio> couldn't seek through it.
  const stream = info.view === 'video' || info.view === 'audio' ? `http://127.0.0.1:${PORT}${src}` : src;
  return { ...info, src, stream };
}));
app.api('/api/reveal', safe((data) => files.reveal(data.id, data.action)));
app.api('/api/list', safe((data) => files.list(data.uris)));
app.api('/api/conversation-files', safe((data) => files.conversationFiles(data.conversationId)));

// ---------------------------------------------------------------------------
// Start, then put a streaming /file handler in front of the SDK's router
// (its handlers buffer whole bodies and don't support Range requests).
// ---------------------------------------------------------------------------

const server = await app.run();
const sdkHandlers = server.listeners('request');
server.removeAllListeners('request');
server.on('request', (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== '/file' || !['GET', 'HEAD'].includes(req.method)) {
    for (const handler of sdkHandlers) handler.call(server, req, res);
    return;
  }
  files.stream(url.searchParams.get('id'), req, res).catch((err) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(err instanceof UserError ? err.message : 'Not found');
  });
});

files.cleanCache().catch(() => {});
