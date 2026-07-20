/**
 * MemoryRecorder + Event Ledger tests.
 *
 * Tests the Phase 1-2 implementation: single-writer authority,
 * append-only event ledger, duplicate detection, stale-base rejection.
 *
 * Run: bun test test/memory/recorder.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import {
  Service,
  layer as recorderLayer,
  type MemoryMutation,
  type Receipt,
} from "../../src/memory/recorder"

const TEST_DIR = path.join(import.meta.dir, ".test-recorder")
const TEST_DB = path.join(TEST_DIR, "test.db")

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true })
  // Set up test database
  process.env.MIMOCODE_DB = TEST_DB
  Database.Client()
})

afterAll(async () => {
  Database.close()
  await fs.rm(TEST_DIR, { recursive: true, force: true })
})

function runTest<E, A>(effect: Effect.Effect<A, E, Service>): Promise<A> {
  const program = effect.pipe(Effect.provide(recorderLayer))
  return Effect.runPromise(program as Effect.Effect<A, never, never>)
}

// ---------------------------------------------------------------------------
// P1-1: Single-writer authority
// ---------------------------------------------------------------------------
describe("P1-1: Single-writer authority", () => {
  test("submit accepts valid mutation and returns durable receipt", async () => {
    const mutation: MemoryMutation = {
      project_id: "test-project",
      session_id: "ses_test-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "test-rule-1",
      content: "# Test Rule\nThis is a test rule.",
      writer: "checkpoint-writer",
    }

    const receipt = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit(mutation)
      }),
    )

    expect(receipt.status).toBe("durable")
    expect(receipt.event_id).toBeTruthy()
    expect(receipt.project_sequence).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// P1-2: Duplicate detection
// ---------------------------------------------------------------------------
describe("P1-2: Duplicate detection", () => {
  test("duplicate identity_key returns duplicate status", async () => {
    const mutation: MemoryMutation = {
      project_id: "test-dedup",
      session_id: "ses_dedup-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "unique-rule-A",
      content: "# First write",
      writer: "checkpoint-writer",
    }

    const receipt1 = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit(mutation)
      }),
    )
    expect(receipt1.status).toBe("durable")

    // Second submit with same identity_key
    const receipt2 = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit({ ...mutation, content: "# Second write" })
      }),
    )
    expect(receipt2.status).toBe("duplicate")
    expect(receipt2.event_id).toBe(receipt1.event_id)
  })
})

// ---------------------------------------------------------------------------
// P1-3: Stale-base detection
// ---------------------------------------------------------------------------
describe("P1-3: Stale-base detection", () => {
  test("writer with wrong base_revision gets stale_base", async () => {
    const projectId = "test-stale"
    const baseMutation: MemoryMutation = {
      project_id: projectId,
      session_id: "ses_stale-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "stale-rule-1",
      content: "# Original content",
      writer: "checkpoint-writer",
    }

    const receipt1 = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit(baseMutation)
      }),
    )
    expect(receipt1.status).toBe("durable")

    // Try to write with wrong base_revision
    const staleMutation: MemoryMutation = {
      project_id: projectId,
      session_id: "ses_stale-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "stale-rule-2",
      content: "# New content with wrong base",
      writer: "checkpoint-writer",
      base_revision: "wrong-hash-value",
    }

    const receipt2 = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit(staleMutation)
      }),
    )
    expect(receipt2.status).toBe("stale_base")
  })
})

// ---------------------------------------------------------------------------
// P1-4: Ordering
// ---------------------------------------------------------------------------
describe("P1-4: Project ordering", () => {
  test("project_sequence increments monotonically", async () => {
    const projectId = "test-order"
    const receipts: Receipt[] = []

    for (let i = 0; i < 5; i++) {
      const receipt = await runTest(
        Effect.gen(function* () {
          const svc = yield* Service
          return yield* svc.submit({
            project_id: projectId,
            session_id: `ses_order-${i}`,
            kind: "memory_upsert",
            scope: "project",
            target: "MEMORY.md",
            operation: "upsert",
            identity_key: `order-rule-${i}`,
            content: `# Rule ${i}`,
            writer: "checkpoint-writer",
          })
        }),
      )
      receipts.push(receipt)
    }

    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].project_sequence).toBeGreaterThan(receipts[i - 1].project_sequence)
    }
  })
})

// ---------------------------------------------------------------------------
// P1-5: Query
// ---------------------------------------------------------------------------
describe("P1-5: Event query", () => {
  test("query returns events for a project in sequence order", async () => {
    const projectId = "test-query"

    // Insert 3 events
    for (let i = 0; i < 3; i++) {
      await runTest(
        Effect.gen(function* () {
          const svc = yield* Service
          return yield* svc.submit({
            project_id: projectId,
            session_id: `ses_query-${i}`,
            kind: "memory_upsert",
            scope: "project",
            target: "MEMORY.md",
            operation: "upsert",
            identity_key: `query-rule-${i}`,
            content: `# Query Rule ${i}`,
            writer: "checkpoint-writer",
          })
        }),
      )
    }

    const events = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.query({ project_id: projectId })
      }),
    )

    expect(events.length).toBe(3)
    expect(events[0].identity_key).toBe("query-rule-0")
    expect(events[1].identity_key).toBe("query-rule-1")
    expect(events[2].identity_key).toBe("query-rule-2")
  })
})

// ---------------------------------------------------------------------------
// P1-6: Policy rejection
// ---------------------------------------------------------------------------
describe("P1-6: Policy rejection", () => {
  test("unknown writer is rejected", async () => {
    const receipt = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit({
          project_id: "test-policy",
          session_id: "ses_policy-1",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "policy-rule-1",
          content: "# Policy Rule",
          writer: "unknown-writer" as any,
        })
      }),
    )

    expect(receipt.status).toBe("rejected_policy")
  })
})

// ---------------------------------------------------------------------------
// P1-7: Receipt structure
// ---------------------------------------------------------------------------
describe("P1-7: Receipt structure", () => {
  test("receipt contains required fields", async () => {
    const receipt = await runTest(
      Effect.gen(function* () {
        const svc = yield* Service
        return yield* svc.submit({
          project_id: "test-receipt",
          session_id: "ses_receipt-1",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "receipt-rule-1",
          content: "# Receipt Rule",
          writer: "checkpoint-writer",
        })
      }),
    )

    expect(receipt).toHaveProperty("event_id")
    expect(receipt).toHaveProperty("status")
    expect(receipt).toHaveProperty("project_sequence")
    expect(receipt).toHaveProperty("timestamp")
    expect(typeof receipt.event_id).toBe("string")
    expect(typeof receipt.status).toBe("string")
    expect(typeof receipt.project_sequence).toBe("number")
    expect(typeof receipt.timestamp).toBe("number")
  })
})
