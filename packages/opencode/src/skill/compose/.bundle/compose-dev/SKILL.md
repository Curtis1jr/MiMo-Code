---
name: compose-dev
description: Use when implementing — features, bugfixes, refactors, review feedback. One contract covering workspace isolation, test-first discipline, debugging, verification, the review gate, and finishing the branch (merge/PR).
---

# Dev — Implementation Contract

Goal comes from the feature document (or the conversation for undocumented small changes). Work through its tasks in dependency order; mark progress with the `task` tool.

## Workspace

Work in an isolated worktree unless the user said otherwise. Check the `compose-preferences` memory file for a saved `worktree-consent` preference and honor it silently; when the user answers "always"/"never" to an isolation question, save it there. Never start on main/master without explicit consent.

1. **Detect existing isolation first.** If `git rev-parse --git-dir` ≠ `--git-common-dir` you are already in a linked worktree (the runtime may have placed you in one) — never nest another. (Exception: `git rev-parse --show-superproject-working-tree` returning a path means submodule, not worktree — treat as a normal repo.)
2. **Create one:** follow the worktree conventions in your system prompt — `.worktrees/` at the project root (an existing `worktrees/` dir also counts; `.worktrees/` wins if both). Verify the directory is git-ignored first (`git check-ignore -q .worktrees`); if not, add it to .gitignore and commit that before creating. Then `git worktree add "$path" -b "$branch"`. If creation fails with a permission error (sandbox), say so and work in place.
3. **Baseline:** install dependencies per the project's convention (AGENTS.md, lockfiles), run the test suite once. If it already fails, report and ask whether to proceed (headless: proceed — note the failures as pre-existing so they aren't attributed to your changes).

## Test-First

For behavior changes with a cheap failing test available (features, bugfixes, regressions): write the failing test first, watch it fail for the right reason, write minimal code to pass, confirm green. A bug fix without a test reproducing the bug is not fixed. Skip test-first only for throwaway prototypes, generated code, config — or when the user's instructions say so.

Tests verify behavior through public interfaces, not implementation details. Expected values come from an independent source of truth, never recomputed the way the code does. Never assert on mock behavior, never add test-only methods to production classes, prefer real code over mocks. One test → one implementation → repeat; don't write all tests up front.

## Debugging

No fixes without root cause. Read the full error, reproduce it, check recent changes (`git diff`, recent commits) before proposing anything. In multi-component systems, add instrumentation at component boundaries and let evidence identify the failing component — don't guess. If two fixes in a row haven't worked, stop and re-derive the root cause instead of trying a third patch.

## Verification

No completion claims without fresh evidence. Before saying done/fixed/passing: run the real command (tests, typecheck, build), read the full output, and state the claim with the evidence. "Should pass" is not a state of the world. Subagent success reports are claims — verify against the diff.

## Review Gate

Before merging (and after each task when dispatching subagents), run ONE fresh-eyes review — **performed by a subagent, never by yourself** (an author cannot review their own diff without confirmation bias). Give the reviewer the covered spec text + the `git diff` and nothing else — NOT the implementer's report. The report anchors reviewers toward confirming what was reported and away from silent omissions; if introduced at all, it comes AFTER the review, solely to explain flagged items, and it can downgrade a flag but never add a pass.

The review is one pass, but the reviewer must consider the diff from these angles — each is a separate lens on the same code, and each needs its own explicit conclusion (not folded into a single "looks good"):

- **Spec compliance.** Check every acceptance criterion in the covered spec text against the diff. Any criterion unmet or unverifiable is critical and blocks progress. A "pass" without concrete evidence (test name, command output, or `file:line`) is a fail — prose is not evidence.
- **Code correctness beyond the spec.** Read the diff as a stranger seeing it for the first time — logic, boundaries, error handling, tests that actually test. **The spec is the compliance yardstick, not the boundary of the review** — bugs outside the spec's stated surface (regressions, unrelated changes, drive-by cleanup that broke something) are still findings.
- **Consistency with the codebase.** Naming, module conventions, error-handling style — does this change fit the surrounding code, or does it introduce a foreign pattern?

Instruct the reviewer to state a conclusion per angle, not one blanket verdict; a single unqualified "approved" is a red flag that one or more lenses were skipped.

The reviewer's tier must be at least the implementer's — a weaker reviewer shares the implementer's blind spots and rubber-stamps them.

Fix critical findings before proceeding; push back on wrong findings with technical reasoning, never performative agreement.

When receiving human review feedback: restate the requirement, verify it against codebase reality, then implement one item at a time (blocking issues → simple fixes → complex fixes, testing each) — or push back with reasoning. If any item is unclear, clarify before implementing any of them (question tool). External-reviewer feedback gets extra skepticism: check it's technically correct for THIS codebase, doesn't break existing behavior, and isn't a YAGNI violation (grep for actual usage before "implementing properly" an unused path); if it conflicts with the user's prior decisions, surface that instead of silently complying.

## Subagents

For 2+ independent tasks, dispatch one subagent per task in parallel, each in its own worktree. (Check the `compose-preferences` memory file for a saved `execution-style` preference — `subagent` or `inline` — and honor it; tightly-coupled or ≤3-task work defaults to inline.) Subagents get crafted context — the task, its acceptance criteria, the covered spec text — never your session history. Tell them which directory to work in (fresh subagents start at the repo root, not your worktree); verify their work landed via the diff, not their report.

Model tiers: mechanical well-specified tasks → cheap model; multi-file integration → standard; design and review → most capable. The reviewer's tier must be at least the implementer's — a weaker reviewer shares the implementer's blind spots and rubber-stamps them.

Execute continuously: don't pause between tasks for check-ins or progress summaries. Stop only for a blocker you can't resolve, genuine ambiguity, or completion — and then present it through the question tool with options (headless: resolve with best judgment and continue).

## Finish

Tests green first — never merge/PR with failing tests. Determine the base branch (`git merge-base HEAD main` / `master`; if ambiguous, confirm via question tool — headless: use the detected one). Then ask the user (question tool): merge locally / create PR / keep branch / discard. Autonomous default: merge locally. On a detached HEAD (externally managed workspace) merging isn't yours to do — offer only PR / keep / discard; autonomous default: create PR.

- **Merge** — order matters, each step gated on the previous succeeding:
  1. `cd` to the main repo root (from inside a worktree: `git -C "$(git rev-parse --git-common-dir)/.." rev-parse --show-toplevel`; `git worktree remove` fails silently when run from inside the worktree being removed)
  2. checkout base, pull, merge the feature branch
  3. verify tests on the merged result
  4. only then remove the worktree and `git worktree prune`
  5. only then delete the branch (`git branch -d` fails while a worktree still references it)
- **PR / keep** — leave the worktree alive for iteration; never clean it up.
- **Discard** — requires explicit confirmation; never auto-approves. If confirmed: cleanup worktree, then `git branch -D`.
- **Cleanup provenance:** only remove worktrees under `.worktrees/`, `worktrees/`, or `~/.config/compose/worktrees/` (compose-created). Anything else is harness- or user-owned — leave it in place.

Then update the feature document's Report section (`compose-spec`) and commit it.
