import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, storeFor, unsafeRootReason, NAME } from './store.js';
import { beginTurn, endTurn } from './turns.js';

const EVENTS = ['UserPromptSubmit', 'Stop'];
const OUR_COMMAND = /undoagent.*\bhook claude\b/;

function logError(err) {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.appendFileSync(path.join(homeDir(), 'error.log'), `${new Date().toISOString()} ${err?.stack || err}\n`);
  } catch { /* never let logging break the agent */ }
}

/**
 * Entry point for Claude Code hooks. Must stay silent on stdout (Claude Code
 * adds UserPromptSubmit output to the conversation) and must never fail the
 * agent's turn, so every error is logged and swallowed.
 */
export function runClaudeHook(raw) {
  try {
    const input = JSON.parse(raw);
    const event = input.hook_event_name;
    if (!EVENTS.includes(event)) return;
    const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    if (unsafeRootReason(root)) return;
    const store = storeFor(root);
    const session = input.session_id || 'default';
    if (event === 'UserPromptSubmit') beginTurn(store, { agent: 'claude-code', session, prompt: input.prompt });
    else endTurn(store, { session });
  } catch (err) {
    logError(err);
  }
}

// ---------- installing the hooks ----------

export function settingsPath({ global, root }) {
  return global
    ? path.join(os.homedir(), '.claude', 'settings.json')
    : path.join(root, '.claude', 'settings.local.json');
}

export function hookCommand() {
  const script = fileURLToPath(new URL('../bin/undoagent.js', import.meta.url));
  const slash = (p) => p.replace(/\\/g, '/');
  // A copy run through npx lives in a temporary cache that can disappear.
  if (/[\\/]_npx[\\/]/.test(script)) return { command: `${NAME} hook claude`, ephemeral: true };
  return { command: `"${slash(process.execPath)}" "${slash(script)}" hook claude`, ephemeral: false };
}

function readJson(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot parse ${file}: ${e.message}`);
  }
}

function stripOurs(settings) {
  let removed = 0;
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((group) => {
        const before = group.hooks?.length || 0;
        const kept = (group.hooks || []).filter((h) => !OUR_COMMAND.test(h.command || ''));
        removed += before - kept.length;
        return { ...group, hooks: kept };
      })
      .filter((group) => group.hooks.length > 0);
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function installHooks(opts) {
  const file = settingsPath(opts);
  const settings = readJson(file);
  stripOurs(settings);
  const { command, ephemeral } = hookCommand();
  settings.hooks ||= {};
  for (const ev of EVENTS) {
    settings.hooks[ev] ||= [];
    settings.hooks[ev].push({ hooks: [{ type: 'command', command, timeout: 60 }] });
  }
  writeJson(file, settings);
  return { file, command, ephemeral };
}

export function uninstallHooks(opts) {
  const file = settingsPath(opts);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readJson(file);
  const removed = stripOurs(settings);
  if (removed) writeJson(file, settings);
  return { file, removed };
}

export function hooksInstalled(opts) {
  const s = readJson(settingsPath(opts));
  return EVENTS.every((ev) => (s.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => OUR_COMMAND.test(h.command || ''))));
}
