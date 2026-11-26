import {
  changedFiles, checkSize, ensureStore, readHistory, restoreFiles, snapshot, withLock, writeHistory,
} from './store.js';

const PROMPT_MAX = 500;

function now() {
  return new Date().toISOString();
}

/** Ensure the store exists, with a baseline snapshot. Returns true if newly created. */
export function initStore(store) {
  return withLock(store, () => {
    const created = ensureStore(store);
    if (created) {
      checkSize(store);
      snapshot(store, 'baseline');
    }
    return created;
  });
}

/** Close any open turn for this session against `post`. */
function closeOpen(store, h, session, post) {
  for (const e of h.entries) {
    if (e.type === 'turn' && e.post === null && e.session === session) {
      e.post = post;
      e.end = now();
      e.files = changedFiles(store, e.pre, post);
    }
  }
  // Drop turns that changed nothing; they only add noise.
  h.entries = h.entries.filter((e) => !(e.type === 'turn' && e.post !== null && e.files.length === 0));
}

/** Called when the user submits a prompt: snapshot "before". */
export function beginTurn(store, { agent, session, prompt }) {
  return withLock(store, () => {
    if (ensureStore(store)) checkSize(store);
    const pre = snapshot(store, `before: ${(prompt || '').slice(0, 72)}`);
    const h = readHistory(store);
    closeOpen(store, h, session, pre);
    h.entries.push({
      id: h.nextId++,
      type: 'turn',
      agent,
      session,
      prompt: (prompt || '').slice(0, PROMPT_MAX),
      pre,
      post: null,
      start: now(),
      end: null,
      files: [],
      undoneBy: null,
    });
    writeHistory(store, h);
  });
}

/** Called when the agent finishes responding: snapshot "after". */
export function endTurn(store, { session }) {
  return withLock(store, () => {
    if (ensureStore(store)) return; // no turn could be open in a brand-new store
    const h = readHistory(store);
    if (!h.entries.some((e) => e.type === 'turn' && e.post === null && e.session === session)) return;
    const post = snapshot(store, 'after turn');
    closeOpen(store, h, session, post);
    writeHistory(store, h);
  });
}

export class ConflictError extends Error {
  constructor(files) {
    super('files changed since then');
    this.files = files;
  }
}

/**
 * Bring `files` (computed as changedFiles(restoreTo, expected)) back to
 * `restoreTo`, after checking none of them changed since `expected`.
 */
function applyRestore(store, h, { restoreTo, expected, files, force, kind, targets, label }) {
  const current = snapshot(store, `before ${kind}`);
  if (!force && expected !== current) {
    const drift = new Set(changedFiles(store, expected, current).map((f) => f.path));
    const conflicts = files.filter((f) => drift.has(f.path)).map((f) => f.path);
    if (conflicts.length) throw new ConflictError(conflicts);
  }
  restoreFiles(store, restoreTo, files);
  const after = snapshot(store, `after ${kind}`);
  const entry = {
    id: h.nextId++,
    type: kind,
    label,
    targets,
    pre: current,
    post: after,
    start: now(),
    end: now(),
    files: changedFiles(store, current, after),
    undoneBy: null,
  };
  h.entries.push(entry);
  return entry;
}

function openTurns(h) {
  return h.entries.filter((e) => e.type === 'turn' && e.post === null);
}

/** Undo one finished turn (default: the latest one not yet undone). */
export function undo(store, { id, force } = {}) {
  return withLock(store, () => {
    const h = readHistory(store);
    const candidates = h.entries.filter((e) => e.type === 'turn' && e.post !== null && !e.undoneBy);
    const target = id === undefined ? candidates.at(-1) : h.entries.find((e) => e.id === id);
    if (!target) throw new Error(id === undefined ? 'nothing to undo' : `no entry #${id}`);
    if (target.type !== 'turn') throw new Error(`#${id} is not an agent turn`);
    if (target.post === null) throw new Error(`turn #${target.id} is still running; wait for the agent to finish`);
    if (target.undoneBy) throw new Error(`turn #${target.id} is already undone (by #${target.undoneBy})`);
    const entry = applyRestore(store, h, {
      restoreTo: target.pre, expected: target.post, files: changedFiles(store, target.pre, target.post),
      force, kind: 'undo', targets: [target.id], label: `undo #${target.id}`,
    });
    target.undoneBy = entry.id;
    writeHistory(store, h);
    return { entry, target };
  });
}

/** Restore the whole project to how it was just before turn `id` started. */
export function rewind(store, { id, force } = {}) {
  return withLock(store, () => {
    const h = readHistory(store);
    const target = h.entries.find((e) => e.id === id && e.type === 'turn');
    if (!target) throw new Error(`no agent turn #${id}`);
    if (openTurns(h).length && !force) throw new Error('an agent turn is still running; wait for it to finish');
    const current = snapshot(store, 'before rewind');
    const later = h.entries.filter((e) => e.type === 'turn' && e.id >= id && !e.undoneBy);
    const entry = applyRestore(store, h, {
      restoreTo: target.pre, expected: current, files: changedFiles(store, target.pre, current),
      force: true, kind: 'rewind', targets: later.map((e) => e.id), label: `rewind to before #${id}`,
    });
    for (const e of later) e.undoneBy = entry.id;
    writeHistory(store, h);
    return { entry, undoneTurns: later.map((e) => e.id) };
  });
}

/** Reverse the most recent undo or rewind that has not been redone. */
export function redo(store, { force } = {}) {
  return withLock(store, () => {
    const h = readHistory(store);
    const target = h.entries.filter((e) => (e.type === 'undo' || e.type === 'rewind') && !e.undoneBy).at(-1);
    if (!target) throw new Error('nothing to redo');
    const entry = applyRestore(store, h, {
      restoreTo: target.pre, expected: target.post, files: changedFiles(store, target.pre, target.post),
      force, kind: 'redo', targets: [target.id], label: `redo ${target.label}`,
    });
    target.undoneBy = entry.id;
    for (const e of h.entries) if (e.undoneBy === target.id) e.undoneBy = null;
    writeHistory(store, h);
    return { entry, target };
  });
}
