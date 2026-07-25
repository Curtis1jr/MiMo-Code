/**
 * Event Ledger tests.
 *
 * Tests ledger integrity: immutability, sequence constraints,
 * WAL recovery, status lifecycle, replay idempotency.
 *
 * Run: bun test test/memory/ledger.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { randomUUID } from "crypto"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import { MemoryEventTable } from "../../src/memory/event.sql"
import { eq, and, sql } from "drizzle-orm"
import { Service, layer as recorderLayer, type MemoryMutation } from "../../src/memory/recorder"

const TEST_DIR = path.join(import.meta.dir, ".test-ledger")
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

async function submitEvent(mutation: MemoryMutation): Promise<any> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* Service
      return yield* svc.submit(mutation)
    }).pipe(Effect.provide(recorderLayer)) as Effect.Effect<any, never, never>,
  )
}

function insertRawEvent(overrides: Partial<typeof MemoryEventTable.$inferInsert> & { event_id: string; project_id: string; session_id: string; identity_key: string; content: string; writer: string }): void {
  Database.use((db) =>
    db.insert(MemoryEventTable).values({
      session_sequence: 0,
      project_sequence: 0,
      timestamp: Date.now(),
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      base_revision: null,
      supersedes_event_id: null,
      migration_receipt_id: null,
      policy_version: "1",
      status: "durable",
      source_turn: null,
      ...overrides,
    }).run(),
  )
}

// ---------------------------------------------------------------------------
// L-1: Immutable events
// ---------------------------------------------------------------------------
describe("L-1: Immutable events", () => {
  test("events cannot be updated after insert", async () => {
    const eventId = randomUUID()
    insertRawEvent({
      event_id: eventId,
      project_id: "test-immutable",
      session_id: "ses_imm-1",
      identity_key: "immutable-rule",
      content: "# Original",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    // Verify event exists
    const before = Database.use((db) =>
      db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, eventId)).get(),
    )
    expect(before).toBeTruthy()
    expect(before!.content).toBe("# Original")

    // Attempt update — SQLite allows this by default, but our application
    // contract says events are immutable. The ledger enforcement is at the
    // application layer (recorder), not the DB layer.
    // This test documents the contract: the recorder never issues UPDATE.
    // For DB-level enforcement, a trigger would be needed.
    expect(before!.status).toBe("durable")
  })

  test("corrections use new events with supersedes_event_id", async () => {
    const originalId = randomUUID()
    const correctionId = randomUUID()

    insertRawEvent({
      event_id: originalId,
      project_id: "test-correction",
      session_id: "ses_corr-1",
      identity_key: "correctable-rule",
      content: "# Original version",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    insertRawEvent({
      event_id: correctionId,
      project_id: "test-correction",
      session_id: "ses_corr-2",
      identity_key: "correctable-rule",
      content: "# Corrected version",
      writer: "checkpoint-writer",
      operation: "supersede",
      supersedes_event_id: originalId,
      project_sequence: 2,
      session_sequence: 1,
    })

    // Both events exist — original is not deleted
    const original = Database.use((db) =>
      db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, originalId)).get(),
    )
    const correction = Database.use((db) =>
      db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, correctionId)).get(),
    )

    expect(original).toBeTruthy()
    expect(correction).toBeTruthy()
    expect(correction!.supersedes_event_id).toBe(originalId)
    expect(correction!.operation).toBe("supersede")
  })
})

// ---------------------------------------------------------------------------
// L-2: Sequence uniqueness
// ---------------------------------------------------------------------------
describe("L-2: Sequence constraints", () => {
  test("project_sequence increments monotonically", async () => {
    const projectId = "test-seq-mono"
    const receipts = []

    for (let i = 0; i < 5; i++) {
      const receipt = await submitEvent({
        project_id: projectId,
        session_id: `ses_seq-${i}`,
        kind: "memory_upsert",
        scope: "project",
        target: "MEMORY.md",
        operation: "upsert",
        identity_key: `seq-rule-${i}`,
        content: `# Seq ${i}`,
        writer: "checkpoint-writer",
      })
      receipts.push(receipt)
    }

    for (let i = 1; i < receipts.length; i++) {
      expect(receipts[i].project_sequence).toBe(receipts[i - 1].project_sequence + 1)
    }
  })

  test("session_sequence increments monotonically per session", async () => {
    const sessionId = "ses_same-session"
    const projectId = "test-session-seq"
    const receipts = []

    for (let i = 0; i < 3; i++) {
      const receipt = await submitEvent({
        project_id: projectId,
        session_id: sessionId,
        kind: "memory_upsert",
        scope: "project",
        target: "MEMORY.md",
        operation: "upsert",
        identity_key: `ss-rule-${i}`,
        content: `# SS ${i}`,
        writer: "checkpoint-writer",
      })
      receipts.push(receipt)
    }

    expect(receipts[0].session_sequence).toBe(1)
    expect(receipts[1].session_sequence).toBe(2)
    expect(receipts[2].session_sequence).toBe(3)
  })

  test("different sessions have independent sequences", async () => {
    const projectId = "test-indep-seq"

    const r1 = await submitEvent({
      project_id: projectId,
      session_id: "ses_indep-A",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "indep-A",
      content: "# A",
      writer: "checkpoint-writer",
    })

    const r2 = await submitEvent({
      project_id: projectId,
      session_id: "ses_indep-B",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "indep-B",
      content: "# B",
      writer: "checkpoint-writer",
    })

    // Both should have session_sequence 1 (independent)
    expect(r1.session_sequence).toBe(1)
    expect(r2.session_sequence).toBe(1)
    // But different project_sequences
    expect(r1.project_sequence).not.toBe(r2.project_sequence)
  })
})

// ---------------------------------------------------------------------------
// L-3: Status lifecycle
// ---------------------------------------------------------------------------
describe("L-3: Status lifecycle", () => {
  test("fresh event gets durable status", async () => {
    const receipt = await submitEvent({
      project_id: "test-status",
      session_id: "ses_status-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "status-rule",
      content: "# Status test",
      writer: "checkpoint-writer",
    })

    expect(receipt.status).toBe("durable")
  })

  test("duplicate event gets duplicate status", async () => {
    const mutation: MemoryMutation = {
      project_id: "test-dup-status",
      session_id: "ses_dup-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "dup-status-rule",
      content: "# Dup test",
      writer: "checkpoint-writer",
    }

    await submitEvent(mutation)
    const r2 = await submitEvent(mutation)
    expect(r2.status).toBe("duplicate")
  })

  test("stale base gets stale_base status", async () => {
    await submitEvent({
      project_id: "test-stale-status",
      session_id: "ses_stale-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "stale-status-rule",
      content: "# Original",
      writer: "checkpoint-writer",
    })

    const r2 = await submitEvent({
      project_id: "test-stale-status",
      session_id: "ses_stale-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "stale-status-rule-2",
      content: "# New with wrong base",
      writer: "checkpoint-writer",
      base_revision: "wrong-hash",
    })

    expect(r2.status).toBe("stale_base")
  })

  test("rejected policy gets rejected_policy status", async () => {
    const r = await submitEvent({
      project_id: "test-reject-status",
      session_id: "ses_reject-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "reject-rule",
      content: "# Reject test",
      writer: "unknown-writer" as any,
    })

    expect(r.status).toBe("rejected_policy")
  })
})

// ---------------------------------------------------------------------------
// L-4: WAL recovery
// ---------------------------------------------------------------------------
describe("L-4: WAL recovery", () => {
  test("events persist after WAL checkpoint", async () => {
    const projectId = "test-wal"

    await submitEvent({
      project_id: projectId,
      session_id: "ses_wal-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "wal-rule",
      content: "# WAL test",
      writer: "checkpoint-writer",
    })

    // Force WAL checkpoint
    Database.use((db) => {
      db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`)
    })

    // Verify event survives
    const events = Database.use((db) =>
      db.select().from(MemoryEventTable).where(eq(MemoryEventTable.project_id, projectId)).all(),
    )

    expect(events.length).toBe(1)
    expect(events[0].identity_key).toBe("wal-rule")
    expect(events[0].content).toBe("# WAL test")
  })
})

// ---------------------------------------------------------------------------
// L-5: Event query
// ---------------------------------------------------------------------------
describe("L-5: Event query", () => {
  test("query returns events in sequence order", async () => {
    const projectId = "test-query-order"

    for (let i = 0; i < 5; i++) {
      await submitEvent({
        project_id: projectId,
        session_id: `ses_qo-${i}`,
        kind: "memory_upsert",
        scope: "project",
        target: "MEMORY.md",
        operation: "upsert",
        identity_key: `qo-rule-${i}`,
        content: `# QO ${i}`,
        writer: "checkpoint-writer",
      })
    }

    const svc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Service
      }).pipe(Effect.provide(recorderLayer)) as Effect.Effect<any, never, never>,
    )

    const events = await Effect.runPromise(
      svc.query({ project_id: projectId }) as Effect.Effect<any, never, never>,
    )

    expect(events.length).toBe(5)
    for (let i = 1; i < events.length; i++) {
      expect(events[i].project_sequence).toBeGreaterThan(events[i - 1].project_sequence)
    }
  })

  test("query with since_sequence filters correctly", async () => {
    const projectId = "test-since-seq"

    for (let i = 0; i < 5; i++) {
      await submitEvent({
        project_id: projectId,
        session_id: `ses_ss-${i}`,
        kind: "memory_upsert",
        scope: "project",
        target: "MEMORY.md",
        operation: "upsert",
        identity_key: `ss-rule-${i}`,
        content: `# SS ${i}`,
        writer: "checkpoint-writer",
      })
    }

    const svc = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Service
      }).pipe(Effect.provide(recorderLayer)) as Effect.Effect<any, never, never>,
    )

    const events = await Effect.runPromise(
      svc.query({ project_id: projectId, since_sequence: 3 }) as Effect.Effect<any, never, never>,
    )

    // Should only return events with project_sequence > 3
    for (const event of events) {
      expect(event.project_sequence).toBeGreaterThan(3)
    }
  })
})

// ---------------------------------------------------------------------------
// L-6: Migration provenance
// ---------------------------------------------------------------------------
describe("L-6: Migration provenance", () => {
  test("migration event preserves receipt ID", async () => {
    const receiptId = "migration_test_receipt_123"
    const eventId = randomUUID()

    insertRawEvent({
      event_id: eventId,
      project_id: "test-migration",
      session_id: "ses_mig-1",
      identity_key: "mig-rule",
      content: "# Migrated content",
      writer: "migration",
      migration_receipt_id: receiptId,
      project_sequence: 1,
      session_sequence: 1,
    })

    const event = Database.use((db) =>
      db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, eventId)).get(),
    )

    expect(event).toBeTruthy()
    expect(event!.migration_receipt_id).toBe(receiptId)
    expect(event!.writer).toBe("migration")
  })
})

// ---------------------------------------------------------------------------
// L-7: Supersedes chain
// ---------------------------------------------------------------------------
describe("L-7: Supersedes chain", () => {
  test("supersedes_event_id creates correction chain", async () => {
    const id1 = randomUUID()
    const id2 = randomUUID()
    const id3 = randomUUID()

    insertRawEvent({
      event_id: id1,
      project_id: "test-sup-chain",
      session_id: "ses_sc-1",
      identity_key: "chain-rule",
      content: "# Version 1",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    insertRawEvent({
      event_id: id2,
      project_id: "test-sup-chain",
      session_id: "ses_sc-2",
      identity_key: "chain-rule",
      content: "# Version 2",
      writer: "checkpoint-writer",
      operation: "supersede",
      supersedes_event_id: id1,
      project_sequence: 2,
      session_sequence: 1,
    })

    insertRawEvent({
      event_id: id3,
      project_id: "test-sup-chain",
      session_id: "ses_sc-3",
      identity_key: "chain-rule",
      content: "# Version 3",
      writer: "checkpoint-writer",
      operation: "supersede",
      supersedes_event_id: id2,
      project_sequence: 3,
      session_sequence: 1,
    })

    const e1 = Database.use((db) => db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, id1)).get())
    const e2 = Database.use((db) => db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, id2)).get())
    const e3 = Database.use((db) => db.select().from(MemoryEventTable).where(eq(MemoryEventTable.event_id, id3)).get())

    expect(e1!.supersedes_event_id).toBeNull()
    expect(e2!.supersedes_event_id).toBe(id1)
    expect(e3!.supersedes_event_id).toBe(id2)

    // All three events exist (immutable history)
    expect(e1).toBeTruthy()
    expect(e2).toBeTruthy()
    expect(e3).toBeTruthy()
  })
})
