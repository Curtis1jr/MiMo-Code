---
name: compose-grill
description: Use when a feature, behavior change, or design decision is ambiguous. Resolve requirements one decision at a time, then hand the settled scope to compose-spec.
---

# Grill

Inspect the repository, its instructions, and recent changes before asking anything. Do not ask the user for facts available from the environment.

## Resolve Decisions

- Ask about one decision axis at a time. A single decision may include multiple dependent fields in one structured question; unrelated decisions require separate turns.
- Recommend one option and give the relevant trade-off. For consequential choices, include 2-3 viable alternatives.
- Split requests spanning independent subsystems before refining each part.
- Do not implement until the requirements and scope are settled.

Use the `question` tool for every user decision:

- Put known choices in `options`. Give each option a concise `label` and a `description` explaining the consequence; list the recommendation first and mark its label `(Recommended)`.
- When choices cannot be enumerated, still call `question` and pass `options: []` to request free-text input.
- Do not ask for permission to continue when no decision remains.

Use text, ASCII, tables, or Mermaid when they are enough to decide. If visual comparison requires rendering, create a temporary preview with available tools, ask before opening a browser, and remove temporary files afterward. When no user is available, remain text-only.

## Without User Input

If the question tool is unavailable or returns `[Never-Ask]`, resolve that decision yourself and continue the workflow:

1. Choose the option marked `(Recommended)` when repository evidence still supports it and it can run unattended.
2. Otherwise choose the closest minimal-scope option supported by the evidence.
3. If the decision includes destructive or irreversible work, choose a non-destructive path that preserves progress; never auto-approve the destructive option.
4. State the option selected and the reason in the response.

This fallback applies only to the current decision. At every later decision point, call the `question` tool again; `[Never-Ask]` does not disable future questions or pause the workflow.

## Exit

When no unresolved decision can change the implementation, invoke `compose-spec`. For a fully constrained mechanical change that needs no durable feature document, invoke `compose-dev` directly.
