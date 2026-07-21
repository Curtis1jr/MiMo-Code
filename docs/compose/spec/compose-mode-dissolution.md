---
feature: compose-mode-dissolution
status: designed
updated: 2026-07-21
branch: compose-slim
---

# Compose Mode Dissolution — from Mode to Composable Skills

> This is an experimental spec: step 0 has already landed on `compose-slim`
> (`1975a8d5`, `7ff01213`, `f708b01e`); steps 1–5 are directional — each gate
> requires validation before proceeding.

## Report

(Empty at design time — this feature is still in design. Filled at delivery.)

## [S1] Problem

A "mode" in MiMoCode bundles three orthogonal concerns into one switch:

1. **Permission policy** — what the agent may do (compose:* skill allow/deny,
   plan mode's read-only edit denial)
2. **Workflow knowledge** — how to work (compose.txt's flow table, plan mode's
   "research then propose" framing)
3. **UI state** — what the Tab key cycles and the status bar shows

This bundling made sense when models needed heavy process scaffolding; frontier
models have internalized planning/TDD/debugging, so the knowledge layer has
shrunk (14 skills → 3, ~5700 lines removed) and the remaining bundle causes
concrete problems:

- compose.txt is injected as a synthetic message part on the compose agent's
  user messages (`prompt.ts:670-687`) — invisible to users, fragile ordering,
  duplicated docs-dir plumbing (`{{compose_docs_dir}}` runtime replacement in
  prompt.ts + `_composeDocsDir` arg injection for the workflow).
- The `compose:` prefix is a parallel visibility namespace: excluded from
  skill_search (`search.ts:65`), excluded from localized aliases
  (`localized-alias.ts:8`), permission-gated per agent (`agent.ts:108-111,219`)
  — machinery that exists only to keep three files hidden from two agents.
- Users cannot use compose discipline from build mode, or grill from plan mode;
  the skills are locked to a mode instead of being tools.
- plan mode duplicates the same pattern for an even thinner payload: models
  know how to plan; the mode's real value is its read-only permission set.

## [S2] Current State (delivered, step 0)

The consolidation this document builds on — already merged on this branch:

- **Three compose-scoped skills** in `packages/opencode/src/skill/compose/.bundle/`:
  - `compose:grill` (37 lines) — requirements interrogation: one question at a
    time, recommended answers, facts-from-environment, decomposition-first,
    autonomous mode, improvised visual aids (no bundled server).
  - `compose:docs` (86 lines) — one feature document per feature at
    `<docs_dir>/spec/<feature>.md`, head-first layout (frontmatter → Report →
    design `[Sn]` sections → Tasks), written at two moments (design, then
    Report filled in place at delivery — no separate report file),
    amendment-in-place, bidirectional coverage self-review.
  - `compose:dev` — implementation contract: workspace isolation, decision-rule
    test-first, root-cause debugging, evidence-gated verification, one
    fresh-eyes review with explicit conclusions for spec compliance,
    correctness, and codebase consistency, then report-before-finish branch
    handling with provenance-safe cleanup.
- **compose.txt**: routes work through the three skills, requires loading the
  applicable contract before use, defines headless decision behavior, and
  carries only cross-skill execution rules plus the `<compose_docs_dir>` block.
  Detailed workspace, testing, review, and finish rules live in `compose-dev`
  instead of being duplicated in the top-level prompt.
- **compose.js workflow** (749 lines) unchanged in structure; prompts reference
  the new skill names and the `spec/<feature>.md` feature-document path.

### Delivered on top of step 0: rename + scope mechanism (step 1a)

Landed on `compose-slim` as `23a13568` (33 files, +321/−119):

- **Names.** `compose:{grill,docs,dev}` → `compose-{grill,spec,dev}`. Colon out,
  hyphen in — readable in listings, safe in slash-mention contexts. `docs` →
  `spec` because the skill produces exactly one `spec/<feature>.md` per
  feature; the name now matches its directory.
- **Bundle dirs.** `.bundle/{grill,docs,dev}/` → `.bundle/compose-{grill,spec,dev}/`.
  Skill name = directory name (1:1), so `loadComposeBundle()` no longer
  synthesizes `compose:${dir}`; the prefix is baked into the directory.
- **`Skill.Info.scope`.** New optional field on the discovery record,
  populated at scan time (`scope: "compose" | "builtin" | "project" |
  "global"`). Wired through a `ScanMeta` struct so future per-scope metadata
  attaches at the same seam without changing signatures.
- **`Permission.evaluateSkill({name, scope}, ...rulesets)`.** New public API in
  `permission/evaluate.ts`. Two-tier matching: an explicit name rule wins
  (`compose-grill`), a `scope:<scope>` rule is the fallback (`scope:compose`).
  This is the ONLY entry point callers should use to gate a skill by permission
  — do not reinvent the two-tier logic locally. Wired into `Skill.available`
  in one line.
- **No more name-prefix mechanism keys.** `search.ts` and `localized-alias.ts`
  now filter on `scope === "compose"`; TUI (`autocomplete.tsx`,
  `dialog-skill.tsx`) does the same. Agent config for build/plan uses
  `"scope:compose": "deny"`; compose agent uses `"scope:compose": "allow"`.
  A user's project skill that happens to start with `compose-` is no longer
  swept up.
- **Tests.** New `test/skill/available-permission.test.ts` covers the
  end-to-end gate (build sees 0 compose-scoped skills; compose sees all three;
  `compose-foo` user skill in `.opencode/skills/` is not filtered on build).
  New `test/skill/localized-alias.test.ts` covers the scope-vs-name filter.
  Existing tests migrated to name/scope semantics; 187/187 pass across
  `test/skill`, `test/agent`, `test/workflow/compose`, `test/session/prompt-skill-mention`.
- **SDK types regenerated** to expose `Skill.scope`.

Explicitly NOT in this PR — scheduled as a separate task (see T1b in
`## Tasks`): moving the bundle to `skill/builtin/.bundle/`, adding the
activation clause, and exposing `compose.skills` config is a **user-visible
breaking change**. It changes how users invoke compose (via `/compose`
activation instead of switching to the compose agent) and may need a
deprecation window and migration hint for anyone still relying on the
compose agent. Ship 1a first, dogfood it, then design the migration
surface for 1b separately.

## [S3] Target Architecture

### Skills become builtin, hyphen-named, scope-tracked, soft-gated

Move `compose-grill`, `compose-spec`, `compose-dev` from
`skill/compose/.bundle/` to `skill/builtin/.bundle/`, **retaining `scope:
"compose"` metadata** on the scanned entries. Future splits (e.g.
`compose-review`) are additive directory drops — free composition, no
mechanism changes.

- **Scope is the mechanism key; the name is pure UX.** All special-casing
  (search exclusion, kill switch, any future filtering) keys on the structured
  `scope` field, never on name prefixes. The `name.startsWith("compose:")`
  string checks that used to live in `search.ts` and `localized-alias.ts` have
  been replaced by scope checks; permission gating goes through
  `Permission.evaluateSkill`. Renaming a skill never touches filter logic.
- **Naming:** `compose-` prefix, no colon — readable, groups in listings,
  parses cleanly in slash-mention contexts. Carries no mechanical meaning.
- **Soft gate (probabilistic):** each description begins with an activation
  clause — "Only after the user has activated /compose (or explicitly asks for
  compose discipline). Not for routine work." Models respect described trigger
  conditions well; this is the everyday gate.
