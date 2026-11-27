---
description: Put every file back to how it was before turn N
argument-hint: "<turn number> [--force]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/undoagent.js" rewind $ARGUMENTS`

undoagent has already run the rewind above; the files on disk have changed. Tell the user in one or two sentences what happened, and that `/undoagent:redo` reverses it. Don't run any other commands or edit files, and re-read any of those files before working on them again.
