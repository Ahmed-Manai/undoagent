# undoagent

**Undo for AI coding agents.** Every prompt you give your agent becomes a checkpoint. If the agent breaks something, one command puts your files back, including changes it made by running shell commands.

![Claude Code deletes a folder with rm -rf; undoagent undo brings it back](https://raw.githubusercontent.com/Ahmed-Manai/undoagent/main/docs/demo.gif)

<sub>A real Claude Code session, recorded and sped up.</sub>

```bash
npm install -g undoagent
cd your-project
undoagent init
```

`init` sets up hooks for the agents it finds: **Claude Code** and **Codex** (beta). Then use your agent as usual. When a turn goes wrong:

```console
$ undoagent list
   #  time         agent   files  what
   3  14:32        claude   4   migrate the auth module to the new session API
   2  14:10        codex    1   fix the typo in the header
   1  13:58        claude   2   add a dark mode toggle

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
| One history across agents | ❌ | Claude Code and Codex (beta) |

## Commands

| Command | What it does |
|---|---|
| `undoagent init` | Start tracking this project and set up hooks for the agents found on this machine |
| `undoagent init --agent codex` | Choose agents yourself: `claude`, `codex`, or `claude,codex` |
| `undoagent init --global` | Track every project you open, not just this one |
| `undoagent list` | Recent agent turns, newest first |
| `undoagent diff [ID]` | What a turn changed (`--stat` for a summary) |
| `undoagent undo [ID]` | Undo the latest turn, or a specific one |
| `undoagent redo` | Re-apply the last undo or rewind |
| `undoagent rewind ID` | Put every file back to how it was before turn ID |
| `undoagent status` | Is this project tracked? Are the hooks on? |
| `undoagent uninstall [--global]` | Remove the hooks (history is kept) |

## How it works

- When you submit a prompt, an agent hook takes a snapshot of your project. When the agent finishes, it takes another. The difference is one **turn**.
- Snapshots go into a separate, hidden git repository under `~/.undoagent`. **Your project's own `.git` is never read or written**, and nothing is staged or committed in it. It works in folders that aren't git repos at all.
- Your `.gitignore` is respected, and folders like `node_modules` and `.venv` are skipped.
- Before undoing, undoagent checks whether you edited any of the affected files after the agent's turn. If you did, it stops and tells you which files, so your own work is never overwritten silently. Use `--force` to undo anyway.
- Everything stays on your machine. No network, no telemetry.

## Requirements

- Node.js 18.17 or newer
- git 2.25 or newer (only used internally; your project doesn't need to be a git repo)
- Claude Code, or Codex

## Agent setup

**Claude Code:** hooks go into the project's `.claude/settings.local.json` (or `~/.claude/settings.json` with `--global`). Restart running sessions after `init`.

**Codex (beta):** Codex reads hooks from one per-user file, `~/.codex/hooks.json`; undoagent only acts in projects you ran `init` in (or every project with `--global`). The next time Codex starts it shows **"Hooks need review"**: choose **"Trust all and continue"**, or the hooks won't run. Codex support is tested against Codex's hook format but is new, so please [report anything odd](https://github.com/Ahmed-Manai/undoagent/issues).

## Limitations (v0.2)

- Supported agents: Claude Code and Codex. Gemini CLI and a VS Code extension with a visual timeline are next.
- Files inside nested git repositories (submodules) aren't snapshotted.
- Projects with more than 50,000 non-ignored files are refused on first run; add a `.gitignore` for generated folders.
- If two agent sessions edit the same project at the same time, their turns can overlap.

## Roadmap

Vote or suggest features in the issues:

- [x] Codex support (beta)
- [ ] Gemini CLI support
- [ ] VS Code / Cursor extension with a timeline and side-by-side diffs
- [ ] File-watcher mode for agents without hooks (Copilot, Cline, Cursor)

## License

MIT
