# undoagent

**Undo for AI coding agents.** Every prompt you give your agent becomes a checkpoint. If the agent breaks something, one command puts your files back, including changes it made by running shell commands.

```bash
npm install -g undoagent
cd your-project
undoagent init
```

Then use Claude Code as usual. When a turn goes wrong:

```console
$ undoagent list
   #  time         files  what
   3  14:32          4   migrate the auth module to the new session API
   2  14:10          1   fix the typo in the header
   1  13:58          2   add a dark mode toggle

$ undoagent undo
✓ Undid #3: migrate the auth module to the new session API
    ~ src/auth/session.ts
    ~ src/auth/middleware.ts
    - src/auth/legacy-adapter.ts
    + src/auth/old-session.ts
  Changed your mind? undoagent redo
```

## Why not the agent's built-in checkpoints?

| | Built-in checkpoints | undoagent |
|---|---|---|
| Edits made by the agent's file tools | ✅ | ✅ |
| Files changed by shell commands (`rm`, `sed`, scripts, codegen) | ❌ usually not tracked | ✅ |
| History survives closing the session | Varies | ✅ |
| Undo one old turn and keep later ones | ❌ | ✅ |
| Refuses to overwrite your own edits made since | Varies | ✅ |
| Works the same across agents | ❌ | Claude Code now; Codex and Gemini CLI next |

## Commands

| Command | What it does |
|---|---|
| `undoagent init` | Start tracking this project (adds hooks to `.claude/settings.local.json`) |
| `undoagent init --global` | Track every project you open with Claude Code |
| `undoagent list` | Recent agent turns, newest first |
| `undoagent diff [ID]` | What a turn changed (`--stat` for a summary) |
| `undoagent undo [ID]` | Undo the latest turn, or a specific one |
| `undoagent redo` | Re-apply the last undo or rewind |
| `undoagent rewind ID` | Put every file back to how it was before turn ID |
| `undoagent status` | Is this project tracked? Are the hooks on? |
| `undoagent uninstall [--global]` | Remove the hooks (history is kept) |

## How it works

- When you submit a prompt, a Claude Code hook takes a snapshot of your project. When the agent finishes, it takes another. The difference is one **turn**.
- Snapshots go into a separate, hidden git repository under `~/.undoagent`. **Your project's own `.git` is never read or written**, and nothing is staged or committed in it. It works in folders that aren't git repos at all.
- Your `.gitignore` is respected, and folders like `node_modules` and `.venv` are skipped.
- Before undoing, undoagent checks whether you edited any of the affected files after the agent's turn. If you did, it stops and tells you which files, so your own work is never overwritten silently. Use `--force` to undo anyway.
- Everything stays on your machine. No network, no telemetry.

## Requirements

- Node.js 18.17 or newer
- git 2.25 or newer (only used internally; your project doesn't need to be a git repo)
- Claude Code

## Limitations (v0.1)

- Claude Code only for now. Codex, Gemini CLI and a VS Code extension with a visual timeline are next.
- Files inside nested git repositories (submodules) aren't snapshotted.
- Projects with more than 50,000 non-ignored files are refused on first run; add a `.gitignore` for generated folders.
- If two agent sessions edit the same project at the same time, their turns can overlap.

## Roadmap

Vote or suggest features in the issues:

- [ ] Codex CLI support
- [ ] Gemini CLI support
- [ ] VS Code / Cursor extension with a timeline and side-by-side diffs
- [ ] File-watcher mode for agents without hooks (Copilot, Cline, Cursor)

## License

MIT
