---
name: compose-spec
description: Use when a feature document must be created or amended after requirements settle, or when its Report must be finalized before branch completion. Keep design, tasks, and delivery evidence in one file.
---

# Spec

Maintain one document per feature at `spec/<feature-name>.md` under the `<compose_docs_dir>` from the prompt. Do not add a date to the filename. A user-specified location overrides this path. Edit an existing document in place; never create a separate plan or report.

## Template

```markdown
---
feature: <feature-name>
status: designed | in-progress | delivered
updated: YYYY-MM-DD
branch: <branch-name>
commits: <base-sha>..<head-sha> # filled at delivery
---

# <Feature Name>

## Report

## [S1] Problem
Describe the user-visible problem.

## [S2] Design
Record the chosen behavior and the contracts needed to implement it.

## [S3] Out of Scope
State explicit boundaries.

## Tasks
- [ ] T1: <work item> - acceptance: <observable result> (covers: S2)
- [ ] T2: <work item> - acceptance: <observable result> (covers: S2; depends: T1)
```

## Design-Time Rules

- Leave `Report` empty and set `status: designed`.
- Keep `[Sn]` anchors stable when headings change; never renumber existing anchors.
- Record settled decisions and precise contracts, not exploration history or file-level code dumps. Include architecture, interfaces, data flow, error behavior, and testing boundaries when they affect the change.
- Make each task the smallest independently verifiable work item and give it an acceptance criterion. Add `depends:` only for real prerequisites; dependencies must be acyclic.
- Add `covers:` for every task implementing a design section. Every design requirement must be covered by at least one task, and every reference must resolve.
- Remove placeholders such as `TBD`, "handle edge cases", and references to unspecified similar work.
- Scale detail to the change; do not pad small designs.

Before implementation, fix ambiguous requirements, contradictions, unresolved references, and unverifiable acceptance criteria. If the user is available, request document approval with the `question` tool; otherwise continue.

## Amendments

Update only affected sections, bump `updated:`, preserve anchors, and keep only the tasks required by the amendment and their dependents. Do not regenerate the document or create duplicate tasks.

## Delivery

After implementation, verification, and review, finalize this document before merge or PR completion:

1. Set `status: delivered`, bump `updated:`, and record the reviewed range as `<base-sha>..<head-sha>`.
2. Check off completed tasks; leave incomplete tasks unchecked and do not claim delivery if they block acceptance.
3. Replace `Report` with:

```markdown
## Report

**What was built** - 1-3 concise paragraphs describing the final behavior.

**Verification** - commands run and their observed results.

**Journey log** - at most 5 entries that help future work: dead ends, pivots, or transferable lessons. Preserve useful prior entries and append new ones.
```

Update a design section only when it contradicts the delivered behavior. Commit the finalized document on the feature branch before finishing the branch.
