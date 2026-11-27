---
description: Show recent agent turns that undoagent can undo
argument-hint: "[-n N]"
allowed-tools: Bash(node:*)
disable-model-invocation: false
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/undoagent.js" list $ARGUMENTS`

The output above comes from undoagent. Show it to the user as is, in a code block, without commentary. Don't run any other commands.
