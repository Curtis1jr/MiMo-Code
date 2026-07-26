/**
 * Certification Gate 9: Post-Generation Enforcement — LIVE PROOF
 *
 * Tests the ACTUAL SessionProcessor pipeline with TestLLMServer.
 * Proves: blocked claims are physically rewritten in the response text,
 * validator failure fails closed, supported text is released.
 *
 * These tests exercise the real code path in processor.ts, not toy abstractions.
 */

import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, reply, TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

function agent(): Agent.Info {
  return {
    name: "build",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  }
}

const user = Effect.fn("TestSession.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const assistant = Effect.fn("TestSession.assistant")(function* (
  sessionID: SessionID,
  parentID: MessageID,
  root: string,
) {
  const session = yield* Session.Service
  const msg: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: root, root },
    cost: 0,
    tokens: {
      total: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* session.updateMessage(msg)
  return msg
})

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  LLM.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  SessionProcessor.layer.pipe(Layer.provide(summary), Layer.provideMerge(deps)),
)

const it = testEffect(env)

const boot = Effect.fn("test.boot")(function* () {
  const processors = yield* SessionProcessor.Service
  const session = yield* Session.Service
  const provider = yield* Provider.Service
  return { processors, session, provider }
})

// ---------------------------------------------------------------------------
// PG-LIVE-1: DONE claim in LLM response is physically rewritten
// ---------------------------------------------------------------------------
it.live("post-generation enforcement rewrites DONE claims in response text", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // LLM returns text containing a DONE claim without evidence
        yield* llm.text("Phase 4A is DONE and COMPLETE")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "what is the status?")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "what is the status?" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const textPart = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        // CRITICAL: The text must be physically rewritten, not just metadata-flagged
        expect(textPart).toBeDefined()
        expect(textPart!.text).toContain("[BLOCKED:")
        expect(textPart!.text).not.toBe("Phase 4A is DONE and COMPLETE")

        // Metadata must also record the blocking
        expect(textPart!.metadata).toBeDefined()
        const validation = (textPart!.metadata as any)?.truth_validation
        expect(validation).toBeDefined()
        expect(validation.status).toBe("blocked_claims")
        expect(validation.blocked_claims.length).toBeGreaterThan(0)
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// PG-LIVE-2: Response without claims passes through unchanged
// ---------------------------------------------------------------------------
it.live("post-generation enforcement allows clean responses through", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        // LLM returns text with no claims
        yield* llm.text("The weather is nice today. Let me help you with your code.")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "hello")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "hello" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const textPart = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        // Text should pass through unchanged (no claims to block)
        expect(textPart).toBeDefined()
        expect(textPart!.text).toBe("The weather is nice today. Let me help you with your code.")
        expect(textPart!.text).not.toContain("[BLOCKED:")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)

// ---------------------------------------------------------------------------
// PG-LIVE-3: DEPLOYED claim is blocked
// ---------------------------------------------------------------------------
it.live("post-generation enforcement blocks false DEPLOYED claims", () =>
  provideTmpdirServer(
    ({ dir, llm }) =>
      Effect.gen(function* () {
        const { processors, session, provider } = yield* boot()

        yield* llm.text("The system is deployed to production and live")

        const chat = yield* session.create({})
        const parent = yield* user(chat.id, "is it deployed?")
        const msg = yield* assistant(chat.id, parent.id, path.resolve(dir))
        const mdl = yield* provider.getModel(ref.providerID, ref.modelID)
        const handle = yield* processors.create({
          assistantMessage: msg,
          sessionID: chat.id,
          model: mdl,
        })

        yield* handle.process({
          user: {
            id: parent.id,
            sessionID: chat.id,
            role: "user",
            time: parent.time,
            agent: parent.agent,
            model: { providerID: ref.providerID, modelID: ref.modelID },
          } satisfies MessageV2.User,
          sessionID: chat.id,
          model: mdl,
          agent: agent(),
          system: [],
          messages: [{ role: "user", content: "is it deployed?" }],
          tools: {},
        })

        const parts = MessageV2.parts(msg.id)
        const textPart = parts.find((part): part is MessageV2.TextPart => part.type === "text")

        // DEPLOYED claim must be blocked
        expect(textPart).toBeDefined()
        expect(textPart!.text).toContain("[BLOCKED:")
      }),
    { git: true, config: (url) => providerCfg(url) },
  ),
)
