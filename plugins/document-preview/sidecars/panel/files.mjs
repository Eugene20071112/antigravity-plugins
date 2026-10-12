// File access for the preview panel: resolves paths to opaque ids, prepares a
// browser-friendly rendition (PDF for Office files, PNG for RAW/HEIC/PSD,
// MP4/M4A for media Chromium can't decode, listings for archives) and streams
// it with HTTP range support.

import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MB = 1024 * 1024;

const KIND_BY_EXT = {};
const define = (kind, exts) => exts.forEach((ext) => { KIND_BY_EXT[ext] = kind; });
define('pdf', ['.pdf', '.ai']);
define('office', [
  '.doc', '.docx', '.docm', '.dot', '.dotx', '.rtf', '.odt', '.ott', '.pages', '.wps', '.wpt',
  '.ppt', '.pptx', '.pptm', '.pps', '.ppsx', '.pot', '.potx', '.odp', '.key', '.dps', '.dpt',
  '.xls', '.xlsx', '.xlsm', '.xlsb', '.xlt', '.xltx', '.ods', '.numbers', '.et', '.ett',
  '.vsd', '.vsdx', '.odg',
]);
define('table', ['.csv', '.tsv']);
define('image', [
  '.heic', '.heif', '.avif', '.bmp', '.tif', '.tiff', '.psd', '.tga', '.exr', '.hdr', '.jp2', '.jxl', '.icns',
  '.dng', '.cr2', '.cr3', '.nef', '.arw', '.raf', '.orf', '.rw2', '.srw', '.pef',
]);
define('video', [
  '.mov', '.m4v', '.mkv', '.avi', '.wmv', '.flv', '.f4v', '.mpg', '.mpeg', '.ogv', '.3gp', '.3g2',
  '.mts', '.m2ts', '.vob', '.asf', '.rm', '.rmvb', '.divx', '.mxf',
]);
define('audio', [
  '.flac', '.aac', '.opus', '.oga', '.weba', '.aif', '.aiff', '.caf', '.wma', '.ape', '.amr',
  '.m4b', '.m4r', '.mka', '.ac3', '.dts', '.wv', '.tta', '.au',
]);
define('font', ['.ttf', '.otf', '.woff', '.woff2', '.ttc']);
define('archive', ['.zip', '.7z', '.rar', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.iso', '.jar', '.apk', '.whl', '.xip', '.cab']);

// The built-in viewer keeps these when a file is clicked in the app (so they're
// not claimed in sidecar.json), but the panel can still show them when they're
// picked from its own file list.
const BROWSER_NATIVE = {
  image: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'],
  video: ['.mp4', '.webm'],
  audio: ['.mp3', '.wav', '.ogg', '.m4a'],
};
export const claimedExtensions = Object.keys(KIND_BY_EXT);
for (const [kind, exts] of Object.entries(BROWSER_NATIVE)) define(kind, exts);
const NATIVE = new Set(Object.values(BROWSER_NATIVE).flat());

export const GROUPS = {
  pdf: 'document', office: 'document', table: 'table', image: 'image', video: 'media', audio: 'media', font: 'other', archive: 'other',
};

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/mp4', '.m4v': 'video/mp4', '.ogv': 'video/ogg',
  '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.aac': 'audio/aac', '.opus': 'audio/ogg', '.oga': 'audio/ogg',
  '.weba': 'audio/webm', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttc': 'font/collection',
  '.csv': 'text/plain', '.tsv': 'text/plain', '.txt': 'text/plain',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};
const NATIVE_IMAGE = new Set(['.bmp', '.avif']);
const NATIVE_AUDIO = new Set(['.flac', '.aac', '.opus', '.oga', '.weba']);
const PLAYABLE_VIDEO = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'build', 'dist', '.next', 'Library']);

const find = (candidates) => candidates.find((p) => existsSync(p));
const SOFFICE = find(['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice']);
const FFMPEG = find(['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']);
const FFPROBE = find(['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']);


