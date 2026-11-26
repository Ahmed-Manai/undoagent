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
  const r = path.resolve(root);
  if (path.dirname(r) === r) return 'it is a filesystem root';
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (norm(r) === norm(path.resolve(os.homedir()))) return 'it is your home folder';
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

function headCommit(store) {
  const r = git(store, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Record the current state of the work tree; returns a commit id. */
export function snapshot(store, message) {
  git(store, ['add', '--all', '--ignore-errors', '.'], { allowFail: true });
  const tree = git(store, ['write-tree']).stdout.trim();
  const parent = headCommit(store);
  if (parent) {
    const parentTree = git(store, ['rev-parse', `${parent}^{tree}`]).stdout.trim();
    if (parentTree === tree) return parent;
  }
  const args = ['commit-tree', tree, '-m', message || 'snapshot'];
  if (parent) args.push('-p', parent);
  const commit = git(store, args).stdout.trim();
  git(store, ['update-ref', 'HEAD', commit]);
  return commit;
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
