---
feature: compose-mode-dissolution
status: experimental
updated: 2026-07-22
branch: compose-slim
successor: compose-next migration PR (not opened yet)
---

# Compose Slim Experiment and Compose Next Roadmap

> **Draft experiment, not a merge candidate.** The slim three-skill approach on
> this branch performs reasonably well with Fable/Sol-class models and validates
> the core hypothesis: strong models need compact execution contracts, not a
> large process curriculum. It is staying open as a Draft so the experiment is
> not mistaken for abandoned work. For compatibility, the production feature
> will ship through a new branch and PR as builtin `/compose-next` alongside the
> deprecated Legacy Compose mode. Once that successor PR exists, close this PR
> as superseded by the compatibility roadmap rather than merging it.

## Report

**Experiment outcome** - Promising. Consolidating the old Compose curriculum
into compact contracts preserved the useful behavior in dogfooding while
substantially reducing prompt weight. The experiment also exposed contracts
that strong models still need stated explicitly: question-tool shapes,
Never-Ask continuation, feature-document invariants, worktree ownership,
verification-before-review ordering, exact review coordinates, and avoidance of
duplicate heavy verification.

**Production decision** - Do not replace Legacy Compose in place. Introduce one
self-contained builtin skill named `compose-next`, make it explicitly selectable
from Build through `/compose-next`, and keep it out of normal model discovery.
Deprecate Legacy Compose with a recommendation for Fable/Sol-class models to use
Build + `/compose-next`. Remove Legacy Compose only after comparable model
capability is broadly available and the migration has been observed in release.

## [S1] Problem

A Compose mode currently bundles three independent concerns:

1. **Permission policy** - what the agent may do.
2. **Workflow knowledge** - how the agent should plan, implement, verify, review,
   and finish work.
3. **UI state** - what the Tab key selects and what the status bar displays.

That coupling was useful when models needed heavy workflow scaffolding. Stronger
models now internalize most planning, TDD, and debugging practice, but removing
the mode immediately would create compatibility problems:

- Existing users and weaker models still depend on Legacy Compose behavior.
- Reusing the name `compose` for a new skill while the Compose agent remains
  available would be ambiguous in product language, code, logs, and support.
- Replacing fourteen skills with three internal skills is an implementation
  experiment, not yet a user-facing migration design.
- Model capability is moving quickly; the product needs a reversible overlap
  period rather than a flag day.

## [S2] Experimental Findings

This branch implements and dogfoods an intentionally aggressive simplification:

- Fourteen Compose skills were consolidated into `compose-grill`,
  `compose-spec`, and `compose-dev`.
- Feature design, tasks, and delivery report share one document at
  `<compose_docs_dir>/spec/<feature>.md`.
- `compose.txt` became a compact router while detailed executable contracts
  moved into the skills.
- Skill discovery gained structured `scope` metadata and
  `Permission.evaluateSkill`, proving that `all()` and agent-specific
  `available()` can serve different consumers without name-prefix heuristics.
- The existing `compose.js` workflow remained structurally unchanged.

The experiment is useful even though its exact architecture will not ship:

- Prompt reduction works well enough with Fable/Sol-class models to justify a
  production path.
- A single load is preferable to asking the model to coordinate three internal
  skills in the final user-facing design.
- Compact text must retain concrete tool protocols and ordering constraints;
  deleting rationale must not delete the executable contract.
- Verification and review must be sequential. A reviewer may gather additional
  evidence, but should reuse a compact PASS/FAIL/PRE-EXISTING summary instead of
  repeating an already-passing heavy E2E command without cause.
- Never-Ask applies to one decision only; later decisions still go through the
  question tool.

## [S3] Production Target: Compose Next

### One self-contained builtin skill

Create one skill in the builtin bundle:

```text
packages/opencode/src/skill/builtin/.bundle/compose-next/SKILL.md
```

Its canonical name is `compose-next` and its natural scan scope is `builtin`.
It is not compose-scoped: it is a normal builtin capability invoked explicitly
from Build, not an internal module owned by a Compose mode.

The skill contains the complete compact workflow in one load:

1. inspect repository facts and resolve only genuine user decisions;
2. create or amend a feature document when the work warrants one;
3. implement in dependency order with test-first rules where applicable;
4. run verification and summarize the observed results compactly;
5. dispatch one fresh reviewer with spec, worktree, base/head SHAs, diff
   coordinates, and the compact verification summary;
6. finalize the feature document before branch completion;
7. finish with explicit merge/PR/keep/discard and worktree ownership rules.

The current three slim skills are source material for this document, not the
production bundle layout.

### User-visible, model-undiscovered

Use the existing distinction between the complete skill registry and the
agent-visible subset:

- `Skill.all()` contains `compose-next`. Command registration and the app skills
  endpoint already use `all()`, so `/compose-next` is available for user slash
  selection and explicit typing.
- Add an exact `compose-next: deny` skill permission to the default agent rules.
  `Skill.available(agent)` therefore omits it from `available_skills` and the
  skill tool description.