export class UserError extends Error {}

export function createFiles(dataDir) {
  const byId = new Map();
  const byPath = new Map();
  const cacheDir = path.join(dataDir, 'cache');
  // LibreOffice can't run two conversions with one profile; serialize them.
  let queue = Promise.resolve();

  async function register(input) {
    let real;
    try {
      const raw = String(input || '').trim();
      real = await fs.realpath(raw.startsWith('file:') ? fileURLToPath(raw) : raw);
    } catch (err) {
      throw new UserError(err.code === 'ENOENT' ? '文件不存在，可能已被移动或删除。' : '无法访问此文件。');
    }
    const stat = await fs.stat(real);
    const ext = path.extname(real).toLowerCase();
    if (!stat.isFile() || !KIND_BY_EXT[ext]) throw new UserError('不支持预览此类型的文件。');
    let rec = byPath.get(real);
    if (!rec) {
      rec = { id: randomBytes(18).toString('hex'), path: real };
      byPath.set(real, rec);
      byId.set(rec.id, rec);
    }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (rec.signature !== signature) rec.rendition = null;
    Object.assign(rec, { name: path.basename(real), ext, kind: KIND_BY_EXT[ext], size: stat.size, mtime: stat.mtimeMs, signature });
    return rec;
  }

  function describe(rec) {
    return { id: rec.id, name: rec.name, ext: rec.ext, kind: rec.kind, group: GROUPS[rec.kind], size: rec.size, mtime: rec.mtime, path: rec.path };
  }

  function lookup(id) {
    const rec = byId.get(String(id));
    if (!rec) throw new UserError('预览已过期，请重新打开文件。');
    return rec;
  }

  async function head(file, bytes = 8) {
    const handle = await fs.open(file, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(bytes), 0, bytes, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  // Runs `produce(target)` once per source version and caches the result.
  async function cached(rec, outExt, produce) {
    const key = createHash('sha256').update(`${rec.path}\0${rec.signature}\0${outExt}`).digest('hex').slice(0, 32);
    const dir = path.join(cacheDir, key);
    const out = path.join(dir, `${path.parse(rec.name).name}${outExt}`);
    if (existsSync(out)) return out;
    const job = queue.then(async () => {
      if (existsSync(out)) return;
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const staging = await fs.mkdtemp(path.join(dir, '.tmp-'));
      try {
        await produce(path.join(staging, path.basename(out)), staging);
        await fs.rename(path.join(staging, path.basename(out)), out);
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    });
    queue = job.catch(() => {});
    await job;
    return out;
  }

  async function probe(file) {
    if (!FFPROBE) return null;
    try {
      const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries',
        'format=duration,bit_rate:stream=codec_type,codec_name,width,height,sample_rate,channels',
        '-of', 'json', file], { timeout: 10000, maxBuffer: MB });
      const info = JSON.parse(stdout);
      const stream = (type) => info.streams?.find((s) => s.codec_type === type) ?? null;
      const v = stream('video');
      const a = stream('audio');
      return {
        video: v?.codec_name ?? null, audio: a?.codec_name ?? null,
        width: v?.width, height: v?.height, sampleRate: Number(a?.sample_rate) || undefined, channels: a?.channels,
        duration: Number(info.format?.duration) || 0,
      };
    } catch {
      return null;
    }
  }

  async function toPdf(rec, source = rec.path) {
    if (!SOFFICE) throw new UserError('预览 Office 文档需要安装 LibreOffice。');
    return cached(rec, '.pdf', async (target, staging) => {
      const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-preview-lo-'));
      // LibreOffice names the output after the input; give it a stable name.
      const input = path.join(staging, `${path.parse(target).name}${rec.ext}`);
      await fs.symlink(source, input);
      try {
        await run(SOFFICE, [`-env:UserInstallation=${pathToFileURL(profile).href}`, '--headless', '--norestore',
          '--convert-to', 'pdf', '--outdir', staging, input], { timeout: 180000, maxBuffer: 4 * MB });
      } catch {
        throw new UserError('LibreOffice 无法转换这个文件。');
      } finally {
        await fs.rm(profile, { recursive: true, force: true });
      }
      if (!existsSync(target)) throw new UserError('LibreOffice 无法转换这个文件。');
    });
  }

  async function toPng(rec) {
    return cached(rec, '.png', async (target) => {
      try {
        await run('/usr/bin/sips', ['-s', 'format', 'png', rec.path, '--out', target], { timeout: 90000 });
      } catch {
        if (!FFMPEG) throw new UserError('无法解码这张图片。');
        try {
          await run(FFMPEG, ['-nostdin', '-loglevel', 'error', '-y', '-i', rec.path, '-frames:v', '1', target], { timeout: 90000 });
        } catch {
          throw new UserError('无法解码这张图片。');
        }
      }
    });
  }

  async function ffmpeg(args, timeout) {
    try {
      await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout, maxBuffer: 4 * MB });
    } catch {
      throw new UserError('格式转换失败。');
    }
  }

  async function prepareMedia(rec) {
    const info = await probe(rec.path);
    const meta = info ? { duration: info.duration, width: info.width, height: info.height, codec: info.video ?? info.audio,
      sampleRate: info.sampleRate, channels: info.channels } : {};
    if (NATIVE.has(rec.ext) && (!info || (info.video ? PLAYABLE_VIDEO.has(info.video) : true))) {
      return { file: rec.path, mime: MIME[rec.ext], meta };
    }
    if (rec.kind === 'audio') {
      if (NATIVE_AUDIO.has(rec.ext) && (!info || PLAYABLE_AUDIO.has(info.audio))) return { file: rec.path, mime: MIME[rec.ext], meta };
      if (!FFMPEG) throw new UserError('播放此音频格式需要 ffmpeg（brew install ffmpeg）。');
      const out = await cached(rec, '.m4a', (target) => ffmpeg(['-i', rec.path, '-vn', '-c:a', 'aac', '-b:a', '256k', target], 600000));
      return { file: out, mime: 'audio/mp4', converted: true, meta };
    }
    const playable = info && PLAYABLE_VIDEO.has(info.video) && (!info.audio || PLAYABLE_AUDIO.has(info.audio));
    if (playable && ['.mov', '.m4v'].includes(rec.ext)) return { file: rec.path, mime: MIME[rec.ext], meta };
    if (!FFMPEG) throw new UserError('播放此视频格式需要 ffmpeg（brew install ffmpeg）。');
    if (playable && ['h264', 'hevc'].includes(info.video) && (!info.audio || ['aac', 'mp3'].includes(info.audio))) {
      // Same codecs, different container: a lossless remux takes seconds.
      const out = await cached(rec, '.mp4', (target) => ffmpeg(['-i', rec.path, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy',
        ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : []), '-movflags', '+faststart', target], 300000));
      return { file: out, mime: 'video/mp4', converted: true, meta };
    }
    if (info && info.duration > 30 * 60) throw new UserError('视频超过 30 分钟且编码不受支持，转换太慢，建议用默认应用打开。');
    const out = await cached(rec, '.mp4', (target) => ffmpeg(['-i', rec.path, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', "scale='min(1920,iw)':-2", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', target], 1200000));
    return { file: out, mime: 'video/mp4', converted: true, meta };
  }

  // bsdtar (macOS /usr/bin/tar) reads zip, 7z, rar, iso, cab, xar and tarballs.
  async function listArchive(rec) {
    let stdout;
    try {
      ({ stdout } = await run('/usr/bin/tar', ['-tvf', rec.path], { timeout: 30000, maxBuffer: 64 * MB }));
    } catch {
      throw new UserError('无法读取这个压缩包（可能已加密或格式不受支持）。');
    }
    const entries = [];
    let total = 0;
    for (const line of stdout.split('\n')) {
      // e.g. "-rw-r--r--  0 user staff   1234 Oct 11 13:43 dir/file.txt"
      const m = /^(\S)\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3}\s+\d+\s+[\d:]+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const size = Number(m[2]);
      total += size;
      if (entries.length < 5000) entries.push({ name: m[4], dir: m[1] === 'd' || m[4].endsWith('/'), size, date: m[3] });
    }
    return { entries, count: entries.length, total, truncated: entries.length >= 5000 };
  }

  async function prepare(rec) {
    switch (rec.kind) {
      case 'pdf': {
        if (rec.ext === '.ai' && (await head(rec.path, 5)).toString() !== '%PDF-') throw new UserError('这个 .ai 文件没有内嵌 PDF，无法预览。');
        return { view: 'pdf', file: rec.path, mime: MIME['.pdf'] };
      }
      case 'office': {
        const magic = await head(rec.path, 4);
        // .key is also a common extension for PEM keys: show those as text.
        if (rec.ext === '.key' && magic.toString('latin1') !== 'PK\u0003\u0004') return { view: 'text', file: rec.path, mime: MIME['.txt'] };
        return { view: 'pdf', file: await toPdf(rec), mime: MIME['.pdf'], converted: true };
      }
      case 'table':
        if (rec.size > 50 * MB) throw new UserError('表格超过 50 MB，请用默认应用打开。');
        return { view: 'table', file: rec.path, mime: MIME[rec.ext] };
      case 'image': {
        if (NATIVE_IMAGE.has(rec.ext) || NATIVE.has(rec.ext)) return { view: 'image', file: rec.path, mime: MIME[rec.ext] };
        return { view: 'image', file: await toPng(rec), mime: MIME['.png'], converted: true };
      }
      case 'video':
      case 'audio':
        return { view: rec.kind, ...(await prepareMedia(rec)) };
      case 'font':
        return { view: 'font', file: rec.path, mime: MIME[rec.ext] };
      case 'archive':
        return { view: 'archive', file: rec.path, mime: 'application/octet-stream', listing: await listArchive(rec) };
      default:
        throw new UserError('不支持预览此类型的文件。');
    }
  }

  return {
    async open(input) {
      return describe(await register(input));
    },

    // Returns how the frontend should render the file; converts if needed.
    async prepare(id) {
      const rec = await register(lookup(id).path);
      if (!rec.rendition) rec.rendition = await prepare(rec);
      const { view, mime, converted, meta, listing } = rec.rendition;
      return { ...describe(rec), view, mime, converted: !!converted, meta, listing };
    },

    async reveal(id, action) {
      const rec = lookup(id);
      await run('/usr/bin/open', action === 'reveal' ? ['-R', rec.path] : [rec.path], { timeout: 10000 });
      return { ok: true };
    },

    // Files the conversation mentioned (tool calls, edits, links), most
    // mentioned first. The conversation store is a SQLite file whose step
    // payloads contain absolute paths in plain UTF-8, so a byte scan suffices.
    async conversationFiles(conversationId) {
      if (!/^[0-9a-f-]{36}$/i.test(String(conversationId))) return { files: [] };
      // dataDir = <app>/sidecar_data/<plugin>/<sidecar>/data
      const appDir = path.resolve(dataDir, '..', '..', '..', '..');
      let raw;
      try {
        raw = (await fs.readFile(path.join(appDir, 'conversations', `${conversationId}.db`))).toString('utf8');
      } catch {
        return { files: [] };
      }
      const counts = new Map();
      for (const m of raw.matchAll(/(?:file:\/\/)?((?:\/Users|\/Volumes|\/private|\/tmp)\/[^\0-\x1f"'<>|*?\\]{1,400}?\.[A-Za-z0-9]{2,5})(?=[^A-Za-z0-9]|$)/g)) {
        let p = m[1];
        try { p = decodeURIComponent(p); } catch { /* keep raw */ }
        if (!KIND_BY_EXT[path.extname(p).toLowerCase()] || p.includes('/.system_generated/')) continue;
        counts.set(p, (counts.get(p) ?? 0) + 1);
      }
      const files = [];
      const seen = new Set();
      // Agent-internal copies (brain artifacts, pasted media) duplicate files
      // that also exist in the project; list those last and only once.
      const internal = (p) => /\/\.gemini\/antigravity\/brain\//.test(p);
      const ordered = [...counts.keys()].filter((p) => !/\/\.(?!gemini\/)[^/]+\//.test(p.replace(os.homedir(), '')))
        .sort((a, b) => internal(a) - internal(b));
      for (const p of ordered) {
        try {
          const rec = await register(p);
          const key = `${rec.name}\0${rec.size}`;
          if (seen.has(rec.id) || seen.has(key)) continue;
          seen.add(rec.id);
          seen.add(key);
          files.push({ ...describe(rec), dir: shortDir(rec.path), mentions: counts.get(p) });
        } catch { /* deleted or unreadable */ }
        if (files.length >= 200) break;
      }
      // Deliverables first (documents, tables, media), then images; newest first.
      const rank = { document: 0, table: 1, media: 2, other: 3, image: 4 };
      files.sort((a, b) => rank[a.group] - rank[b.group] || b.mtime - a.mtime);
      return { files };
    },

    // Previewable files in the workspace, newest first.
    async list(uris = []) {
      const files = [];
      let budget = 20000;
      async function walk(dir, root, depth) {
        if (depth > 8 || files.length >= 800) return;
        let entries;
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (--budget < 0 || files.length >= 800) return;
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, root, depth + 1);
          else if (entry.isFile() && KIND_BY_EXT[path.extname(entry.name).toLowerCase()]) {
            try {
              const rec = await register(full);
              files.push({ ...describe(rec), dir: path.relative(root, path.dirname(rec.path)) });
            } catch { /* unreadable */ }
          }
        }
      }
      for (const uri of Array.isArray(uris) ? uris : []) {
        try {
          const root = await fs.realpath(fileURLToPath(uri));
          await walk(root, root, 0);
        } catch { /* workspace folder unavailable */ }
      }
      files.sort((a, b) => b.mtime - a.mtime);
      return { files, truncated: budget < 0 || files.length >= 800 };
    },

    async stream(id, req, res) {
      const rec = lookup(id);
      if (!rec.rendition) throw new UserError('文件尚未准备好。');
      const { file, mime } = rec.rendition;
      const stat = await fs.stat(file);
      const headers = {
        'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        // Media streams from the loopback port; let the panel read them too (ids are unguessable).
        'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range',
      };
      const range = parseRange(req.headers.range, stat.size);
      if (range === false) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${stat.size}` });
        res.end();
        return;
      }
      const { start, end } = range ?? { start: 0, end: stat.size - 1 };
      headers['Content-Length'] = String(end - start + 1);
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      res.writeHead(range ? 206 : 200, headers);
      if (req.method === 'HEAD' || stat.size === 0) {
        res.end();
        return;
      }
      await pipeline(createReadStream(file, { start, end }), res).catch(() => {});
    },

    async cleanCache(maxAgeDays = 14) {
      const entries = await fs.readdir(cacheDir).catch(() => []);
      for (const name of entries) {
        const full = path.join(cacheDir, name);
        const stat = await fs.stat(full).catch(() => null);
        if (stat && Date.now() - stat.mtimeMs > maxAgeDays * 86400000) await fs.rm(full, { recursive: true, force: true });
      }
    },
  };
}

// Last two folders, e.g. "scratch/multiplication_table".
function shortDir(file) {
  if (file.includes(`${path.sep}.gemini${path.sep}antigravity${path.sep}brain${path.sep}`)) return '对话产物';
  const parts = path.dirname(file).replace(os.homedir(), '~').split(path.sep);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
}

// null = no/ignored Range header, false = unsatisfiable.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  return start <= end && start < size ? { start, end } : false;
}
