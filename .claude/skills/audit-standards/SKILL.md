---
name: audit-standards
description: Compare the code merged since the last audit with the rules and skills, run the prompt audit, and propose fixes as one PR. Owner-invoked only, as /audit-standards.
disable-model-invocation: true
---

# /audit-standards

0. From a clean tree, branch first: `git fetch origin && git switch --no-track -c chore/standards-audit-<yyyy-mm-dd> origin/main`, so the audit reads what merged.
1. Scope: commits since the last `chore(standards)` commit on `origin/main` (`git log --oneline <that>..origin/main`), or everything since the bootstrap the first time.
2. For each file in `.claude/rules/`, read the code it covers and list three things: rules the code breaks (fix the code), rules the code proves wrong or vague (fix the rule, keep it one line), patterns the code repeats that no rule names (add one line). Do the same for each `.claude/skills/*/SKILL.md` against its reference implementation: the skill must describe the file as it is today.
3. Invoke the `claude-api` skill with the argument `prompt-audit` through the Skill tool (the same audit `/doctor prompt-audit` runs) over CLAUDE.md, `.claude/rules`, `.claude/skills` and `.claude/agents`, then apply the findings that fit the documentation budget: short, concrete, no advice.
4. Any raw value, boundary breach or naming slip found by hand becomes a lint rule in the same PR, so the next audit does not find it by hand.
5. On the branch from step 0, one PR titled `chore(standards): audit after slice N`, body at most 5 lines. Finish with the steps in `.claude/skills/ship/SKILL.md` without an issue number.
