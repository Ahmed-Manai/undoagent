---
description: Re-apply the last undo or rewind
argument-hint: "[--force]"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/undoagent.js" redo $ARGUMENTS`

undoagent has already run the redo above; the files on disk have changed. Tell the user in one sentence what was re-applied. Don't run any other commands or edit files, and re-read any of those files before working on them again.
