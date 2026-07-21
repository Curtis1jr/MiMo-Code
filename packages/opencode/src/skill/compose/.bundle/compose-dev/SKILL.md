---
name: compose-dev
description: Use for implementation, bug fixes, refactors, and review feedback. Execute tasks, verify behavior, obtain independent review, finalize the feature document, and finish the branch safely.
---

# Dev

Use the feature document as the source of requirements, or the conversation for an undocumented mechanical change. Execute tasks in dependency order and track multi-step work with the `task` tool.

## Workspace

Never begin implementation on `main` or `master` without explicit user consent.

1. Compare `git rev-parse --git-dir` with `git rev-parse --git-common-dir`. If they differ, use the current linked worktree; do not nest another. A non-empty `git rev-parse --show-superproject-working-tree` indicates a submodule, not a linked worktree.
2. Unless the user or harness already chose the workspace, create a linked worktree under `.worktrees/` or an existing `worktrees/` directory at the project root; `.worktrees/` wins when both exist. Verify the directory is ignored with `git check-ignore -q <directory>` and update `.gitignore` before creation if needed. Create it with `git worktree add "$path" -b "$branch"`. If the environment prevents worktree creation, report that limitation and work in place on a non-base branch.
3. Install dependencies using repository instructions and run the relevant baseline tests. If the baseline fails, report the exact failure and ask whether to proceed. If that question returns `[Never-Ask]`, continue and keep the failure classified as pre-existing.

## Implement

For behavior changes with a cheap reproduction, write a failing test, confirm it fails for the intended reason, implement the smallest fix, and confirm it passes. A bug fix requires a regression test when one can be written. Skip test-first for generated code, configuration-only changes, throwaway prototypes, or explicit user direction.

Test public behavior. Do not duplicate production logic in expected values, add test-only production APIs, or assert only that mocks were called. Prefer real implementations over mocks.

For failures, reproduce before editing and identify the root cause from errors, diffs, recent commits, or boundary instrumentation. After two failed fixes, stop patching and re-derive the cause.

## Parallel Work

Dispatch independent tasks in parallel when isolation prevents collisions; keep tightly coupled work together. Give each subagent the worktree path, task, acceptance criteria, relevant spec sections, and required verification. Do not pass session history. Treat its report as a claim and inspect the resulting diff.

Continue through tasks without routine approval pauses. Stop only for an unresolved product decision, a blocker that cannot be worked around, a destructive action requiring consent, or completion.

## Verify

Before any completion claim, run the repository's relevant tests, typecheck, build, or reproduction from the correct directory and read the output. Record each command and result. Mark known baseline failures as `PRE-EXISTING` with a short identifier. Do not substitute prior output or a subagent report for fresh evidence.

## Review

After implementation is verified and before finalizing the report, dispatch one fresh subagent to review the complete change. Verification and review are sequential: wait for all verification commands to exit before dispatching the reviewer, and never overlap review with a resource-heavy test or application process in the same environment. For parallel task work, review integrated task diffs at useful boundaries only when delaying review would compound risk.

Provide the reviewer:

- the applicable spec sections and acceptance criteria;
- the worktree path, base branch, base SHA, head SHA, and exact diff command or precomputed diff;
- a compact verification summary: one line per command with `PASS`, `FAIL`, or `PRE-EXISTING`, plus test counts when available. Do not paste full command output unless a specific failure requires it.

Do not provide an implementer-authored narrative. The reviewer may inspect the diff and run additional commands needed to validate its conclusions. It must not repeat a command already reported as passing, especially a heavy E2E suite, unless the result is stale, the code changed afterward, or concrete evidence makes the result suspect. Before any justified rerun, confirm no equivalent command is still running. Missing evidence should be reported or gathered with the cheapest non-duplicative command.

Use a reviewer model at least as capable as the strongest implementer it reviews.

Require separate conclusions for:

1. **Spec compliance:** every acceptance criterion is met and points to evidence in the diff or reviewer-observed command output.
2. **Correctness:** logic, boundaries, error handling, regressions, and tests are sound, including issues outside the written spec.
3. **Codebase consistency:** naming, structure, and local conventions match surrounding code.

Classify unmet or unverifiable acceptance criteria and correctness bugs as critical. Fix critical findings, re-verify, and re-review affected areas. Reject incorrect findings with technical evidence.

For human review feedback, verify each item against the codebase, clarify ambiguous items before editing, and implement validated items one at a time with verification.

## Deliver And Finish

1. After review passes, invoke `compose-spec` to finalize and commit the feature document on the feature branch.
2. Confirm the branch is clean and verification is green.
3. Determine the base branch. If ambiguous, use the `question` tool; without user input, use the detected merge base.
4. Ask with the `question` tool: merge locally, create PR, keep branch, or discard. Without user input, merge locally; on detached HEAD, create a PR. Never auto-discard.

For a local merge, perform these steps in order and stop if any step fails: move to the main repository root; update the base branch; merge the feature branch; verify the merged result; remove only a compose-owned worktree; run `git worktree prune`; delete the merged branch. For PR or keep, preserve the worktree and branch. Discard requires explicit confirmation before worktree removal or `git branch -D`.

Only remove worktrees under the project's `.worktrees/` or `worktrees/`, or `~/.config/compose/worktrees/`. Leave harness- and user-owned worktrees intact.
