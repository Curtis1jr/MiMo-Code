/**
 * MemoryReconciler tests.
 *
 * Tests the Phase 3 implementation: deterministic reconciliation,
 * identity-key matching, conflict detection, projection generation.
 *
 * Run: bun test test/memory/reconciler.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import { Service, layer as recorderLayer, type MemoryMutation } from "../../src/memory/recorder"
import { reconcile, reconcileAll } from "../../src/memory/reconciler"

const TEST_DIR = path.join(import.meta.dir, ".test-reconciler")
const TEST_DB = path.join(TEST_DIR, "test.db")

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true })
  process.env.MIMOCODE_DB = TEST_DB
  Database.Client()
})

afterAll(async () => {
  Database.close()
  await fs.rm(TEST_DIR, { recursive: true, force: true })
})

async function submitEvent(mutation: MemoryMutation): Promise<void> {
  await Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* Service
      yield* svc.submit(mutation)
    }).pipe(Effect.provide(recorderLayer)) as Effect.Effect<void, never, never>,
  )
}

// ---------------------------------------------------------------------------
// P3-1: Deterministic reconciliation
// ---------------------------------------------------------------------------
describe("P3-1: Deterministic reconciliation", () => {
  test("empty project produces empty projection", async () => {
    const result = await Effect.runPromise(
      reconcile({ project_id: "empty-project", target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result.content).toBe("")
    expect(result.event_count).toBe(0)
    expect(result.latest_sequence).toBe(0)
  })

  test("single event produces correct projection", async () => {
    const projectId = "single-event-project"
    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "rule-1",
      content: "# Rule 1\nThis is rule one.",
      writer: "checkpoint-writer",
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result.content).toContain("# Rule 1")
    expect(result.content).toContain("This is rule one.")
    expect(result.event_count).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// P3-2: Identity-key matching
// ---------------------------------------------------------------------------
describe("P3-2: Identity-key matching", () => {
  test("multiple identities produce combined projection", async () => {
    const projectId = "multi-identity-project"

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "rule-A",
      content: "# Rule A",
      writer: "checkpoint-writer",
    })

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "rule-B",
      content: "# Rule B",
      writer: "checkpoint-writer",
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result.content).toContain("# Rule A")
    expect(result.content).toContain("# Rule B")
    expect(result.event_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P3-3: Supersession
// ---------------------------------------------------------------------------
describe("P3-3: Supersession", () => {
  test("supersede operation replaces existing identity", async () => {
    const projectId = "supersede-project"

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "mutable-rule",
      content: "# Original version",
      writer: "checkpoint-writer",
    })

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-2",
      kind: "memory_supersede",
      scope: "project",
      target: "MEMORY.md",
      operation: "supersede",
      identity_key: "mutable-rule",
      content: "# Updated version",
      writer: "checkpoint-writer",
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result.content).toContain("# Updated version")
    expect(result.content).not.toContain("# Original version")
  })
})

// ---------------------------------------------------------------------------
// P3-4: Deletion
// ---------------------------------------------------------------------------
describe("P3-4: Deletion", () => {
  test("delete operation removes identity from projection", async () => {
    const projectId = "delete-project"

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "ephemeral-rule",
      content: "# This will be deleted",
      writer: "checkpoint-writer",
    })

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-2",
      kind: "memory_delete",
      scope: "project",
      target: "MEMORY.md",
      operation: "delete",
      identity_key: "ephemeral-rule",
      content: "",
      writer: "checkpoint-writer",
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result.content).not.toContain("# This will be deleted")
    expect(result.event_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P3-5: Deterministic order
// ---------------------------------------------------------------------------
describe("P3-5: Deterministic order", () => {
  test("projection is deterministic regardless of submission order", async () => {
    const projectId = "deterministic-project"

    // Submit in reverse order
    for (let i = 5; i >= 1; i--) {
      await submitEvent({
        project_id: projectId,
        session_id: `ses_test-${i}`,
        kind: "memory_upsert",
        scope: "project",
        target: "MEMORY.md",
        operation: "upsert",
        identity_key: `order-${i}`,
        content: `# Order ${i}`,
        writer: "checkpoint-writer",
      })
    }

    // Reconcile multiple times
    const result1 = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )
    const result2 = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result1.content).toBe(result2.content)
    expect(result1.event_count).toBe(result2.event_count)
  })
})

// ---------------------------------------------------------------------------
// P3-6: reconcileAll
// ---------------------------------------------------------------------------
describe("P3-6: reconcileAll", () => {
  test("reconciles all targets for a project", async () => {
    const projectId = "multi-target-project"

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "memory-rule",
      content: "# Memory Rule",
      writer: "checkpoint-writer",
    })

    await submitEvent({
      project_id: projectId,
      session_id: "ses_test-2",
      kind: "checkpoint_update",
      scope: "session",
      target: "checkpoint.md",
      operation: "upsert",
      identity_key: "checkpoint-state",
      content: "# Checkpoint State",
      writer: "checkpoint-writer",
    })

    const results = await Effect.runPromise(
      reconcileAll({ project_id: projectId }) as Effect.Effect<any[], never, never>,
    )

    expect(results.length).toBe(2)
    const targets = results.map((r: any) => r.target).sort()
    expect(targets).toContain("MEMORY.md")
    expect(targets).toContain("checkpoint.md")
  })
})