- **Hard gate (deterministic), two layers — neither uses permission deny.**
  Permission-based deny is evaluated per-agent, which makes the available-skills
  list differ between agents in one session (unstable prompt prefix, cache
  misses, and /compose could reference skills absent from the current list).
  Instead:
  1. **Scan-time exclusion** — config flag (`compose.skills: false` /
     `MIMOCODE_DISABLE_COMPOSE_SKILLS`) drops scope=compose entries at
     discovery. List is stable for the whole session (uniformly absent);
     zero token cost for users who never want them.
  2. **Invoke-time refusal (optional hardening)** — the `skill` tool rejects
     scope=compose invocations until /compose has run in the session,
     returning "compose skills require /compose activation first". The list
     stays uniformly present and cache-stable; the refusal message itself
     steers the model. This upgrades the soft gate to deterministic without
     touching list composition — adopt only if description-gating proves
     insufficient in step-1 observation.
- **skill_search exclusion** keyed on scope=compose so they never auto-load
  via search; reachable only by name or via /compose.

### /compose becomes a slash command

A command template (like `/review` in `command/template/review.txt`) containing
today's compose.txt content: the three-skill map, the 6-step flow table,
decision rules, asking policy, environment conventions, and the docs directory
(resolved at template render time — the `{{compose_docs_dir}}` message-injection
plumbing in prompt.ts is deleted).

- Available from any agent, at any time. Activation is explicit and visible in
  the transcript — no hidden synthetic message parts.
- After /compose runs, the activation clause in the skill descriptions is
  satisfied; the model may invoke compose-* skills for the rest of the session.
- `/compose <task>` passes the task straight into step 1 (grill).

### The compose agent/mode is removed

Once skills are builtin and /compose exists, the compose agent's remaining
content is: a permission override (obsolete — skills are globally visible,
gated by description + flag) and the prompt injection (obsolete — moved to the
command). Delete the agent registration (`agent.ts:210-219`), the injection
block (`prompt.ts:670-687`), the `compose:*` permission special-cases, and the
`scope: "compose"` extraction path (`skill/index.ts:197-205`).

The **compose workflow** (`compose.js`) is unaffected: it references skills by
name and runs headless; renamed references (`compose:dev` → `compose-dev`) are
the only change. It remains the deterministic orchestration layer — retry
bounds, phase gates, worktree fan-out — which prompt text cannot guarantee.

### plan mode follows the same dissolution

`plan_enter`/`plan_exit` tools and the plan agent are replaced by:

