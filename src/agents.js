import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findStore, homeDir, isSkipped, storeFor, unsafeRootReason, NAME } from './store.js';
import { beginTurn, endTurn } from './turns.js';

// Both agents use the same hook format: { hooks: { Event: [{ hooks: [{ type, command, timeout }] }] } }
// and send JSON on stdin with hook_event_name, session_id, cwd and (for prompts) prompt.
const EVENTS = ['UserPromptSubmit', 'Stop'];

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export const AGENTS = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    detect: () => fs.existsSync(path.join(os.homedir(), '.claude')),
    // Claude Code reads hooks per project, or globally.
    projectFile: (root) => path.join(root, '.claude', 'settings.local.json'),
    globalFile: () => path.join(os.homedir(), '.claude', 'settings.json'),
    rootFor: (input) => process.env.CLAUDE_PROJECT_DIR || input.cwd,
    isSubagent: () => false, // subagents fire SubagentStop, which we don't listen to
    windowsPaths: false, // runs hooks through Git Bash on Windows
    afterInstall: 'Restart any running Claude Code session so it picks up the hooks.',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    detect: () => fs.existsSync(codexHome()),
    // Codex reads hooks from one per-user file; undoagent only acts in projects it tracks.
    projectFile: null,
    globalFile: () => path.join(codexHome(), 'hooks.json'),
    rootFor: (input) => input.cwd,
    isSubagent: (input) => Boolean(input.agent_id), // subagent prompts carry agent_id
    windowsPaths: true, // runs hooks through cmd /C on Windows
    afterInstall: 'Next time Codex starts it will show "Hooks need review": choose "Trust all and continue". Untrusted hooks don\'t run.',
  },
};

export function agentById(id) {
  const a = AGENTS[id];
  if (!a) throw new Error(`unknown agent "${id}" (supported: ${Object.keys(AGENTS).join(', ')})`);
  return a;
}

// ---------- "track every project" switch ----------

function globalFlagFile() {
  return path.join(homeDir(), 'global.json');
}

export function globalAgents() {
  try {
    return JSON.parse(fs.readFileSync(globalFlagFile(), 'utf8'));
  } catch {
    return {};
  }
}

function setGlobal(agentId, on) {
  const flags = globalAgents();
  if (on) flags[agentId] = true;
  else delete flags[agentId];
  fs.mkdirSync(homeDir(), { recursive: true });
  fs.writeFileSync(globalFlagFile(), JSON.stringify(flags, null, 2));
}

// ---------- running as a hook ----------

function logError(err) {
  try {
    fs.mkdirSync(homeDir(), { recursive: true });
    fs.appendFileSync(path.join(homeDir(), 'error.log'), `${new Date().toISOString()} ${err?.stack || err}\n`);
  } catch { /* never let logging break the agent */ }
}

/**
 * Which store a hook call belongs to, or null when this folder isn't tracked.
 * `allProjects` comes from the Claude Code plugin: installing it means
 * "track wherever I work", within the usual safety limits.
 */
function storeForHook(agent, input, allProjects) {
  const root = agent.rootFor(input) || process.cwd();
  const existing = findStore(root);
  if (existing) return existing;
  if (!(allProjects || globalAgents()[agent.id]) || unsafeRootReason(root)) return null;
  const store = storeFor(root);
  return isSkipped(store) ? null : store;
}

// undoagent's own slash commands (/undoagent:undo …) arrive as prompts too;
// recording them as agent turns would make "undo" undoable by itself.
const OWN_COMMAND = /^\s*\/undoagent:/;

/**
 * Entry point for agent hooks. Must stay silent on stdout (both agents read
 * UserPromptSubmit output) and must never fail the agent's turn, so every
 * error is logged and swallowed.
 */
export function runHook(agentId, raw, { allProjects = false } = {}) {
  try {
    const agent = agentById(agentId);
    const input = JSON.parse(raw);
    const event = input.hook_event_name;
    if (!EVENTS.includes(event) || agent.isSubagent(input)) return;
    if (event === 'UserPromptSubmit' && OWN_COMMAND.test(input.prompt || '')) return;
    const store = storeForHook(agent, input, allProjects);
    if (!store) return;
    const session = `${agent.id}:${input.session_id || 'default'}`;
    if (event === 'UserPromptSubmit') beginTurn(store, { agent: agent.id, session, prompt: input.prompt });
    else endTurn(store, { session });
  } catch (err) {
    logError(err);
  }
}

// ---------- installing hooks ----------

function ourCommand(agentId) {
  return new RegExp(`undoagent.*\\bhook ${agentId}\\b`);
}

export function hookCommand(agent) {
  const script = fileURLToPath(new URL('../bin/undoagent.js', import.meta.url));
  // A copy run through npx lives in a temporary cache that can disappear.
  if (/[\\/]_npx[\\/]/.test(script)) return { command: `${NAME} hook ${agent.id}`, ephemeral: true };
  const fix = (p) => (process.platform === 'win32' && agent.windowsPaths ? p.replace(/\//g, '\\') : p.replace(/\\/g, '/'));
  return { command: `"${fix(process.execPath)}" "${fix(script)}" hook ${agent.id}`, ephemeral: false };
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

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function stripOurs(settings, agentId) {
  const re = ourCommand(agentId);
  let removed = 0;
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((group) => {
        const before = group.hooks?.length || 0;
        const kept = (group.hooks || []).filter((h) => !re.test(h.command || ''));
        removed += before - kept.length;
        return { ...group, hooks: kept };
      })
      .filter((group) => group.hooks.length > 0);
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return removed;
}

/** The settings file hooks go into: per project when the agent supports it, else per user. */
export function hookFile(agent, { global, root }) {
  return global || !agent.projectFile ? agent.globalFile() : agent.projectFile(root);
}

export function installHooks(agent, { global, root }) {
  const file = hookFile(agent, { global, root });
  const settings = readJson(file);
  stripOurs(settings, agent.id);
  const { command, ephemeral } = hookCommand(agent);
  settings.hooks ||= {};
  for (const ev of EVENTS) {
    settings.hooks[ev] ||= [];
    settings.hooks[ev].push({ hooks: [{ type: 'command', command, timeout: 60 }] });
  }
  writeJson(file, settings);
  if (global) setGlobal(agent.id, true);
  return { file, command, ephemeral };
}

export function uninstallHooks(agent, { global, root }) {
  if (!global && !agent.projectFile) return { file: agent.globalFile(), removed: 0, shared: true };
  const file = hookFile(agent, { global, root });
  if (global) setGlobal(agent.id, false);
  if (!fs.existsSync(file)) return { file, removed: 0 };
  const settings = readJson(file);
  const removed = stripOurs(settings, agent.id);
  if (removed) writeJson(file, settings);
  return { file, removed };
}

export function hooksInstalled(agent, { global, root }) {
  if (!global && !agent.projectFile) return false;
  const s = readJson(hookFile(agent, { global, root }));
  const re = ourCommand(agent.id);
  return EVENTS.every((ev) => (s.hooks?.[ev] || []).some((g) => (g.hooks || []).some((h) => re.test(h.command || ''))));
}
