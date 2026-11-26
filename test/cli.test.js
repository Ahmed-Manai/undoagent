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

function hook(event, extra = {}) {
  const input = JSON.stringify({ hook_event_name: event, session_id: 's1', cwd: proj, ...extra });
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude'], {
    cwd: proj, env: { ...env(), CLAUDE_PROJECT_DIR: proj }, input, encoding: 'utf8',
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
  assert.match(list, /\s3\s+refactor everything/);

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
  const r = spawnSync(process.execPath, [BIN, 'hook', 'claude'], { cwd: proj, env: env(), input: 'not json', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('init refuses to track the home folder', () => {
  const r = spawnSync(process.execPath, [BIN, 'init'], { cwd: home, env: env(), encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /home folder/);
});
