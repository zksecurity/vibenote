---
name: subagent-manager
description: Launch, supervise, and review coding subagents in tmux using Codex CLI. Use when breaking work into task files under tasks/, assigning one task per subagent, and reviewing the result before accepting it.
metadata:
  skills.sh:
    emoji: 🤖
---

# Subagent Manager

Use this skill when work should be delegated to bounded coding subagents instead of being implemented in the main session.

This repo uses a task-board workflow:

- one task file per task under `tasks/`
- one tmux session per subagent
- one active workstream per subagent session
- one bounded task file at a time inside that session
- manager reviews before accepting the task

## Launch workflow

1. Choose exactly one task file.
2. Update the task frontmatter before launch:
   - `status: active`
   - `assigned: <session-name>`
3. Launch a tmux-backed Codex session:

```bash
skills/subagent-manager/scripts/launch-subagent.sh \
  <session-name> \
  <model> \
  <task-file> \
  "<prompt>"
```

Example:

```bash
skills/subagent-manager/scripts/launch-subagent.sh \
  subagent-define-action-protocol \
  gpt-5.4 \
  tasks/define-action-data-protocol.md \
  "Work only on tasks/define-action-data-protocol.md. Read that task, the relevant parent/audit tasks, AGENTS.md, and only the repo files needed to define the protocol. Update the task file with concise findings, do not implement the protocol, do not change unrelated files, do not commit, and stop when done."
```

## Prompt rules

Keep the prompt bounded and explicit:

- name the single task file
- list the minimum context files to read
- say what kind of work is allowed: audit, design, implementation, validation
- require the subagent to update the task file before stopping
- forbid unrelated edits and commits
- require a short terminal summary before exit

Avoid broad prompts like "work on #99" or "refactor the data layer".

## Reuse policy

Prefer reusing an existing subagent session when:

- the next task is part of the same workstream
- the session has already gathered relevant codebase context
- the session output is still sharp and trustworthy

This saves time and context reload cost.

Do not restart a subagent just because one bounded task finished.

Instead:

1. review and accept or reject the finished task
2. update the next task file
3. send the next bounded prompt into the same tmux session

Start a fresh subagent session when:

- the workstream changes materially
- the session starts drifting or freelancing
- the accumulated context is becoming noisy or stale
- the prior task revealed that a narrower or differently skilled agent is needed

## Supervision

Inspect the live run with:

```bash
tmux attach -t <session-name>
tmux capture-pane -pt <session-name> | tail -n 80
```

Use subagents for bounded execution, not for silent autonomy. The manager stays responsible for scope control and acceptance.

## Review and acceptance

When the subagent finishes:

1. Review changed files and task output.
2. Run the relevant checks yourself when code changed.
3. Accept only if the task file contains useful results and the work matches the brief.
4. Add `completed:` when a `done` task is accepted.
5. Kill the tmux session after acceptance or rejection.

Typical review commands:

```bash
git status --short
git diff -- <task-file>
tmux kill-session -t <session-name>
```

If the result is not acceptable, keep the task open and launch a follow-up subagent with a narrower correction brief.

## Guardrails

- Prefer one subagent per task file.
- Prefer reusing one good subagent session across adjacent tasks in the same workstream.
- Prefer one narrow task over one large autonomous run.
- Do not let subagents commit unless explicitly requested by the user.
- In this repo, avoid reading or writing `.env`.
- For code tasks, require `npm run check` and relevant tests unless the task is design-only.

## Safety note

The launcher below uses Codex with dangerous bypass flags because this environment is already externally controlled. If that is not true in another environment, replace those flags with a safer approval/sandbox policy.
