---
name: compose:docs
description: Use whenever the feature document needs writing — at design time (record the settled design + task list after grilling) and again at delivery (fill its Report section). One file per feature carries spec, tasks, and report through the whole cycle.
---

# Docs — One Feature Document

A feature has exactly one markdown file, written at two moments: after grilling you create it with the design and task list; after delivery you return and fill its Report section in place. There is never a separate report file. Save it to the `spec/` subdirectory of the `<compose_docs_dir>` given in your prompt, as `spec/<feature-name>.md` — no date in the filename; one feature, one file; `updated:` in the frontmatter and git history carry the timeline. User preferences for location override the default.

## Document Structure

Head-first: frontmatter, then Report (once delivered), then the design sections. A reader — human or model — learns the current state from the first screenful; the design record sits below as history.

```markdown
---
feature: <feature-name>
status: designed | in-progress | delivered
updated: YYYY-MM-DD
branch: <branch-name>
commits: <first-sha>..<last-sha>   # filled at delivery
---

# <Feature Name>

## Report
(Empty at design time. Filled at delivery — becomes the authoritative
summary; see "Report (After Delivery)" below.)

## [S1] Problem
What the user is facing, from the user's perspective.

## [S2] Design
The settled decisions from grilling: approach, architecture, interfaces,
data flow, error handling, testing seams. Record decisions ("we chose X
because Y"), not exploration history. No file-level code dumps — types,
signatures, and contracts where precision matters.

## [S3] Out of Scope
What this feature explicitly does not do.

## Tasks
- [ ] T1: <description> — acceptance: <verifiable criterion> (covers: S2)
- [ ] T2: <description> — acceptance: <criterion> (depends: T1)
```

Rules:

- **Section anchors** `[Sn]` are stable IDs. Reworded headings keep their ID; never renumber — task `covers:` references and reviews depend on them.
- **Tasks are right-sized**: the smallest unit with its own verifiable acceptance criterion. `depends:` names prerequisite task IDs (omit when independent; no cycles). Every task that produces spec-required behavior lists at least one `covers:`.
- **No placeholders.** "TBD", "handle edge cases", "similar to T2" are spec failures — write the actual content or cut the section.
- **Scale to the work.** A small fix needs a few sentences per section; don't pad.

## Self-Review

After writing, one inline pass: placeholders? contradictions between sections? any requirement interpretable two ways? every task's acceptance actually verifiable? coverage in both directions — every design-bearing `[Sn]` section has a task whose `covers:` lists it, and every `covers:` resolves to a real section? Fix inline and move on. If a user is available, ask them to review the document (question tool) before implementation; autonomous: proceed.

## Amendments

If the feature already has a document, edit it in place — update the affected sections, bump `updated:`, keep stable anchors, and make the task list contain only the tasks this change requires (plus dependents). Never regenerate from scratch or duplicate near-identical tasks.

## Report (After Delivery)

When implementation is verified, update the same file — the Report at the top becomes the authoritative state, superseding the design sections below it:

1. Frontmatter: set `status: delivered`, bump `updated:`, fill `commits: <first-sha>..<last-sha>`.
2. Check off completed tasks in the Tasks list.
3. Fill the Report section (overwrite any previous report content in place; keep prior Journey log entries and append):

```markdown
## Report

> Delivered. This section supersedes the design sections below —
> they record what was planned; this records what shipped. Code is truth.

**What was built** — 1-3 paragraphs, final state, written as if the
feature always existed. A new team member understands it from this alone.

**Verification** — what was run and its actual output summary.

**Journey log** — max 5 bullets, only ones that help a future designer:
- [dead end] Tried X — failed because Y
- [pivot] Switched from A to B after discovering C
- [lesson] Transferable insight
```

If the Design section actively misleads (not just lags — contradicts what shipped), fix that section too. Then commit the document.
