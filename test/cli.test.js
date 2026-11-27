import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/undoagent.js', import.meta.url));
let tmp, proj, home;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'undoagent-test-'));
  proj = path.join(tmp, 'project');
  home = path.join(tmp, 'home');
  fs.mkdirSync(proj);
  fs.mkdirSync(home);
});

function env() {
  return { ...process.env, UNDOAGENT_HOME: path.join(tmp, 'store'), HOME: home, USERPROFILE: home, NO_COLOR: '1' };
}

function cli(...args) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: proj, env: env(), encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function hook(event, extra = {}, agent = 'claude') {
  const input = JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: proj, ...extra });
  const extraEnv = agent === 'claude' ? { CLAUDE_PROJECT_DIR: proj } : {};
  const r = spawnSync(process.execPath, [BIN, 'hook', agent], {
    cwd: proj, env: { ...env(), ...extraEnv }, input, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'hook must not print to stdout');
  return r;
}

const p = (f) => path.join(proj, f);
const write = (f, s) => { fs.mkdirSync(path.dirname(p(f)), { recursive: true }); fs.writeFileSync(p(f), s); };
const read = (f) => fs.readFileSync(p(f), 'utf8');
const exists = (f) => fs.existsSync(p(f));

/** Simulate one Claude Code turn: prompt submitted, agent works, agent stops. */
function turn(prompt, work, session = 's1') {
  hook('UserPromptSubmit', { prompt, session_id: session });
  work();
  hook('Stop', { session_id: session });
}

