---
description: Undo the latest agent turn, or turn N, including changes made by shell commands
argument-hint: "[turn number] [--force]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/undoagent.js" undo $ARGUMENTS`

undoagent has already run the undo above; the files on disk have changed. Tell the user in one or two sentences what was undone and which files were restored. If it refused because files changed since that turn, explain that `/undoagent:undo --force` overrides it. Mention that `/undoagent:redo` brings the changes back. Don't run any other commands or edit files, and re-read any of those files before working on them again.
