---
description: Show what an agent turn changed (default: the latest)
argument-hint: "[turn number] [--stat]"
allowed-tools: Bash(node:*)
disable-model-invocation: false
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/undoagent.js" diff $ARGUMENTS`

The output above is the change a turn made, from undoagent. Summarize it for the user in a few bullet points (which files, what changed). Don't run any other commands or edit files.