test('init installs project hooks idempotently and keeps other settings', () => {
  write('.claude/settings.local.json', JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
  assert.equal(cli('init').code, 0);
  assert.equal(cli('init').code, 0);
  const s = JSON.parse(read('.claude/settings.local.json'));
  assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.equal(s.hooks.Stop.length, 1);
  assert.match(s.hooks.Stop[0].hooks[0].command, /undoagent\.js" hook claude$/);
  assert.equal(cli('uninstall').code, 0);
  const after = JSON.parse(read('.claude/settings.local.json'));
  assert.equal(after.hooks, undefined);
  assert.deepEqual(after.permissions, { allow: ['Bash(ls)'] });
});

test('undo reverts edits, creations and deletions; redo re-applies them', () => {
  write('a.txt', 'original\n');
  write('c.txt', 'to be deleted\n');
  cli('init');
  turn('refactor everything', () => {
    write('a.txt', 'changed by agent\n');
    write('new/dir/b.txt', 'created\n');
    fs.rmSync(p('c.txt'));
  });
  const list = cli('list').out;
  assert.match(list, /refactor everything/);
  assert.match(list, /claude\s+3\s+refactor everything/);

  const u = cli('undo');
  assert.equal(u.code, 0, u.err);
  assert.equal(read('a.txt'), 'original\n');
  assert.equal(read('c.txt'), 'to be deleted\n');
  assert.ok(!exists('new/dir/b.txt'));
  assert.ok(!exists('new'), 'empty folders created by the agent are removed');

  const r = cli('redo');
  assert.equal(r.code, 0, r.err);
  assert.equal(read('a.txt'), 'changed by agent\n');
  assert.equal(read('new/dir/b.txt'), 'created\n');
  assert.ok(!exists('c.txt'));
});

test('undo refuses to overwrite edits made after the turn, unless forced', () => {
  write('a.txt', 'v1\n');
  cli('init');
  turn('edit a', () => write('a.txt', 'v2 agent\n'));
  write('a.txt', 'v3 human edit\n');
  const u = cli('undo');
  assert.equal(u.code, 1);
  assert.match(u.err, /a\.txt/);
  assert.equal(read('a.txt'), 'v3 human edit\n');
  assert.equal(cli('undo', '--force').code, 0);
  assert.equal(read('a.txt'), 'v1\n');
});

test('undoing an older turn keeps later turns that touched other files', () => {
  write('a.txt', 'a1\n');
  write('b.txt', 'b1\n');
  cli('init');
  turn('first', () => write('a.txt', 'a2\n'));
  turn('second', () => write('b.txt', 'b2\n'));
  assert.equal(cli('undo', '1').code, 0);
  assert.equal(read('a.txt'), 'a1\n');
  assert.equal(read('b.txt'), 'b2\n');
});

test('rewind restores the whole project to before a turn, and redo reverses it', () => {
  write('a.txt', 'a1\n');
  cli('init');
  turn('first', () => write('a.txt', 'a2\n'));
  turn('second', () => { write('a.txt', 'a3\n'); write('x.txt', 'x\n'); });
  const r = cli('rewind', '1');
  assert.equal(r.code, 0, r.err);
  assert.equal(read('a.txt'), 'a1\n');
  assert.ok(!exists('x.txt'));
  assert.match(cli('list').out, /undone by/);
  assert.equal(cli('redo').code, 0);
  assert.equal(read('a.txt'), 'a3\n');
  assert.equal(read('x.txt'), 'x\n');
});

test('turns that change nothing are not recorded', () => {
  write('a.txt', 'a\n');
  cli('init');
  turn('just a question', () => {});
  assert.match(cli('list').out, /No agent turns recorded/);
});

test('changes from shell commands are captured, ignored files are not', () => {
  write('.gitignore', 'secret.env\n');
  write('a.txt', 'a\n');
  cli('init');
  turn('run a script', () => {
    spawnSync(process.execPath, ['-e', "require('fs').writeFileSync('gen.txt','generated')"], { cwd: proj });
    write('secret.env', 'TOKEN=1\n');
    write('node_modules/pkg/index.js', 'x');
  });
  const d = cli('diff', '--stat').out;
  assert.match(d, /gen\.txt/);
  assert.doesNotMatch(d, /secret\.env|node_modules/);
  cli('undo');
  assert.ok(!exists('gen.txt'));
  assert.ok(exists('secret.env'), 'ignored files are left alone');
});

test("the project's own git repository is never touched", () => {
  spawnSync('git', ['init', '-q'], { cwd: proj });
  write('a.txt', 'a\n');
  const before = fs.readdirSync(p('.git')).sort();
  cli('init');
  turn('edit', () => write('a.txt', 'b\n'));
  cli('undo');
  assert.deepEqual(fs.readdirSync(p('.git')).sort(), before);
  const st = spawnSync('git', ['status', '--porcelain'], { cwd: proj, encoding: 'utf8' }).stdout;
  assert.match(st, /\?\? \.claude\/|\?\? a\.txt/);
  assert.doesNotMatch(st, /^A /m, 'nothing staged in the real repo');
});

test('binary files and CRLF line endings round-trip exactly', () => {
  const bin = Buffer.from([0, 1, 2, 255, 13, 10, 0]);
  fs.writeFileSync(p('img.bin'), bin);
  write('win.txt', 'line1\r\nline2\r\n');
  cli('init');
  turn('mangle', () => { fs.writeFileSync(p('img.bin'), Buffer.from([9])); write('win.txt', 'x\n'); });
  cli('undo');
  assert.deepEqual(fs.readFileSync(p('img.bin')), bin);
  assert.equal(read('win.txt'), 'line1\r\nline2\r\n');
});

test('an interrupted turn is closed by the next prompt', () => {
  write('a.txt', '1\n');
  cli('init');
  hook('UserPromptSubmit', { prompt: 'first' });
  write('a.txt', '2\n');
  // no Stop: user pressed Esc
  turn('second', () => write('a.txt', '3\n'));
  const out = cli('list').out;
  assert.match(out, /first/);
  assert.match(out, /second/);
  assert.equal(cli('undo').code, 0);
  assert.equal(read('a.txt'), '2\n');
});

test('the hook never fails the agent, even on garbage input', () => {
  for (const agent of ['claude', 'codex', 'nonsense']) {
    const r = spawnSync(process.execPath, [BIN, 'hook', agent], { cwd: proj, env: env(), input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('init refuses to track the home folder', () => {
  const r = spawnSync(process.execPath, [BIN, 'init'], { cwd: home, env: env(), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /home folder/);
});

// ---------- Codex ----------
// Payloads mirror codex-rs/hooks/src/events/{user_prompt_submit,stop}.rs.

function codexTurn(prompt, work, { cwd = proj, session = 'thread-1' } = {}) {
  const base = { session_id: session, turn_id: 't', cwd, model: 'gpt', permission_mode: 'default', transcript_path: null };
  hook('UserPromptSubmit', { ...base, prompt, agent_id: null, agent_type: null }, 'codex');
  work();
  hook('Stop', { ...base, stop_hook_active: false, last_assistant_message: 'done' }, 'codex');
}

const codexHooks = () => JSON.parse(fs.readFileSync(path.join(home, '.codex', 'hooks.json'), 'utf8'));

test('init sets up the agents it finds; Codex hooks go to ~/.codex/hooks.json and keep existing ones', () => {
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));
  const r = cli('init');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Codex hooks added/);
  assert.match(r.out, /Trust all and continue/);
  assert.doesNotMatch(r.out, /Claude Code hooks/, 'Claude Code is not installed in this fake home');
  cli('init');
  const h = codexHooks();
  assert.equal(h.hooks.UserPromptSubmit.length, 1);
  assert.equal(h.hooks.Stop.length, 2);
  assert.equal(h.hooks.Stop[0].hooks[0].command, 'echo mine');
  const ours = h.hooks.Stop[1].hooks[0];
  assert.equal(ours.type, 'command');
  assert.equal(ours.timeout, 60);
  assert.match(ours.command, /hook codex$/);
  if (process.platform === 'win32') assert.doesNotMatch(ours.command, /\//, 'cmd /C gets Windows paths');
});

test('Codex turns can be undone, and show up next to Claude Code turns', () => {
  write('a.txt', 'a1\n');
  write('b.txt', 'b1\n');
  cli('init', '--agent', 'claude,codex');
  turn('claude edits a', () => write('a.txt', 'a2\n'));
  codexTurn('codex edits b', () => { write('b.txt', 'b2\n'); write('gen/out.txt', 'x'); });
  const list = cli('list').out;
  assert.match(list, /codex\s+2\s+codex edits b/);
  assert.match(list, /claude\s+1\s+claude edits a/);
  assert.equal(cli('undo').code, 0);
  assert.equal(read('b.txt'), 'b1\n');
  assert.ok(!exists('gen'));
  assert.equal(read('a.txt'), 'a2\n', 'the Claude Code turn is untouched');
});

test('Codex hooks only act in tracked projects, from any subfolder', () => {
  const other = path.join(tmp, 'untracked');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'x.txt'), '1');
  write('src/a.txt', '1\n');
  cli('init', '--agent', 'codex');
  codexTurn('in untracked folder', () => fs.writeFileSync(path.join(other, 'x.txt'), '2'), { cwd: other });
  codexTurn('from a subfolder', () => write('src/a.txt', '2\n'), { cwd: p('src') });
  const list = cli('list').out;
  assert.match(list, /from a subfolder/);
  assert.doesNotMatch(list, /untracked/);
  assert.equal(cli('undo').code, 0);
  assert.equal(read('src/a.txt'), '1\n');
});

test('Codex subagent prompts do not split the parent turn', () => {
  write('a.txt', '1\n');
  cli('init', '--agent', 'codex');
  const base = { session_id: 'thread-1', cwd: proj };
  hook('UserPromptSubmit', { ...base, prompt: 'parent task' }, 'codex');
  write('a.txt', '2\n');
  hook('UserPromptSubmit', { ...base, prompt: 'subagent task', agent_id: 'sub-1', agent_type: 'worker' }, 'codex');
  write('a.txt', '3\n');
  hook('Stop', base, 'codex');
  const list = cli('list').out;
  assert.match(list, /parent task/);
  assert.doesNotMatch(list, /subagent task/);
  cli('undo');
  assert.equal(read('a.txt'), '1\n');
});

test('init --global tracks new projects until uninstall --global', () => {
  fs.mkdirSync(path.join(home, '.codex'));
  assert.equal(cli('init', '--global', '--agent', 'codex').code, 0);
  write('a.txt', '1\n');
  codexTurn('global turn', () => write('a.txt', '2\n'));
  assert.match(cli('list').out, /global turn/);
  assert.match(cli('status').out, /Codex:\s+hooks on \(every project\)/);
  assert.equal(cli('uninstall', '--global').code, 0);
  assert.equal(codexHooks().hooks, undefined);
  assert.match(cli('status').out, /Codex:\s+hooks off/);
});

// ---------- awkward real-world cases ----------

test('file names with spaces, accents, CJK and leading dashes round-trip', () => {
  const names = ['my notes.md', 'café/naïve file.txt', '-rf.txt', '日本語.txt', '[draft] (v2).md'];
  for (const n of names) write(n, `original ${n}\n`);
  cli('init');
  turn('rename things', () => {
    write(names[0], 'changed\n');
    fs.rmSync(p(names[1]));
    fs.rmSync(p(names[2]));
    write('new folder/über ñ.txt', 'new\n');
    write(names[4], 'changed\n');
  });
  assert.equal(cli('undo').code, 0);
  for (const n of names) assert.equal(read(n), `original ${n}\n`, n);
  assert.ok(!exists('new folder'));
});

test('a project path with spaces works, and installed hook commands run as the agents run them', () => {
  proj = path.join(tmp, 'my project (copy)');
  fs.mkdirSync(proj);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, '.codex'));
  write('a.txt', '1\n');
  assert.equal(cli('init').code, 0);
  const claudeCmd = JSON.parse(read('.claude/settings.local.json')).hooks.Stop[0].hooks[0].command;
  const codexCmd = codexHooks().hooks.Stop[0].hooks[0].command;
  const win = process.platform === 'win32';
  // Claude Code runs hooks with bash (Git Bash on Windows); Codex with cmd /C on Windows, sh -lc elsewhere.
  const runAs = (command, shell, event) => spawnSync(command, {
    shell, cwd: proj, encoding: 'utf8', env: { ...env(), CLAUDE_PROJECT_DIR: proj },
    input: JSON.stringify({ hook_event_name: event, session_id: 'real', cwd: proj, prompt: 'via shell' }),
  });
  for (const [command, shell] of [[claudeCmd, 'bash'], [codexCmd, win ? 'cmd.exe' : '/bin/sh']]) {
    const start = runAs(command, shell, 'UserPromptSubmit');
    assert.equal(start.status, 0, `${shell}: ${start.stderr}`);
    write('a.txt', `${shell}\n`);
    const stop = runAs(command, shell, 'Stop');
    assert.equal(stop.status, 0, `${shell}: ${stop.stderr}`);
  }
  const list = cli('list').out;
  assert.equal((list.match(/via shell/g) || []).length, 2, list);
  assert.ok(!fs.existsSync(path.join(tmp, 'store', 'error.log')), 'no hook errors');
});

test('a nested git repository inside the project does not break snapshots', () => {
  write('a.txt', '1\n');
  write('vendor/lib/x.txt', 'lib\n');
  spawnSync('git', ['init', '-q'], { cwd: p('vendor/lib') });
  cli('init');
  turn('edit both', () => { write('a.txt', '2\n'); write('vendor/lib/x.txt', 'changed\n'); });
  assert.equal(cli('undo').code, 0);
  assert.equal(read('a.txt'), '1\n');
  assert.ok(!fs.existsSync(path.join(tmp, 'store', 'error.log')), 'no hook errors');
});

test('symlinks are restored as symlinks', { skip: process.platform === 'win32' && 'needs symlink rights on Windows' }, () => {
  write('target.txt', 'real\n');
  fs.symlinkSync('target.txt', p('link.txt'));
  cli('init');
  turn('remove link', () => fs.rmSync(p('link.txt')));
  assert.equal(cli('undo').code, 0);
  assert.equal(fs.readlinkSync(p('link.txt')), 'target.txt');
});

// ---------- Claude Code plugin mode ----------

function pluginHook(event, extra = {}) {
  const input = JSON.stringify({ hook_event_name: event, session_id: 'p1', cwd: proj, ...extra });
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude', '--all-projects'], {
    cwd: proj, env: { ...env(), CLAUDE_PROJECT_DIR: proj }, input, encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
}

test('plugin mode tracks a project without init, and ignores its own slash commands', () => {
  write('a.txt', '1\n');
  pluginHook('UserPromptSubmit', { prompt: 'edit a' });
  write('a.txt', '2\n');
  pluginHook('Stop');
  pluginHook('UserPromptSubmit', { prompt: '/undoagent:undo' });
  assert.equal(cli('undo').code, 0);
  pluginHook('Stop');
  assert.equal(read('a.txt'), '1\n');
  const list = cli('list').out;
  assert.match(list, /edit a/);
  assert.doesNotMatch(list, /\/undoagent:undo/);
  assert.ok(!fs.existsSync(path.join(tmp, 'store', 'error.log')), 'no hook errors');
});

test('plugin mode never tracks the home folder', () => {
  const input = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'p1', cwd: home, prompt: 'x' });
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude', '--all-projects'], {
    cwd: home, env: { ...env(), CLAUDE_PROJECT_DIR: home }, input, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'store', 'projects')), 'nothing created');
});
