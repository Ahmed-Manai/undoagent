import fs from 'node:fs';
import { git } from './git.js';
import { findStore, readHistory, storeFor, unsafeRootReason, NAME } from './store.js';
import { initStore, undo, redo, rewind, fillFileLists, ConflictError } from './turns.js';
import { AGENTS, agentById, globalAgents, runHook, installHooks, uninstallHooks, hooksInstalled } from './agents.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const forced = process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== '0';
const color = (process.stdout.isTTY || forced) && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = paint('2');
const bold = paint('1');
const red = paint('31');
const green = paint('32');
const yellow = paint('33');

const HELP = `${bold(NAME)} ${pkg.version} - undo for AI coding agents

Usage:
  ${NAME} init [--global]      Start tracking this project, or every project
                               with --global. Sets up hooks for the agents
                               found on this machine (Claude Code, Codex);
                               pick them with --agent claude,codex
  ${NAME} list [-n N]          Show recent agent turns
  ${NAME} diff [ID] [--stat]   Show what a turn changed (default: latest)
  ${NAME} undo [ID] [--force]  Undo the latest turn, or turn ID
  ${NAME} redo [--force]       Re-apply the last undo or rewind
  ${NAME} rewind ID [--force]  Put every file back to how it was before turn ID
  ${NAME} status               Show tracking status for this project
  ${NAME} uninstall [--global] Remove the hooks (history is kept)

Snapshots live in ~/.${NAME}; your own .git is never touched.`;

function parse(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-n') flags.n = Number(argv[++i]);
    else if (a === '--agent') flags.agent = argv[++i];
    else if (a.startsWith('--agent=')) flags.agent = a.slice(8);
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else if (a === '-h') flags.help = true;
    else if (a === '-v') flags.version = true;
    else pos.push(a);
  }
  return { cmd: pos[0], args: pos.slice(1), flags };
}

function requireStore() {
  const s = findStore(process.cwd());
  if (!s) throw new Error(`no history for this folder yet. Run "${NAME} init" first.`);
  return s;
}