- **/plan command**: a short template — "research first, propose before
  editing, present the plan for approval" — nothing more; models know how to
  plan.
- **Read-only permission preset** (see [S4]) providing the actual guarantee
  that planning doesn't mutate the workspace.

## [S4] Permission Presets Replace Modes

The Tab cycle stops switching agents and instead switches **permission
presets** — deterministic, harness-enforced, model-independent:

| Preset | Meaning |
|---|---|
| Default | ask on risky operations (current build defaults) |
| Accept edits | file edits pre-approved; shell/network still gated |
| Read-only | no writes, no mutating commands (subsumes plan mode's guarantee) |
| Full access | everything pre-approved (current yolo-ish flows) |

This matches the direction visible in Claude Code's permission selector
(默认权限 / 接受编辑权限 / 完全访问权限). Presets are pure permission-config
layers over the existing `Permission.evaluate` machinery; they carry no prompt
text and no workflow opinion. Workflow opinions live in commands (/compose,
/plan) and skills — freely combinable with any preset:

```
/compose + Accept-edits  = today's compose mode, but explicit
/plan    + Read-only     = today's plan mode, but deterministic
(nothing) + Default      = today's build mode
```

## [S5] Route

| Step | Change | Gate before next |
|---|---|---|
| 0 | Consolidate 14 skills → 3; slim compose.txt; move feature docs under `spec/` (**done**, `1975a8d5`, `7ff01213`, `f708b01e`) | Dogfood on real tasks; no regression vs old flow |
| 1a | Rename compose:{grill,docs,dev} → compose-{grill,spec,dev}; add `Skill.Info.scope`; introduce `Permission.evaluateSkill` and gate on scope not name-prefix (**done**, `23a13568`) | 187/187 relevant tests green; no name-prefix mechanism keys remain in code |
| 1b | **[separate PR — breaking]** Move skills to `skill/builtin/.bundle/` (still under `scope: "compose"`); add activation clause to descriptions; surface `compose.skills` config; design deprecation + migration path for users still on the compose-agent invocation | compose-* not spuriously invoked in normal build sessions; deprecation hint documented |
| 2 | `/compose` command template; delete prompt.ts injection; compose agent kept as thin alias for back-compat | /compose-from-build equals compose-mode behavior on the same tasks |
| 3 | Remove compose agent + compose-scope permission special-cases + compose extraction path | No user-facing workflow loss; config migration note |
| 4 | `/plan` command + Read-only preset; deprecate plan_enter/plan_exit (tool stubs warn) | Plan-mode parity: read-only actually enforced by preset |
| 5 | Tab cycles permission presets; agent concept internal-only | UI/UX validation |

Steps 1–2 are independently shippable and reversible. Step 3 is the point of
no return for the mode; 4–5 generalize the pattern.

## [S6] Out of Scope

- Rewriting the compose.js workflow's phase structure (it stays as-is).
- Sub-agent orchestration changes (actor/task machinery untouched).
- Removing the `skill` tool or changing skill loading for non-compose skills.
- Team/marketplace distribution of compose-* skills.
- Migrating existing `docs/compose/plans|reports` trees (old artifacts
  keep working; new work uses single feature documents under
  `docs/compose/spec/<feature>.md`).

## Tasks

- [x] T0: consolidate skills to grill/docs/dev, slim compose.txt — acceptance: tests green, typecheck clean (covers: S2)
- [x] T1a: rename compose:{grill,docs,dev} → compose-{grill,spec,dev}; wire `Skill.Info.scope`; gate permission via `Permission.evaluateSkill` instead of `name.startsWith("compose:")` — acceptance: no name-prefix mechanism keys remain in `search.ts` / `localized-alias.ts` / `TUI` / agent config; user skill `compose-foo` (scope=project) is not filtered on build agent (covers: S3)
- [ ] T1b: (SEPARATE PR — user-visible breaking change) move bundle from `skill/compose/.bundle/` to `skill/builtin/.bundle/`; add activation clause to each skill description; expose `compose.skills` config surface; design deprecation + migration hint for anyone still relying on the old compose-agent-only invocation path — acceptance: skills visible in build agent, not auto-triggered without /compose in test prompts; scan-time kill-switch removes scope=compose uniformly; deprecation surface documented in changelog (covers: S3) (depends: T1a)
- [ ] T2: add /compose command template rendering docs_dir at expansion; delete prompt.ts injection — acceptance: /compose from build agent reproduces compose-mode behavior on a golden task (covers: S3) (depends: T1b)
- [ ] T3: remove compose agent, compose-scope permission special-cases, compose scan scope — acceptance: no references to compose scope remain outside builtin; migration note in changelog (covers: S3) (depends: T2)
- [ ] T4: /plan command + Read-only permission preset; stub plan_enter/plan_exit — acceptance: Read-only preset blocks writes deterministically; /plan produces plan-mode-equivalent behavior (covers: S3, S4) (depends: T2)
- [ ] T5: Tab cycles permission presets — acceptance: UI switch changes only permissions, session agent unchanged (covers: S4) (depends: T3, T4)
