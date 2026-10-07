---
name: replan
description: Apply a scope or decision change to SPEC.md and the GitHub issues. Owner-invoked only, as /replan followed by the change.
disable-model-invocation: true
---

# /replan $ARGUMENTS

0. From a clean tree, branch first: `git fetch origin && git switch --no-track -c spec/<short-name> origin/main`.
1. Restate the change in one line, and name the SPEC.md section and the issues (#1 to #19) it touches. If it contradicts a line under "Decisions", say which and wait for the owner's yes.
2. SPEC.md: one line per decision plus why; the file stays one page. Move anything deferred to the matching `later` issue.
3. Issues: `gh issue edit` the affected slices and keep their format (outcome, acceptance, packages, e2e, at most 8 lines); add or extend a `later` issue for deferred work; close issues no longer needed with a one-line comment.
4. On the branch from step 0, commit `spec: <change>`, then follow `.claude/skills/ship/SKILL.md` without an issue number. A spec-only PR is fine.
