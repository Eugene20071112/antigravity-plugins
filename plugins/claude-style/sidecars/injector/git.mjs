// Git operations for the injected Git panel. Every call runs `git` with an
// argument array (no shell) inside the repository that contains `cwd`.

import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
const GH = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'].find(existsSync);
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };

async function git(cwd, args, { timeout = 30000 } = {}) {
  try {
    const { stdout } = await run('/usr/bin/git', args, { cwd, env: ENV, timeout, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const message = (err.stderr || err.stdout || err.message || '').trim().split('\n').slice(-4).join('\n');
    throw new Error(message || 'git 命令失败');
  }
}

// Paths come from `git status`, but double-check they stay relative.
function safePaths(paths) {
  const list = (Array.isArray(paths) ? paths : [paths]).map(String);
  if (!list.length || list.some((p) => !p || p.startsWith('/') || p.split('/').includes('..'))) throw new Error('无效的文件路径');
  return list;
}

async function root(cwd) {
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('没有可用的工作区文件夹');
  try {
    return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

function parseStatus(text) {
  const files = [];
  const head = { branch: null, upstream: null, ahead: 0, behind: 0 };
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.head ')) head.branch = line.slice(14);
    else if (line.startsWith('# branch.upstream ')) head.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const [, a, b] = /\+(\d+) -(\d+)/.exec(line) ?? [];
      head.ahead = Number(a) || 0;
      head.behind = Number(b) || 0;
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const parts = line.split(' ');
      const xy = parts[1];
      let path = parts.slice(line.startsWith('1 ') ? 8 : 9).join(' ');
      let from = null;
      if (line.startsWith('2 ')) [path, from] = path.split('\t');
      files.push({ path, from, index: xy[0], work: xy[1] });
    } else if (line.startsWith('? ')) files.push({ path: line.slice(2), index: '?', work: '?' });
    else if (line.startsWith('u ')) files.push({ path: line.split(' ').slice(10).join(' '), index: 'U', work: 'U' });
  }
  return { head, files };
}

function remoteWebUrl(remote) {
  const m = /^(?:git@|ssh:\/\/git@|https?:\/\/)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim());
  return m ? `https://${m[1]}/${m[2]}` : null;
}

export function createGit() {
  const ops = {
    async status(dir) {
      const top = await root(dir);
      if (!top) return { repo: false, dir };
      const { head, files } = parseStatus(await git(top, ['status', '--porcelain=v2', '--branch', '-uall']));
      let remote = null;
      try { remote = remoteWebUrl(await git(top, ['remote', 'get-url', 'origin'])); } catch { /* no origin */ }
      return { repo: true, root: top, ...head, files, remote, gh: !!GH };
    },

    async diff(top, { path, staged, untracked }) {
      const [p] = safePaths(path);
      if (untracked) {
        // `--no-index` exits 1 when the files differ, which is always here.
        try {
          const { stdout } = await run('/usr/bin/git', ['diff', '--no-index', '--no-color', '--', '/dev/null', p], { cwd: top, env: ENV, maxBuffer: 32 * 1024 * 1024 });
          return { diff: stdout };
        } catch (err) {
          return { diff: err.stdout || '' };
        }
      }
      return { diff: await git(top, ['diff', '--no-color', ...(staged ? ['--cached'] : []), '--', p]) };
    },

    async stage(top, { paths }) {
      await git(top, ['add', '--', ...safePaths(paths)]);
      return { ok: true };
    },
    async stageAll(top) {
      await git(top, ['add', '-A']);
      return { ok: true };
    },
    async unstage(top, { paths }) {
      await git(top, ['restore', '--staged', '--', ...safePaths(paths)]);
      return { ok: true };
    },
    async discard(top, { paths, untracked }) {
      const list = safePaths(paths);
      if (untracked) await git(top, ['clean', '-f', '--', ...list]);
      else await git(top, ['restore', '--worktree', '--source=HEAD', '--', ...list]);
      return { ok: true };
    },

    async commit(top, { message, all }) {
      if (!String(message || '').trim()) throw new Error('请填写提交信息');
      if (all) await git(top, ['add', '-A']);
      const out = await git(top, ['commit', '-m', String(message)]);
      return { ok: true, summary: out.split('\n')[0] };
    },

    async push(top) {
      const { head } = parseStatus(await git(top, ['status', '--porcelain=v2', '--branch']));
      const args = head.upstream ? ['push'] : ['push', '--set-upstream', 'origin', head.branch];
      await git(top, args, { timeout: 120000 });
      return { ok: true };
    },
    async pull(top) {
      await git(top, ['pull', '--ff-only'], { timeout: 120000 });
      return { ok: true };
    },
    async fetch(top) {
      await git(top, ['fetch', '--prune'], { timeout: 120000 });
      return { ok: true };
    },

    async branches(top) {
      const out = await git(top, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)\t%(HEAD)\t%(committerdate:relative)', 'refs/heads']);
      return {
        branches: out.trim().split('\n').filter(Boolean).map((l) => {
          const [name, head, when] = l.split('\t');
          return { name, current: head === '*', when };
        }),
      };
    },
    async checkout(top, { branch }) {
      if (!/^[\w./-]+$/.test(String(branch))) throw new Error('无效的分支名');
      await git(top, ['switch', String(branch)]);
      return { ok: true };
    },
    async createBranch(top, { branch }) {
      if (!/^[\w./-]+$/.test(String(branch)) || String(branch).startsWith('-')) throw new Error('分支名只能包含字母、数字、. _ / -');
      await git(top, ['switch', '-c', String(branch)]);
      return { ok: true };
    },

    async log(top) {
      const out = await git(top, ['log', '-15', '--format=%h\t%s\t%an\t%cr']);
      return { commits: out.trim().split('\n').filter(Boolean).map((l) => {
        const [hash, subject, author, when] = l.split('\t');
        return { hash, subject, author, when };
      }) };
    },

    // Prefer `gh pr create --web`; otherwise open the compare page.
    async pr(top) {
      const { head } = parseStatus(await git(top, ['status', '--porcelain=v2', '--branch']));
      if (GH) {
        await run(GH, ['pr', 'create', '--web'], { cwd: top, env: ENV, timeout: 60000 });
        return { ok: true };
      }
      const remote = remoteWebUrl(await git(top, ['remote', 'get-url', 'origin']));
      if (!remote) throw new Error('没有找到 origin 远程仓库');
      const url = remote.includes('gitlab')
        ? `${remote}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(head.branch)}`
        : `${remote}/compare/${encodeURIComponent(head.branch)}?expand=1`;
      await run('/usr/bin/open', [url]);
      return { ok: true, url };
    },

    async init(dir) {
      await git(dir, ['init']);
      return { ok: true };
    },
  };

  return {
    async run(op, cwd, args) {
      if (!ops[op]) throw new Error(`unknown git op ${op}`);
      if (op === 'status' || op === 'init') return ops[op](cwd, args);
      const top = await root(cwd);
      if (!top) throw new Error('这个文件夹不是 Git 仓库');
      return ops[op](top, args);
    },
  };
}
