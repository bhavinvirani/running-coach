#!/usr/bin/env bash
# PreToolUse guard. Reads the hook JSON on stdin and denies two things:
# 1. reading or writing any .env file except .env.example (secrets live there);
# 2. git force-push in any spelling (history on main is never rewritten).
# Everything else exits 0 with no output, which leaves the normal permission flow alone.
set -euo pipefail
input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

deny() {
  jq -n --arg reason "$1" '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$reason}}'
  exit 0
}

env_reason="This is a secrets file and hooks block it. Variable names live in .env.example; ask the owner to set values."

case "$tool" in
  Read|Edit|Write)
    path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
    base=$(basename -- "$path")
    if [[ ( "$base" == ".env" || "$base" == .env.* ) && "$base" != ".env.example" ]]; then deny "$env_reason"; fi
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
    # split the command into path-ish tokens (letters, digits, _ . -) and deny any token that is a
    # secrets file: ".env", ".env.local", ".env.test". "process.env" and "import.meta.env" are whole
    # tokens that do not start with ".env", so they pass; "apps/api/.env" splits at the slash.
    while IFS= read -r token; do
      [[ -z "$token" ]] && continue
      if [[ "$token" != ".env.example" ]]; then deny "$env_reason"; fi
    done < <(printf '%s' "$cmd" | tr -c 'A-Za-z0-9_.\n-' '\n' | grep -E '^\.env(\.[A-Za-z0-9_-]*)*$' || true)
    if printf '%s' "$cmd" | grep -qE 'git([[:space:]]+-[A-Za-z-]+([[:space:]]+[^[:space:]]+)?)*[[:space:]]+push([[:space:]]+[^|;&]*)?(--force|--force-with-lease|--force-if-includes|-f([[:space:]]|$)|--mirror|[[:space:]]\+[A-Za-z])'; then
      deny "Force-push is blocked. Merge origin/main into the branch (git fetch origin && git merge origin/main) and push a new commit instead; never rebase a pushed branch."
    fi
    ;;
esac
exit 0
