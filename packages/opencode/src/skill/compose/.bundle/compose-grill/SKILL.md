---
name: compose-grill
description: Use before creative or ambiguous work — new features, behavior changes, design decisions. Interviews the user one decision at a time until shared understanding, then hands off to compose-spec.
---

# Grill — Requirements Interrogation

Interview the user relentlessly about the task until you reach a shared understanding. Treat the plan as a tree of unresolved decisions: walk down each branch, resolving dependencies between decisions one by one — a parent decision settled before the choices that hang off it.

## Rules of the Interview

- **One decision per turn.** A decision is one branch of the tree — one axis whose answer unblocks the next question. Never bundle unrelated decisions ("should we revert AND how does CI change AND when is sprint?") — each answer must inform the NEXT decision, and mixing axes just confuses the user. When a single decision genuinely has multiple must-answer parameters (e.g. revert vs keep + how to respond to the feedback + which branch), collect them as one structured `question` call rather than dragging them across turns. The tree, not the arithmetic, sets the pace.
- **Recommend an answer with every question.** Take a position with reasoning — the user reacts to a proposal, not a blank prompt.
- **Facts from the environment, decisions from the user.** If a question can be answered by exploring the codebase (files, docs, recent commits), look it up instead of asking. Only genuine decisions go to the user. Explore project context FIRST — before the first question, not after.
- **Scope first.** If the request spans multiple independent subsystems, surface the decomposition before refining details of any one piece — each sub-project then gets its own grill → docs → dev cycle.
- **Propose alternatives.** For load-bearing design decisions, offer 2-3 approaches with trade-offs, leading with your recommendation — don't converge on the first workable idea.
- Do not write code or start implementation until shared understanding is confirmed (or you are autonomous — see below).

## How to Ask

Every question goes through the `question` tool — never prose ("Should I proceed?" ends your turn without finishing the task).

- Known choices → `options` with label + description; put your recommendation first, marked "(Recommended)".
- Open-ended → empty `options` (renders as free-text input).
- One concern per question; unrelated decisions are separate questions.

## Autonomous Mode

When no user is available (question tool absent, or a `[Never-Ask]` response): conduct the interview with yourself. Pose the questions you would have asked, answer each from project context and best judgment, state your choices and reasoning in your response text, and continue. Prefer text-only, non-interactive, minimal-scope answers. Destructive or irreversible choices never auto-approve — take the non-destructive path. This applies to the current question only — ask normally at the next decision point; the user may have returned.

## Visual Aids

Most questions are text — ASCII sketches, option tables, and mermaid blocks in your normal output cover layout and architecture discussions. If a decision genuinely can't be judged without seeing it rendered (competing UI mockups, a complex diagram), improvise with what the environment offers: write a throwaway HTML file and ask the user to open it, or use any preview tool available. Ask consent before opening a browser; clean up throwaway files afterwards. Headless: always text-only.

## Exit

The interview ends when the user confirms shared understanding (autonomous: when every open branch is resolved). Then invoke `compose-spec` to record the design and task list. For trivially small, fully-constrained changes, skip the document and go straight to `compose-dev` with the understanding kept in conversation.