function parseId(v, required) {
  if (v === undefined) {
    if (required) throw new Error('missing turn ID (see "list")');
    return undefined;
  }
  const n = Number(String(v).replace(/^#/, ''));
  if (!Number.isInteger(n) || n < 1) throw new Error(`not a turn ID: ${v}`);
  return n;
}

function when(iso) {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  const hm = d.toTimeString().slice(0, 5);
  return today ? hm : `${d.toISOString().slice(5, 10)} ${hm}`;
}

function oneLine(s, max) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function shortAgent(id) {
  return { claude: 'claude', 'claude-code': 'claude', codex: 'codex' }[id] || id || '';
}

function pickAgents(spec) {
  if (spec) return [...new Set(spec.split(',').map((s) => s.trim()).filter(Boolean))].map(agentById);
  const found = Object.values(AGENTS).filter((a) => a.detect());
  return found.length ? found : [AGENTS.claude];
}

function describe(e) {
  if (e.type === 'turn') return oneLine(e.prompt, 60) || dim('(no prompt)');
  return yellow(e.label);
}

function printFiles(files, max = 15) {
  const mark = { A: green('+'), D: red('-'), M: yellow('~'), T: yellow('~') };
  for (const f of files.slice(0, max)) console.log(`    ${mark[f.status] || '?'} ${f.path}`);
  if (files.length > max) console.log(dim(`    … and ${files.length - max} more`));
}

const commands = {
  init({ flags }) {
    const root = process.cwd();
    const global = !!flags.global;
    const unsafe = unsafeRootReason(root);
    if (unsafe && !global) throw new Error(`won't track ${root}: ${unsafe}. Run this inside a project folder.`);
    const agents = pickAgents(flags.agent);
    if (!unsafe) {
      const created = initStore(storeFor(root));
      console.log(created ? `${green('✓')} Baseline snapshot taken of ${root}` : `${green('✓')} Already tracking ${root}`);
    }
    let ephemeral = false;
    for (const agent of agents) {
      const r = installHooks(agent, { global, root });
      ephemeral ||= r.ephemeral;
      console.log(`${green('✓')} ${agent.label} hooks added to ${r.file}`);
      console.log(dim(`    ${agent.afterInstall}`));
    }
    if (ephemeral) {
      console.log(yellow(`! You ran ${NAME} through npx. Install it so the hooks keep working:`));
      console.log(`    npm install -g ${NAME}`);
    }
    const names = agents.map((a) => a.label).join(' and ');
    console.log(`
Every ${names} prompt in ${global ? 'any project' : 'this project'} is now a turn you can undo.`);
    console.log(`Try it, then run: ${bold(`${NAME} list`)}`);
  },

  uninstall({ flags }) {
    const global = !!flags.global;
    const agents = flags.agent ? pickAgents(flags.agent) : Object.values(AGENTS);
    for (const agent of agents) {
      const r = uninstallHooks(agent, { global, root: process.cwd() });
      if (r.shared) console.log(dim(`${agent.label} hooks are shared by all projects; remove them with "${NAME} uninstall --global".`));
      else if (r.removed) console.log(`${green('✓')} Removed ${agent.label} hooks from ${r.file}`);
    }
  },

  list({ flags }) {
    const store = requireStore();
    const h = fillFileLists(store);
    const entries = h.entries.slice(-(flags.n || 20)).reverse();
    if (!entries.length) {
      console.log('No agent turns recorded yet. Ask your agent to change something, then run this again.');
      return;
    }
    console.log(dim('   #  time         agent   files  what'));
    for (const e of entries) {
      const state = e.post === null ? yellow(' [running]') : e.undoneBy ? dim(` [undone by #${e.undoneBy}]`) : '';
      const files = e.post === null ? '  …' : String(e.files.length).padStart(3);
      const agent = (e.type === 'turn' ? shortAgent(e.agent) : '').padEnd(6);
      const line = `${String(e.id).padStart(4)}  ${when(e.start).padEnd(11)}  ${agent} ${files}   ${describe(e)}${state}`;
      console.log(e.undoneBy ? dim(line) : line);
    }
  },

  diff({ args, flags }) {
    const store = requireStore();
    const h = readHistory(store);
    const id = parseId(args[0]);
    const e = id === undefined
      ? h.entries.filter((x) => x.post !== null).at(-1)
      : h.entries.find((x) => x.id === id);
    if (!e) throw new Error(id === undefined ? 'no finished turns yet' : `no entry #${id}`);
    if (e.post === null) throw new Error(`turn #${e.id} is still running`);
    console.log(`${bold(`#${e.id}`)} ${describe(e)}\n`);
    const extra = flags.stat ? ['--stat'] : [];
    if (color) extra.push('--color=always');
    const r = git(store, ['--no-pager', 'diff', ...extra, e.pre, e.post], { stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(r.stdout);
  },

  undo({ args, flags }) {
    const store = requireStore();
    const { entry, target } = undo(store, { id: parseId(args[0]), force: !!flags.force });
    console.log(`${green('✓')} Undid #${target.id}: ${describe(target)}`);
    printFiles(entry.files);
    console.log(dim(`  Changed your mind? ${NAME} redo`));
  },

  redo({ flags }) {
    const store = requireStore();
    const { entry, target } = redo(store, { force: !!flags.force });
    console.log(`${green('✓')} Redid: ${target.label}`);
    printFiles(entry.files);
  },

  rewind({ args, flags }) {
    const store = requireStore();
    const id = parseId(args[0], true);
    const { entry, undoneTurns } = rewind(store, { id, force: !!flags.force });
    console.log(`${green('✓')} Project restored to before #${id} (undid ${undoneTurns.map((n) => '#' + n).join(', ') || 'nothing'})`);
    printFiles(entry.files);
    console.log(dim(`  Changed your mind? ${NAME} redo`));
  },

  status() {
    const root = process.cwd();
    const store = findStore(root);
    console.log(`project:  ${store ? store.root : dim('(not tracked)')}`);
    if (store) {
      const h = readHistory(store);
      console.log(`turns:    ${h.entries.filter((e) => e.type === 'turn').length}`);
      console.log(`storage:  ${store.dir}`);
    }
    const everywhere = globalAgents();
    for (const agent of Object.values(AGENTS)) {
      const here = hooksInstalled(agent, { global: false, root: store?.root || root });
      const user = hooksInstalled(agent, { global: true, root });
      const where = here ? 'this project' : user ? (everywhere[agent.id] ? 'every project' : 'tracked projects') : null;
      console.log(`${(agent.label + ':').padEnd(10)}${where ? green(`hooks on (${where})`) : dim('hooks off')}`);
    }
  },

  hook({ args }) {
    let raw = '';
    try { raw = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
    runHook(args[0], raw);
  },
};

export function main(argv) {
  const { cmd, args, flags } = parse(argv);
  if (flags.version) return console.log(pkg.version);
  if (!cmd || flags.help || cmd === 'help') return console.log(HELP);
  const fn = commands[cmd];
  if (!fn) {
    console.error(`${red('error')} unknown command "${cmd}"\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  try {
    fn({ args, flags });
  } catch (e) {
    if (e instanceof ConflictError) {
      console.error(`${red('✗')} Not undone: these files changed after the agent's turn, and undoing would overwrite that work:`);
      for (const f of e.files) console.error(`    ${f}`);
      console.error(dim(`  Use --force to undo anyway, or "${NAME} diff" to compare first.`));
    } else {
      console.error(`${red('error')} ${e.message}`);
    }
    process.exitCode = 1;
  }
}
