---
name: slice
description: Start or resume one backlog slice by GitHub issue number. Owner-invoked only, as /slice N.
disable-model-invocation: true
arguments: [issue]
---

# /slice $issue

Work one slice end to end. The issue body is the spec; its acceptance list is the test list.

## 1. Read

- `gh issue view $issue --comments`: the body is the slice, the comments hold the approved plan, progress notes and decisions.
- `git fetch origin && git branch -a --list "*slice-$issue-*"`. If a branch exists: switch to it, read `git log origin/main..HEAD --oneline` and `git diff origin/main...HEAD --stat`, continue from the last progress comment and skip step 2. Otherwise this is a fresh start.
- Read SPEC.md and the rule files for the packages the issue lists. Find related code with the Explore subagent; never read the whole repo.

## 2. Plan (fresh start only)

Post one comment on the issue, at most 15 lines: approach, packages touched, skills used, tests to write, every corner case from the acceptance list and where it is covered, anything you will not do and why. Then stop and wait for the owner's approval in chat. No branch and no code before that.

## 3. Build

- `git fetch origin && git switch --no-track -c slice-$issue-<short-name> origin/main`: from `origin/main`, because a lane's folder never holds an up-to-date local `main`. Postgres: in a lane's worktree, when `docker compose ps --all --quiet postgres` prints nothing, stop and ask the owner to create the container from the main folder (a lane's bind mount would vanish with the lane). Otherwise start it when it is not running: `docker compose up -d --wait --no-recreate postgres` (compose's config hash differs per folder, so a plain `up` from a worktree recreates the shared container mid-test). The checks and `pnpm test:e2e` need only it and start their own API and Garmin service on this folder's e2e slot. In the main folder, run `pnpm dev` in the background when someone needs the app itself.
- Delegate to the `implementer` subagent, one per package when the packages do not overlap, each prompt naming the issue, the plan comment, the package, the skills to load and the corner cases it owns. Run them in parallel. Implementers do not commit: integrate their files on the branch yourself and commit once per package with a conventional message.
- Then the `e2e` subagent for the flows and screenshots the issue names.
- `pnpm check`, `pnpm test:e2e`, and `pnpm py:check` when `services/garmin` changed. Fix until green.

## 4. Review

`diff="$(git rev-parse --absolute-git-dir)/review.diff"; { gh issue view $issue --json body --jq .body; echo; git log origin/main..HEAD --format=%s; echo; git diff origin/main...HEAD; } > "$diff"; echo "$diff"` (the git dir, because `.git` is a file in a linked worktree), then run the `standards-reviewer` subagent with the printed path and the issue number. Fix every must-fix item, rerun the checks, and run the reviewer again when the fixes touched more than one file.

## 5. Ship

Follow the steps in `.claude/skills/ship/SKILL.md` (read the file; the `/ship` command itself is owner-only) with this issue number. Then stop.

## Context running low

Commit what works (`wip(slice-$issue): <what>`), post a comment of at most 3 lines (done / next / blockers), stop, and tell the owner to resume with `/slice $issue`.
