#!/usr/bin/env bash
# PostToolUse formatter. Formats and lint-fixes the file Claude just edited.
# Exit 2 sends the remaining lint errors to Claude; everything else is silent.
# Tools that are not installed yet (before phase 5) are skipped, not errors.
set -uo pipefail
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
[[ -z "$file" || ! -f "$file" ]] && exit 0
case "$file" in "$root"/*) ;; *) exit 0 ;; esac
case "$file" in */node_modules/*|*/dist/*|*/.venv/*|*/coverage/*|*/migrations/*.sql) exit 0 ;; esac
rel="${file#"$root"/}"

case "$file" in
  *.py)
    if [[ -f "$root/services/garmin/pyproject.toml" ]] && command -v uv >/dev/null 2>&1; then
      (cd "$root/services/garmin" && uv run --quiet ruff format "$file" >/dev/null 2>&1) || true
      if ! out=$(cd "$root/services/garmin" && uv run --quiet ruff check --fix "$file" 2>&1); then
        printf 'ruff: %s\n%s\n' "$rel" "$out" >&2
        exit 2
      fi
    fi
    ;;
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs|*.json|*.css|*.md|*.yml|*.yaml|*.html)
    if [[ -x "$root/node_modules/.bin/prettier" ]]; then
      "$root/node_modules/.bin/prettier" --write --log-level warn "$file" >/dev/null 2>&1 || true
    fi
    case "$file" in
      *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs)
        if [[ -x "$root/node_modules/.bin/eslint" ]]; then
          if ! out=$(cd "$root" && node_modules/.bin/eslint --fix --no-warn-ignored "$file" 2>&1); then
            printf 'eslint: %s\n%s\n' "$rel" "$out" >&2
            exit 2
          fi
        fi
        ;;
    esac
    ;;
esac
exit 0
