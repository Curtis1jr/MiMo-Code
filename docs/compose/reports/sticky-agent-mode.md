---
feature: sticky-agent-mode
status: experimental
specs: []
plans: []
branch: exp/sticky-agent-mode
commits: e418785e..fe72d4e2
---

# Sticky Agent Mode — Final Report

## What Was Built

An experimental mode-locking system where agent selection is permanent for the duration of a session. Once a session has content (any user message), the user cannot switch to a different mode group. Build and Plan form a single free-switch group; all other agents (Compose, etc.) are isolated — once you're in Compose, you stay in Compose until `/new`.

Alongside this, compose skills are migrated from `hidden: true` to permission-based scoping. The compose agent's permission allows `compose:*` skills; all other agents deny them. This eliminates the hardcoded `composeSkillsBlock()` injection — compose skills appear in the normal system prompt skill listing when the compose agent is active.

## Architecture

### Sticky Mode (TUI)

**File:** `packages/opencode/src/cli/cmd/tui/context/local.tsx`

- `agentStore.sessionHasMessages` — reactive boolean derived from `!!lastUserMessage()`
- `FREE_SWITCH_GROUP = ["build", "plan"]` — agents that can freely switch between each other
- `canSwitchTo(target)` — returns true if: no messages yet, OR both current and target are in the same group
- `set(name)` — unguarded, for system/programmatic use (session restore, plan tools, CLI)
- `userSwitch(name)` — guarded, for user actions (dialog, voice). Shows toast when blocked
- `move(direction)` — cycles through agents, skipping blocked ones. Toast only when no valid target exists

**File:** `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`

```ts
createEffect(() => {
  local.agent.setSessionHasMessages(!!lastUserMessage())
})
```

Single reactive effect — no manual lock/unlock. Naturally handles `/new` (empty session = unlocked), `/session` (has messages = locked), and message submission.

### Permission-Based Skill Scoping

**File:** `packages/opencode/src/agent/agent.ts`

- `defaults` includes `skill: { "*": "allow", "compose:*": "deny" }`
- Compose agent overrides with `skill: { "compose:*": "allow" }`

**File:** `packages/opencode/src/skill/index.ts`

- `Skill.available()` no longer filters `!sk.hidden` — relies entirely on permission

**File:** `packages/opencode/src/skill/compose/.bundle/*/SKILL.md`

- All 14 compose skills: `hidden: true` removed from frontmatter

### Compose Prompt Cleanup

**File:** `packages/opencode/src/session/prompt.ts`

- `composeSkillsBlock()` import and call removed
- Only `{{compose_docs_dir}}` substitution remains in PROMPT_COMPOSE

**File:** `packages/opencode/src/session/prompt/compose.txt`

- "Compose Skills Visibility" section simplified: skills are in the normal listing
- Subagent guidance: "distill instructions" instead of "pass skill lists"

### Design Decisions

**`set()` vs `userSwitch()` separation:** The guard only applies to user-initiated actions (Tab, dialog, voice). System paths (session restore, plan_enter/plan_exit, CLI --agent) use `set()` directly and are never blocked. This avoids a fragile whitelist of "force" call sites.

**Reactive `sessionHasMessages` from `lastUserMessage()`:** No manual lock/unlock state. The signal is derived from actual session content, so `/new`, `/session`, and submits all work correctly without explicit handling.

**`move()` skips blocked agents:** Tab cycles within the allowed group instead of stopping at the first blocked agent. Toast only shows when the entire group has been exhausted (e.g., compose mode with no other compose-group agents).

**Permission in defaults (deny) + compose override (allow):** Future agents automatically inherit the `compose:*` deny. Only the compose agent explicitly opts in. This is more future-proof than denying on each non-compose agent individually.

**Subagent distillation model:** Compose skills instruct the orchestrator to distill guidance into concrete subagent prompts, rather than passing `<available_skills>` blocks. Subagents are leaf workers — they don't need orchestration skills.

## Usage

This is an experimental branch (`exp/sticky-agent-mode`). Behavior:

- **New session:** Mode selector works normally (Tab cycles all agents)
- **After first message:** Mode is locked to the current group
  - Build/Plan: can Tab between them freely
  - Compose: Tab shows toast — "进入 compose 模式后无法在运行中切换模式"
- **`/new`:** Creates empty session → mode unlocked again
- **`/session`:** Enters existing session → mode locked to that session's agent

## Verification

- `bun typecheck` — clean (0 errors)
- `bun test test/session/prompt-skill-mention.test.ts` — 8/8 pass
- `bun test test/permission` — 141/141 pass
- Manual TUI testing: Tab cycling, `/session`, `/new`, toast messages

## Journey Log

> Brief notes on what informed the final design.

- [dead end] `lock()` boolean — persisted after `/new`, broke mode switching on new sessions
- [dead end] Guard in `set()` with `{ force: true }` bypass — fragile, missed system call sites
- [pivot] Switched to reactive `!!lastUserMessage()` derivation — handles all session transitions naturally
- [pivot] Separated `set()` (system) from `userSwitch()` (user) — eliminated the whitelist problem entirely
- [lesson] `move()` must skip blocked agents, not stop at the first one — otherwise Tab breaks within the allowed group
