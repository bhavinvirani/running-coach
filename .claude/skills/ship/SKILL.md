---
name: ship
description: Run every check, commit, push and open an auto-merging PR for the current branch. Owner-invoked as /ship or /ship N; /slice, /audit-standards and /replan follow the same steps.
disable-model-invocation: true
arguments: [issue]
---

# /ship $issue

1. Catch up: `git status --porcelain` first, and leave any stray (the list in step 3) out of the commit, deleting only what this session or its checks wrote; commit the rest (`wip` commits are fine), then `git fetch origin && git merge --no-edit origin/main`, so the checks run on what the PR will merge, including what other lanes merged since this branch started. Resolve conflicts here; a migration clash follows `.claude/rules/migrations.md`.
2. Checks, all green, in this order: `pnpm check`; `pnpm test:e2e`; `pnpm test:screens`; `pnpm py:check` when anything under `services/garmin` changed; `pnpm build`. A red check stops the ship: fix it, never skip or weaken it. A change under `packages/shared/src/contracts/` also keeps the deploy rules in `.claude/rules/contracts.md`; a check covers only their union and record shapes, for the schemas listed in `apps/web/src/api/parse-response.test.ts`.
3. What the PR carries, `git diff --name-status origin/main...HEAD` (everything the branch adds, including step 1's commit), holds no `.env*` file other than `.env.example`, no recordings, no screenshots outside `apps/web/e2e/screens/*-snapshots/`, no files the slice did not need; take a stray one out with `git rm --cached <path>` and commit. In `git status --porcelain`, commit what the checks wrote that the slice needs; an untracked stray stays out.
4. Commits: conventional messages (`feat(web): ...`, `fix(api): ...`, `test(engine): ...`, `chore: ...`), one per logical change. Squash `wip` commits only before the first push (`git ls-remote --exit-code --heads origin "$(git branch --show-current)"` finds no branch): `git reset --soft "$(git merge-base HEAD origin/main)"` and recommit. After step 1 that base is the `origin/main` just merged, so the commits hold only this branch's changes; a reset onto an `origin/main` the branch has not merged would revert every lane merged since. Once pushed, add commits and never rewrite them.
5. `git push -u origin HEAD`. Never force-push; if the push is rejected, `git pull --no-rebase origin "$(git branch --show-current)"` and push again.
6. `gh pr create --title "<conventional title>" --body "<at most 5 lines, last line Closes #$issue when an issue number was given>"`, then `gh pr merge --auto --squash`.
7. Print the PR URL and stop. CI, auto-merge and the production deploy need nothing more from this session.
