---
name: subagents
description: Launching and managing coding subagents via tmux. Use when delegating tasks to parallel agents, monitoring their progress, or coordinating multi-agent work. Triggers include "launch an agent", "start a subagent", "delegate this task", "run this in parallel", or any task coordination involving multiple agents.
---

# Subagent Management

Run coding subagents in tmux sessions so both the orchestrator and the human have visibility. The orchestrator (you) acts as project manager — writing tasks, launching agents, monitoring progress, and validating results. You don't code directly.

## Launching a subagent

```bash
tmux new-session -d -s <session-name> -x 220 -y 50 \
  "pi --model <model> '<prompt>' 2>&1; echo '[AGENT DONE]'; sleep 99999"
```

- **Session name**: short, descriptive (e.g. `agent1`, `refactor-data`, `fix-tests`).
- **Prompt**: tell the agent what task file to read, what guidelines to follow (e.g. `AGENTS.md`), and what the success criteria are.
- The `echo '[AGENT DONE]'; sleep 99999` tail keeps the session alive after the agent finishes so you can review its final output.

## Monitoring progress

```bash
# Peek at the last N lines of output
tmux capture-pane -t <session-name> -p | tail -40

# The human can watch live
tmux attach -t <session-name>
```

Check in periodically. Don't just launch and forget — catch issues early.

## Key rules

### Never kill a working agent

An agent accumulates deep context over many minutes of reading, reasoning, and coding. Killing it mid-task destroys all of that. A new agent starting from scratch will:

- Waste time re-reading everything
- Miss implicit decisions the previous agent made
- Likely produce worse or inconsistent results

**If you need to do something in the repo while an agent is running** (create a branch, install a dep, check types), do it in your own terminal. The filesystem is shared — you can work alongside the agent without disrupting it.

### One task per agent

Each agent gets a single task file from `tasks/`. Don't overload an agent with multiple unrelated goals. If a task turns out to be bigger than expected, split it.

### Give agents the right starting context

A good launch prompt includes:

1. Which task file to read
2. Which project guidelines to follow (e.g. `AGENTS.md`)
3. Orientation on where to start in the codebase
4. What "done" looks like

A bad launch prompt is vague ("fix the app") or over-specified with implementation details (let the agent figure out the how).

### Parallel agents

Multiple agents can work simultaneously on independent tasks. Use distinct tmux session names and make sure their tasks touch different files to avoid conflicts.

If tasks are sequential (agent B depends on agent A's output), wait for A to finish and validate before launching B.

### Validation

When an agent signals it's done (or you see `[AGENT DONE]` in the session):

1. Check the output: `tmux capture-pane -t <session-name> -p | tail -80`
2. Run the validation criteria from the task file (typically `npm run check`, `npm test`, manual grep checks)
3. Review the diff: `git diff`
4. If it passes, update the task status to `done`
5. If it fails, either relaunch with specific fix instructions or fix manually

### Cleanup

```bash
# Kill a finished session
tmux kill-session -t <session-name>

# List all sessions
tmux list-sessions
```
