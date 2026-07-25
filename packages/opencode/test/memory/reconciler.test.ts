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
import { randomUUID } from "crypto"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import { MemoryEventTable } from "../../src/memory/event.sql"
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

/** Insert event directly into ledger, bypassing recorder duplicate detection.
 *  Used to create conflict scenarios for reconciler testing. */
function insertDirectly(mutation: MemoryMutation & { project_sequence: number; session_sequence: number }): void {
  Database.use((db) =>
    db.insert(MemoryEventTable).values({
      event_id: randomUUID(),
      project_id: mutation.project_id,
      session_id: mutation.session_id,
      kind: mutation.kind,
      scope: mutation.scope,
      target: mutation.target,
      operation: mutation.operation,
      identity_key: mutation.identity_key,
      content: mutation.content,
      source_turn: mutation.source_turn ?? null,
      writer: mutation.writer,
      base_revision: mutation.base_revision ?? null,
      policy_version: "1",
      session_sequence: mutation.session_sequence,
      project_sequence: mutation.project_sequence,
      timestamp: Date.now(),
      status: "durable",
    }).run(),
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

// ---------------------------------------------------------------------------
// P3-7: Conflict register
// ---------------------------------------------------------------------------
describe("P3-7: Conflict register", () => {
  test("semantic conflict is recorded in conflict register", async () => {
    const projectId = "conflict-register-project"

    // First event via recorder
    await submitEvent({
      project_id: projectId,
      session_id: "ses_cr-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "conflict-rule",
      content: "# Original version",
      writer: "checkpoint-writer",
    })

    // Second event with same identity_key inserted directly (bypasses recorder dedup)
    insertDirectly({
      project_id: projectId,
      session_id: "ses_cr-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "conflict-rule",
      content: "# Conflicting version",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 1,
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(result.conflicts.length).toBeGreaterThan(0)
    expect(result.conflicts[0].identity_key).toBe("conflict-rule")
    expect(result.conflicts[0].conflict_type).toBe("semantic_conflict")
  })
})

// ---------------------------------------------------------------------------
// P3-8: Last uncontested value preservation
// ---------------------------------------------------------------------------
describe("P3-8: Last uncontested value preservation", () => {
  test("high-impact conflict preserves last uncontested value", async () => {
    const projectId = "uncontested-project"

    // Original value
    await submitEvent({
      project_id: projectId,
      session_id: "ses_uc-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "architecture-decision",
      content: "# Architecture: Use SQLite",
      writer: "checkpoint-writer",
    })

    // Conflicting value inserted directly (high-impact: "architecture")
    insertDirectly({
      project_id: projectId,
      session_id: "ses_uc-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "architecture-decision",
      content: "# Architecture: Use PostgreSQL",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 1,
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    // Should preserve the uncontested value (SQLite) because "architecture" is high-impact
    expect(result.content).toContain("SQLite")
    expect(result.content).not.toContain("PostgreSQL")
    expect(result.conflicts.length).toBe(1)
    expect(result.conflicts[0].resolution).toBe("manual")
  })
})

// ---------------------------------------------------------------------------
// P3-9: Policy-based auto-resolution
// ---------------------------------------------------------------------------
describe("P3-9: Policy-based auto-resolution", () => {
  test("non-high-impact conflict auto-resolves with accept_newer", async () => {
    const projectId = "auto-resolve-project"

    await submitEvent({
      project_id: projectId,
      session_id: "ses_ar-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "routine-update",
      content: "# Old routine update",
      writer: "checkpoint-writer",
    })

    insertDirectly({
      project_id: projectId,
      session_id: "ses_ar-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "routine-update",
      content: "# New routine update",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 1,
    })

    const result = await Effect.runPromise(
      reconcile({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    // Should auto-resolve with newer value
    expect(result.content).toContain("New routine update")
    expect(result.conflicts.length).toBe(1)
    expect(result.conflicts[0].resolution).toBe("accept_newer")
  })
})