- Change `skill_search` to search `Skill.available(currentAgent)` rather than
  `Skill.all()`. It must not discover or auto-load skills unavailable to the
  current agent.
- Keep `SkillTool.execute()` backed by `get()`. If a model guesses the exact
  name, invocation is allowed; this is behavior guidance, not a security
  boundary.
- Do not add activation state, invoke-time refusal, model allowlists, or a new
  visibility schema.

Because `compose-next` is builtin-scoped, the current Build-only TUI suppression
for `scope === "compose"` does not hide it. It should appear in slash
autocomplete while remaining absent from model discovery.

### Legacy Compose compatibility

Keep the existing Compose agent, prompt injection, private skills, and workflow
behavior during the overlap period. Mark the agent deprecated in its TUI
description and opening prompt:

> Legacy Compose is deprecated but remains available for compatibility. With a
> Fable/Sol-class model, switch to Build and run `/compose-next`.

This is a recommendation, not runtime model detection. Do not maintain a hard
list of supported model IDs; users may choose either path.

Terminology during migration:

- **Legacy Compose** - the existing Compose agent/mode.
- **Compose Next** - the builtin skill invoked as Build + `/compose-next`.

After Legacy Compose is removed, add `/compose` as an alias for the same skill.
Keep `/compose-next` as a compatibility alias for existing documentation and
user habits; no forced second migration is required.

## [S4] Release Migration

### Phase A - Successor implementation

Create a fresh production branch from the latest `main`. Do not continue
implementation on `compose-slim` and do not merge this experimental commit
history wholesale. Reuse the proven contract text and, where necessary,
re-implement or selectively carry only the minimal discovery mechanism.

The successor PR adds:

- builtin `compose-next`;
- exact-name exclusion from `available()` through agent skill permission;
- agent-aware `skill_search` input;
- Build slash autocomplete and explicit invocation coverage;
- Legacy Compose deprecation messaging;
- compatibility and model-behavior tests.

When the successor PR opens, update this Draft with its URL and close this PR as
superseded. The closure means the experiment graduated into a compatible
product route, not that Compose Slim failed or was abandoned.

### Phase B - Dual-path release

Ship both paths:

```text
Legacy Compose agent       compatibility path
Build + /compose-next      recommended strong-model path
```

Observe at least:

- task completion and user intervention rate;
- skipped spec/report/review steps;
- duplicate heavy verification and resource contention;
- context/token cost;
- fallback usage of Legacy Compose;
- behavior across MiMo and third-party models near the Fable/Sol capability
  level.

### Phase C - Remove Legacy Compose

Proceed only after Fable/Sol-class capability is broadly available across the
models MiMoCode intends to support and Compose Next has shown no material
workflow regression.

Then:

1. remove Legacy Compose from the default Tab cycle;
2. retain a migration message for one release;
3. remove the Legacy Compose agent, prompt injection, and private bundle;
4. add `/compose` as an alias of `compose-next`;
5. evaluate plan-mode and permission-preset changes separately.

## [S5] Route

| Step | Branch / PR | Change | Exit gate |
|---|---|---|---|
| E0 | `compose-slim`, draft PR #1850 | Three-skill strong-model experiment and executable-contract refinement | Findings documented; keep Draft, do not merge |
| P1 | New branch from latest `main` | Add builtin `/compose-next`; keep Legacy Compose deprecated but functional | User slash works in Build; model manifest/search omit it; legacy path unchanged |
| P2 | Same successor PR or a small follow-up | Dogfood and release both paths | Fable/Sol-class runs show acceptable completion, review, verification, and token behavior |
| P3 | Later removal PR | Remove Legacy Compose; add `/compose` alias | Supported model population meets capability gate; migration release completed |
| P4 | Separate roadmap | Revisit `/plan` and permission presets | Independent design and validation |

## [S6] Out of Scope

- Merging the `compose-slim` experimental implementation into production.
- Rewriting the existing `compose.js` workflow in this experiment or the first
  Compose Next compatibility PR.
- Hard model-ID gating for `/compose-next`.
- Treating model-undiscoverability as a security boundary.
- Removing Legacy Compose in the first Compose Next release.
- Migrating old Compose documents; existing artifacts remain valid.
- Plan-mode dissolution and Tab permission presets; those need separate specs.

## Tasks

- [x] E0: consolidate fourteen skills into three and reduce prompt weight - acceptance: relevant tests and typecheck pass; dogfooding remains usable (covers: S2)
- [x] E1: refine the slim skills into executable contracts - acceptance: question, Never-Ask, document, verification, review, and finish invariants have explicit tests (covers: S2)
- [x] E2: choose a compatibility-first production direction - acceptance: roadmap keeps Legacy Compose while introducing builtin `/compose-next` from Build (covers: S3, S4)
- [ ] P1: open a fresh implementation branch and successor PR from latest `main` - acceptance: PR implements the Phase A list without depending on merging this experiment (covers: S3, S4)
- [ ] P2: close draft PR #1850 as superseded after linking the successor - acceptance: closure text records successful experimentation and the compatibility reason for the new implementation path (covers: S4)
