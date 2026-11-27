import { spawnSync } from 'node:child_process';

// Variables that would redirect git away from the shadow repo if inherited
// (for example when an agent runs inside a git hook).
const GIT_ENV_TO_DROP = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_NAMESPACE',
  'GIT_PREFIX', 'GIT_CEILING_DIRECTORIES',
];

function gitEnv() {
  const env = { ...process.env };
  for (const k of GIT_ENV_TO_DROP) delete env[k];
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'undoagent',
    GIT_AUTHOR_EMAIL: 'undoagent@localhost',
    GIT_COMMITTER_NAME: 'undoagent',
    GIT_COMMITTER_EMAIL: 'undoagent@localhost',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
  });
  return env;
}

/**
 * Run git against a store's shadow repository, with the project as work tree.
 * The project's own .git directory is never read or written.
 */
export function git(store, args, opts = {}) {
  const full = [
    '--git-dir', store.gitDir,
    '--work-tree', store.root,
    '--literal-pathspecs',
    '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false',
    '-c', 'core.quotepath=false',
    '-c', 'core.longpaths=true',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.fscache=true', // Git for Windows: cache file stats (ignored elsewhere)
    '-c', 'core.preloadindex=true',
    ...args,
  ];
  return run(full, { cwd: store.root, ...opts });
}

export function run(args, opts = {}) {
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    maxBuffer: 1 << 30,
    env: { ...gitEnv(), ...opts.env },
    stdio: opts.stdio,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0 && !opts.allowFail) {
    const msg = (r.stderr || '').toString().trim();
    throw new Error(`git ${args.filter((a) => !a.includes('=')).slice(-3).join(' ')} failed: ${msg}`);
  }
  return r;
}
