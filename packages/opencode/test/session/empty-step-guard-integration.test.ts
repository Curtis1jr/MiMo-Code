/**
 * Integration tests for the empty tool-call retry guard (autoRetryEmptyToolCall +
 * isEmptyStep). Driven end-to-end through Session.prompt against a scripted
 * HTTP LLM stub — same harness as classify-integration.test.ts.
 *
 * Root cause this guards: a degraded model can spin by emitting empty/no-op
 * steps (empty terminal, or a tool call with empty arguments). TEXT_NGRAM only
 * inspects text and stepSignature drops zero-tool steps, so neither counts the
 * loop.
 *
 * Design: a SINGLE empty tool call is an invalid output — it IMMEDIATELY
 * triggers a RETRY that makes the model re-emit a valid call. The bad
 * assistant turn is DISCARDED (error-tagged) and a synthetic user turn is
 * appended to re-drive generation. On exhaustion (EMPTY_TOOL_CALL_RETRY_LIMIT
 * retries) the turn is terminated.
 *
 * EMPTY_TOOL_CALL_RETRY_LIMIT defaults to 2, so the ladder is:
 *   call 1 (empty) → retry 1 (error-tagged, synthetic user appended)
 *   call 2 (empty) → retry 2 (error-tagged, synthetic user appended)
 *   call 3 (empty) → exhaustion → terminal error, break
 * i.e. exactly 3 model calls before the turn is halted.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { Flag } from "../../src/flag/flag"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, emptyStopResponse, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function writeConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } },
      },
      agent: { build: { model: "alibaba/qwen-plus" } },
    }),
  )
}

describe("empty tool-call retry — integration", () => {
  test("repeated empty steps exhaust retries and halt the turn", async () => {
    await using tmp = await tmpdir({ git: true })
    // Every response is an empty stop step. The stub repeats its last entry
    // forever, so if the retry guard failed to halt this would spin indefinitely
    // (the test would hang / time out). We assert it terminates after retries
    // are exhausted.
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "empty-step-halt" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the task." }],
              })
              // Turn terminated (did not hang) with an error on the assistant.
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeDefined()
              // Bounded: EMPTY_TOOL_CALL_RETRY_LIMIT retries + 1 initial call.
              expect(stub.captures.length).toBe(Flag.MIMOCODE_EMPTY_TOOL_CALL_RETRY_LIMIT + 1)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("a single empty step triggers retry and recovers on next valid answer", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      // call 1: empty terminal → retry (error-tagged, synthetic user appended)
      { lines: emptyStopResponse() },
      // call 2: real answer → loop exits cleanly
      { lines: textStopResponse("here is the real answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "empty-step-recover" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the task." }],
              })
              // First empty call → retry; second call → valid text. 2 total LLM calls.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "here is the real answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("single empty step is discarded (error-tagged) from context", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: textStopResponse("final answer after retry") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "empty-step-discard" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Do the task." }],
              })
              // The first (empty) assistant turn should be error-tagged (discarded)
              // and not kept in context. The second turn should be the valid one.
              const messages = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistantMessages = messages.filter(
                (m) => m.info.role === "assistant",
              ) as Array<{ info: MessageV2.Assistant; parts: MessageV2.Part[] }>
              // First assistant message should have an error (discarded)
              expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
              if (assistantMessages[0]) {
                expect(assistantMessages[0].info.error).toBeDefined()
                expect(assistantMessages[0].info.error?.name).toBe("EmptyToolCallError")
              }
              // Final result should have no error
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeUndefined()
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
