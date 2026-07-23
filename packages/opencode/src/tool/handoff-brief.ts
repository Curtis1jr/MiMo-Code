import z from "zod"
import { Effect, Deferred } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./handoff-brief.txt"
import { Agent } from "../agent/agent"
import { Provider } from "../provider"
import { MessageV2 } from "../session/message-v2"
import { spawnRef } from "@/actor/spawn-ref"

const SIDEKICK_AGENT = "fusion-sidekick"

const parameters = z.strictObject({
  goal: z
    .string()
    .min(10, "goal must be at least one sentence")
    .max(300, "goal must fit on one line — move detail into constraints or definition_of_done")
    .describe("One sentence describing what the sidekick should achieve. Unambiguous."),
  constraints: z
    .array(z.string().min(1))
    .min(1, "at least one hard constraint is required — if there truly are none, write \"no additional constraints beyond DoD\"")
    .describe(
      "Hard rules the sidekick MUST hold. State invariants, not mechanisms (\"operator() must be O(1)\" not \"use a Set\").",
    ),
  definition_of_done: z
    .array(z.string().min(1))
    .min(1, "at least one verifiable DoD item is required")
    .describe("Verifiable outcomes. Prefer test-command + expected-result over prose."),
  edge_cases: z
    .array(z.string().min(1))
    .default([])
    .describe("Inputs the sidekick must handle correctly. Empty when there are genuinely none."),
  do_not: z
    .array(z.string().min(1))
    .default([])
    .describe("Forbidden actions when they aren't obvious from constraints."),
  files_expected: z
    .array(z.string().min(1))
    .default([])
    .describe("Files the sidekick is likely to touch, to save re-exploration."),
  test_command: z
    .string()
    .min(1)
    .optional()
    .describe("Shell command the sidekick should run to verify DoD (e.g. `bun test packages/opencode/src/foo.test.ts`)."),
  description: z
    .string()
    .min(1)
    .max(80)
    .describe("Short (3-8 word) label shown in the TUI for this delegation."),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("(optional) Milliseconds before the sidekick call is abandoned. Default 600000 (10 min)."),
})

type Metadata = {
  sessionId: string
  actorId: string
  status?: string
  summary?: string
}

function renderBrief(input: z.infer<typeof parameters>): string {
  const lines: string[] = []
  lines.push("# Handoff Brief")
  lines.push("")
  lines.push("## Goal")
  lines.push(input.goal)
  lines.push("")
  lines.push("## Constraints (hard)")
  for (const c of input.constraints) lines.push(`- ${c}`)
  lines.push("")
  lines.push("## Definition of Done (all must pass)")
  for (const d of input.definition_of_done) lines.push(`- ${d}`)
  if (input.edge_cases.length) {
    lines.push("")
    lines.push("## Edge cases")
    for (const e of input.edge_cases) lines.push(`- ${e}`)
  }
  if (input.do_not.length) {
    lines.push("")
    lines.push("## Do NOT")
    for (const d of input.do_not) lines.push(`- ${d}`)
  }
  if (input.files_expected.length) {
    lines.push("")
    lines.push("## Files expected to change")
    for (const f of input.files_expected) lines.push(`- ${f}`)
  }
  if (input.test_command) {
    lines.push("")
    lines.push("## Test command")
    lines.push("```")
    lines.push(input.test_command)
    lines.push("```")
  }
  lines.push("")
  lines.push(
    "Return a `**Status**: success|partial|failed|blocked` header per your agent prompt. Verify DoD before reporting success.",
  )
  return lines.join("\n")
}

export const HandoffBriefTool = Tool.define<typeof parameters, Metadata, Agent.Service | Provider.Service>(
  "handoff_brief",
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const provider = yield* Provider.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (input: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const sidekick = yield* agent.get(SIDEKICK_AGENT)
          if (!sidekick) {
            return yield* Effect.die(
              new Error(
                `handoff_brief requires the ${SIDEKICK_AGENT} agent (Fusion mode). Set MIMOCODE_EXPERIMENTAL_FUSION=1 to enable.`,
              ),
            )
          }

          const spawn = spawnRef.current
          if (!spawn) {
            return yield* Effect.die(
              new Error("Actor service unavailable — Actor.defaultLayer must be running for handoff_brief."),
            )
          }

          const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
          if (msg.info.role !== "assistant") {
            return yield* Effect.fail(new Error("handoff_brief must run from an assistant message"))
          }

          const modelRef = sidekick.modelRef
          const model = modelRef
            ? yield* provider
                .resolveModelRef(modelRef, msg.info.providerID)
                .pipe(Effect.map((m) => ({ modelID: m.id, providerID: m.providerID })))
            : (sidekick.model ?? { modelID: msg.info.modelID, providerID: msg.info.providerID })

          const brief = renderBrief(input)

          const result = yield* spawn.spawn({
            mode: "subagent",
            sessionID: ctx.sessionID,
            agentType: SIDEKICK_AGENT,
            description: input.description,
            task: brief,
            context: "none",
            tools: sidekick.toolAllowlist ? [...sidekick.toolAllowlist] : "INHERIT",
            model,
            background: false,
            onReady: ({ actorID, sessionID }) =>
              ctx.metadata({
                title: input.description,
                metadata: { sessionId: sessionID, actorId: actorID },
              }),
          })

          const outcome = yield* Deferred.await(result.outcome).pipe(
            Effect.timeout(input.timeout_ms ?? 600_000),
            Effect.catchTag("TimeoutError", () => Effect.succeed({ status: "timeout" as const })),
          )

          if (outcome.status === "failure") {
            return yield* Effect.fail(
              new Error(`fusion-sidekick failed: ${outcome.error ?? "unknown"}`),
            )
          }

          const resultText =
            outcome.status === "success"
              ? (outcome.finalText ?? "(no output)")
              : outcome.status === "timeout"
                ? "<timeout>sidekick did not complete within timeout</timeout>"
                : "<cancelled>sidekick was cancelled</cancelled>"

          const statusAttr = outcome.status === "success" ? (outcome.reportedStatus ?? "unknown") : outcome.status
          const summary = outcome.status === "success" ? outcome.reportedSummary : undefined

          return {
            title: input.description,
            metadata: {
              sessionId: result.sessionID,
              actorId: result.actorID,
              status: statusAttr,
              ...(summary ? { summary } : {}),
            },
            output: [
              `actor_id: ${result.actorID}`,
              "",
              `<sidekick_result status="${statusAttr}"${summary ? ` summary=${JSON.stringify(summary)}` : ""}>`,
              resultText,
              "</sidekick_result>",
            ].join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
