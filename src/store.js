import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { git, run } from './git.js';

export const NAME = 'undoagent';

// Never snapshot trees bigger than this on first contact; it usually means
// the agent was started in a home folder or a drive root.
const MAX_INITIAL_FILES = 50_000;

const DEFAULT_EXCLUDES = [
  'node_modules/', '.venv/', 'venv/', '__pycache__/', '.tox/', '.gradle/',
  '.next/', '.nuxt/', '.turbo/', '.cache/', '.parcel-cache/', 'target/debug/',
  'target/release/', '*.pyc', '.DS_Store', 'Thumbs.db',
];

export function homeDir() {
  return process.env.UNDOAGENT_HOME || path.join(os.homedir(), `.${NAME}`);
}

export function storeFor(root) {
  const real = fs.realpathSync.native(path.resolve(root));
  const key = process.platform === 'win32' ? real.toLowerCase() : real;
  const id = createHash('sha1').update(key).digest('hex').slice(0, 16);
  const dir = path.join(homeDir(), 'projects', id);
  return {
    id,
    root: real,
    dir,
    gitDir: path.join(dir, 'shadow.git'),
    historyFile: path.join(dir, 'history.json'),
    metaFile: path.join(dir, 'project.json'),
  };
}

/** Walk up from `start` to the nearest directory that already has a store. */
export function findStore(start) {
  let cur = path.resolve(start);
  for (;;) {
    const s = storeFor(cur);
    if (fs.existsSync(s.historyFile)) return s;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/** Refuse obviously wrong roots such as the home folder or a drive root. */
export function unsafeRootReason(root) {
  // Compare real paths: on macOS /var is a symlink to /private/var, and home
  // folders can be symlinks too.
  const real = (p) => {
    const abs = path.resolve(p);
    let r;
    try { r = fs.realpathSync.native(abs); } catch { r = abs; }
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const r = real(root);
  if (path.dirname(r) === r) return 'it is a filesystem root';
  if (r === real(os.homedir())) return 'it is your home folder';
  return null;
}

export function ensureStore(store) {
  if (fs.existsSync(path.join(store.gitDir, 'HEAD'))) return false;
  fs.mkdirSync(store.dir, { recursive: true });
  run(['init', '--quiet', '--bare', store.gitDir]);
  for (const [k, v] of [
    ['core.bare', 'false'],
    ['core.autocrlf', 'false'],
    ['core.longpaths', 'true'],
    ['gc.autoDetach', 'false'],
    ['advice.addEmbeddedRepo', 'false'],
    ['core.untrackedCache', 'true'],
    ['index.version', '4'],
  ]) run(['--git-dir', store.gitDir, 'config', k, v]);
  fs.mkdirSync(path.join(store.gitDir, 'info'), { recursive: true });
  fs.writeFileSync(path.join(store.gitDir, 'info', 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
  fs.writeFileSync(store.metaFile, JSON.stringify({ root: store.root, created: new Date().toISOString() }, null, 2));
  if (!fs.existsSync(store.historyFile)) writeHistory(store, { nextId: 1, entries: [] });
  return true;
}

/** Count untracked, non-ignored files; used as a size guard before the first snapshot. */
export function countCandidateFiles(store) {
  const r = git(store, ['ls-files', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' });
  let n = 0;
  for (const b of r.stdout) if (b === 0) n++;
  return n;
}

export function checkSize(store) {
  const n = countCandidateFiles(store);
  if (n > MAX_INITIAL_FILES) {
    throw new Error(`${store.root} has ${n} files (limit ${MAX_INITIAL_FILES}); refusing to track it. Add a .gitignore or run ${NAME} from the project folder.`);
  }
  return n;
}

// Folders that were too big to track are remembered, so automatic tracking
// (plugin or --global) doesn't rescan them on every prompt.
function skipMarker(store) {
  return path.join(homeDir(), 'skipped', store.id);
}

export function isSkipped(store) {
  return fs.existsSync(skipMarker(store));
}

export function markSkipped(store, reason) {
  for (const name of fs.readdirSync(store.dir)) {
    if (name !== 'lock') fs.rmSync(path.join(store.dir, name), { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(skipMarker(store)), { recursive: true });
  fs.writeFileSync(skipMarker(store), `${store.root}\n${reason}\n`);
}

export function clearSkipped(store) {
  fs.rmSync(skipMarker(store), { force: true });
}

// ---------- locking ----------

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withLock(store, fn) {
  fs.mkdirSync(store.dir, { recursive: true });
  const lock = path.join(store.dir, 'lock');
  const started = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch { /* lock vanished; retry */ }
      if (Date.now() - started > 60_000) throw new Error('timed out waiting for another undoagent process');
      sleep(50);
    }
  }
  try {
    const idxLock = path.join(store.gitDir, 'index.lock');
    if (fs.existsSync(idxLock)) fs.rmSync(idxLock, { force: true }); // stale: we hold the only lock
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// ---------- history ----------

export function readHistory(store) {
  try {
    return JSON.parse(fs.readFileSync(store.historyFile, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { nextId: 1, entries: [] };
    throw e;
  }
}

export function writeHistory(store, h) {
  const tmp = `${store.historyFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(h, null, 1));
  fs.renameSync(tmp, store.historyFile);
}

// ---------- snapshots ----------

// Each git call costs a process start (about 100 ms on Windows), while the
// work itself is tiny, so snapshots use as few calls as possible: "add" and
// "commit" (which exits early when nothing changed). The resulting commit id
// is read straight from the ref file.

/** Current snapshot commit, or null before the first one. */
export function headCommit(store) {
  try {
    const head = fs.readFileSync(path.join(store.gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref: (refs\/\S+)$/)?.[1];
    if (ref) {
      const loose = path.join(store.gitDir, ...ref.split('/'));
      if (fs.existsSync(loose)) return fs.readFileSync(loose, 'utf8').trim();
      if (!fs.existsSync(path.join(store.gitDir, 'packed-refs'))) return null; // unborn branch
    }
  } catch { /* fall through to git */ }
  const r = git(store, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Record the current state of the work tree; returns a commit id. */
export function snapshot(store, message) {
  git(store, ['add', '--all', '--ignore-errors', '.'], { allowFail: true });
  const before = headCommit(store);
  const args = [
    '-c', `core.hooksPath=${path.join(store.dir, 'no-hooks')}`, // never run the user's global git hooks
    'commit', '--quiet', '--no-verify', '--no-status', '-m', message || 'snapshot',
  ];
  if (!before) args.push('--allow-empty');
  const r = git(store, args, { allowFail: true, env: { LC_ALL: 'C', LANG: 'C' } });
  if (r.status !== 0) {
    const out = `${r.stdout}${r.stderr}`;
    if (before && /nothing to commit|nothing added|no changes added/.test(out)) return before;
    throw new Error(`snapshot failed: ${out.trim()}`);
  }
  return headCommit(store);
}

/** Files that differ between two snapshots: [{ status: 'A'|'M'|'D'|'T', path }] */
export function changedFiles(store, from, to) {
  if (from === to) return [];
  const out = git(store, ['diff', '--name-status', '-z', '--no-renames', from, to]).stdout;
  const parts = out.split('\0').filter((p) => p !== '');
  const files = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ status: parts[i][0], path: parts[i + 1] });
  return files;
}

/**
 * Make the listed files match `target` again, where `files` came from
 * changedFiles(target, other). Files added after `target` are deleted.
 */
export function restoreFiles(store, target, files) {
  const toRestore = files.filter((f) => f.status !== 'A').map((f) => f.path);
  const toDelete = files.filter((f) => f.status === 'A').map((f) => f.path);
  if (toRestore.length) {
    git(store, ['restore', `--source=${target}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
      input: toRestore.join('\0'),
    });
  }
  for (const rel of toDelete) {
    const abs = path.join(store.root, rel);
    fs.rmSync(abs, { force: true });
    removeEmptyParents(store.root, path.dirname(abs));
  }
}

function removeEmptyParents(root, dir) {
  const rootN = path.resolve(root);
  let cur = path.resolve(dir);
  while (cur.startsWith(rootN) && cur !== rootN) {
    try {
      if (fs.readdirSync(cur).length) return;
      fs.rmdirSync(cur);
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}
