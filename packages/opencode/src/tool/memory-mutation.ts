import { Effect } from "effect"
import z from "zod"
import { Service as RecorderService } from "../memory/recorder"
import { materializeProjections } from "../memory/projection"
import * as Tool from "./tool"

const parameters = z.object({
  project_id: z.string().describe("Project ID"),
  session_id: z.string().describe("Session ID"),
  target: z.enum(["MEMORY.md", "checkpoint.md"]).describe("Target projection file"),
  identity_key: z.string().describe("Semantic identity key for deduplication"),
  content: z.string().describe("Markdown content for the projection"),
  operation: z.enum(["upsert", "supersede", "delete"]).default("upsert").describe("Mutation operation"),
})

export const MemoryMutationTool = Tool.define(
  "memory-mutation",
  Effect.gen(function* () {
    const recorder = yield* RecorderService

    return {
      description: "Submit a typed memory mutation to the recorder. Use this instead of Write/Edit for MEMORY.md and checkpoint.md projections.",
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Submit mutation to recorder
          const receipt = yield* recorder.submit({
            project_id: args.project_id,
            session_id: args.session_id,
            kind: args.target === "MEMORY.md" ? "memory_upsert" : "checkpoint_update",
            scope: args.target === "MEMORY.md" ? "project" : "session",
            target: args.target,
            operation: args.operation,
            identity_key: args.identity_key,
            content: args.content,
            writer: "checkpoint-writer",
          })

          // Trigger projection materialization
          yield* Effect.promise(() =>
            materializeProjections(args.project_id, process.cwd()).catch(() => ({ targets: [], errors: [] }))
          )

          return {
            title: `Memory mutation: ${receipt.status}`,
            output: [
              `Event ID: ${receipt.event_id}`,
              `Status: ${receipt.status}`,
              `Project sequence: ${receipt.project_sequence}`,
              `Session sequence: ${receipt.session_sequence}`,
              `Target: ${args.target}`,
              `Identity: ${args.identity_key}`,
            ].join("\n"),
            metadata: {
              event_id: receipt.event_id,
              status: receipt.status,
              project_sequence: receipt.project_sequence,
            },
          }
        }),
    }
  }),
)
