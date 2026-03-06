#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <session-name> <model> <task-file> <prompt>" >&2
  exit 1
fi

session_name="$1"
model="$2"
task_file="$3"
prompt="$4"
repo_root="$(pwd)"

if tmux has-session -t "$session_name" 2>/dev/null; then
  echo "tmux session already exists: $session_name" >&2
  exit 1
fi

tmux new-session -d -s "$session_name" -c "$repo_root"
tmux send-keys -t "$session_name" \
  "codex --no-alt-screen -C $repo_root -m $model --dangerously-bypass-approvals-and-sandbox \"$prompt\"" \
  C-m

echo "launched $session_name"
echo "task: $task_file"
