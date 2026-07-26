/**
 * Certification Gate 6: Performance — LIVE PROOF
 *
 * Measures actual MiMo session creation and message operations.
 */

import { NodeFileSystem } from "@effect/platform-node"
import { expect } from "bun:test"
import { describe, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { SessionProcessor } from "../../src/session/processor"
import { SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { SessionSummary } from "../../src/session/summary"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const summary = Layer.succeed(
  SessionSummary.Service,
  SessionSummary.Service.of({
    summarize: () => Effect.void,
    diff: () => Effect.succeed([]),
    computeDiff: () => Effect.succeed([]),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
const deps = Layer.mergeAll(
  Session.defaultLayer,
  Snapshot.defaultLayer,
  AgentSvc.defaultLayer,
  Permission.defaultLayer,
  Plugin.defaultLayer,
  Config.defaultLayer,
  SessionProcessor.defaultLayer,
  Provider.defaultLayer,
  status,
).pipe(Layer.provideMerge(infra))
const env = Layer.mergeAll(
  TestLLMServer.layer,
  summary,
  deps,
)

const it = testEffect(env)

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b)
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

// ---------------------------------------------------------------------------
// PERF-1: Session creation latency
// ---------------------------------------------------------------------------
it.live("performance: session creation latency", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service
        const latencies: number[] = []
        const iterations = 20

        for (let i = 0; i < iterations; i++) {
          const start = performance.now()
          yield* session.create({})
          latencies.push(performance.now() - start)
        }

        const p50 = percentile(latencies, 50)
        const p99 = percentile(latencies, 99)

        // Session creation should be fast
        expect(p50).toBeLessThan(100) // 100ms p50
        expect(p99).toBeLessThan(500) // 500ms p99

        return { p50, p99, iterations }
      }),
    { git: true },
  ),
)

// ---------------------------------------------------------------------------
// PERF-2: Session retrieval latency
// ---------------------------------------------------------------------------
it.live("performance: session retrieval latency", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service

        // Create sessions first
        const sessionIds: string[] = []
        for (let i = 0; i < 10; i++) {
          const chat = yield* session.create({})
          sessionIds.push(chat.id)
        }

        // Measure retrieval latency
        const latencies: number[] = []
        for (const id of sessionIds) {
          const start = performance.now()
          yield* session.get(id as SessionID)
          latencies.push(performance.now() - start)
        }

        const p50 = percentile(latencies, 50)
        const p99 = percentile(latencies, 99)

        expect(p50).toBeLessThan(50) // 50ms p50
        expect(p99).toBeLessThan(200) // 200ms p99

        return { p50, p99 }
      }),
    { git: true },
  ),
)

// ---------------------------------------------------------------------------
// PERF-3: Message creation latency
// ---------------------------------------------------------------------------
it.live("performance: message creation latency", () =>
  provideTmpdirServer(
    ({ dir }) =>
      Effect.gen(function* () {
        const session = yield* Session.Service

        const chat = yield* session.create({})
        const latencies: number[] = []
        const iterations = 20

        for (let i = 0; i < iterations; i++) {
          const start = performance.now()
          yield* session.updateMessage({
            id: `msg-${i}-${Date.now()}` as any,
            role: "user",
            sessionID: chat.id,
            agent: "build",
            model: { providerID: "test" as any, modelID: "test-model" as any },
            time: { created: Date.now() },
          })
          latencies.push(performance.now() - start)
        }

        const p50 = percentile(latencies, 50)
        const p99 = percentile(latencies, 99)

        expect(p50).toBeLessThan(50) // 50ms p50
        expect(p99).toBeLessThan(200) // 200ms p99

        return { p50, p99, iterations }
      }),
    { git: true },
  ),
)
