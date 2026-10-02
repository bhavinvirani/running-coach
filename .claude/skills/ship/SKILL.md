---
name: ship
description: Run every check, commit, push and open an auto-merging PR for the current branch. Owner-invoked as /ship or /ship N; /slice, /audit-standards and /replan follow the same steps.
disable-model-invocation: true
arguments: [issue]
---
# /ship $issue

1. Checks, all green, in this order: `pnpm check`; `pnpm test:e2e`; `pnpm test:screens`; `pnpm py:check` when anything under `services/garmin` changed; `pnpm build`. A red check stops the ship: fix it, never skip or weaken it.
2. `git status --porcelain` shows no `.env*` file other than `.env.example`, no recordings, no screenshots outside `apps/web/e2e/screens/*-snapshots/`, no files the slice did not need.
3. Commits: conventional messages (`feat(web): ...`, `fix(api): ...`, `test(engine): ...`, `chore: ...`), one per logical change. Squash `wip` commits first with `git reset --soft origin/main` and recommit.
4. `git push -u origin HEAD`. Never force-push; if the push is rejected, `git pull --rebase origin "$(git branch --show-current)"` and push again.
5. `gh pr create --title "<conventional title>" --body "<at most 5 lines, last line Closes #$issue when an issue number was given>"`, then `gh pr merge --auto --squash`.
6. Print the PR URL and stop. CI, auto-merge and the production deploy need nothing more from this session.
