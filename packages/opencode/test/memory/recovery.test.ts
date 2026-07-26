/**
 * Phase 5 — Recovery, Compaction, and Rebuild tests.
 *
 * Tests:
 * 1. Replay durable events
 * 2. Compaction
 * 3. Projection rebuild
 *
 * Run: bun test test/memory/recovery.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { randomUUID } from "crypto"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import { MemoryEventTable } from "../../src/memory/event.sql"
import { eq } from "drizzle-orm"
import {
  replayDurableEvents,
  compactEvents,
  rebuildProjections,
} from "../../src/memory/recovery"

const TEST_DIR = path.join(import.meta.dir, ".test-recovery")
const TEST_DB = path.join(TEST_DIR, "test.db")
const PROJECT_DIR = path.join(TEST_DIR, "project")

beforeAll(async () => {
  await fs.mkdir(TEST_DIR, { recursive: true })
  await fs.mkdir(PROJECT_DIR, { recursive: true })
  process.env.MIMOCODE_DB = TEST_DB
  Database.Client()
})

afterAll(async () => {
  Database.close()
  await fs.rm(TEST_DIR, { recursive: true, force: true })
})

function insertEvent(overrides: Partial<typeof MemoryEventTable.$inferInsert> & { event_id: string; project_id: string; session_id: string; identity_key: string; content: string; writer: string }): void {
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
// R-1: Replay durable events
// ---------------------------------------------------------------------------
describe("R-1: Replay durable events", () => {
  test("replay transitions durable events to applied", async () => {
    const projectId = "test-replay"

    // Insert durable events
    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-r1-1",
      identity_key: "replay-rule-1",
      content: "# Replay Rule 1",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-r1-2",
      identity_key: "replay-rule-2",
      content: "# Replay Rule 2",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 1,
    })

    // Replay
    const result = await Effect.runPromise(
      replayDurableEvents() as Effect.Effect<any, never, never>,
    )

    expect(result.replayed).toBe(2)
    expect(result.failed).toBe(0)
    expect(result.errors).toHaveLength(0)

    // Verify events are now applied
    const events = Database.use((db) =>
      db.select().from(MemoryEventTable).where(eq(MemoryEventTable.project_id, projectId)).all(),
    )

    for (const event of events) {
      expect(event.status).toBe("applied")
    }
  })

  test("replay with no durable events returns zero", async () => {
    const result = await Effect.runPromise(
      replayDurableEvents() as Effect.Effect<any, never, never>,
    )

    // Previous test already replayed everything
    expect(result.replayed).toBe(0)
    expect(result.failed).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// R-2: Compaction
// ---------------------------------------------------------------------------
describe("R-2: Compaction", () => {
  test("compaction archives old superseded events", async () => {
    const projectId = "test-compact"
    const now = Date.now()

    // Insert old events
    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-r2-1",
      identity_key: "compact-rule",
      content: "# Old version",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
      timestamp: now - 48 * 60 * 60 * 1000, // 48 hours ago
      status: "applied",
    })

    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-r2-2",
      identity_key: "compact-rule",
      content: "# New version",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 1,
      timestamp: now - 24 * 60 * 60 * 1000, // 24 hours ago
      status: "applied",
    })

    // Compact events older than 12 hours
    const result = await Effect.runPromise(
      compactEvents(projectId, 12 * 60 * 60 * 1000) as Effect.Effect<any, never, never>,
    )

    expect(result.archived).toBe(1) // The old version should be archived
    expect(result.deleted).toBe(0)
    expect(result.errors).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// R-3: Projection rebuild
// ---------------------------------------------------------------------------
describe("R-3: Projection rebuild", () => {
  test("rebuild function exists and is callable", async () => {
    // Verify the rebuild function exists and can be called
    expect(typeof rebuildProjections).toBe("function")

    // Call with a project that has no events - should return empty targets
    const result = await Effect.runPromise(
      rebuildProjections("nonexistent-project", PROJECT_DIR) as Effect.Effect<any, never, never>,
    )

    expect(result).toHaveProperty("targets")
    expect(result).toHaveProperty("errors")
    expect(Array.isArray(result.targets)).toBe(true)
    expect(Array.isArray(result.errors)).toBe(true)
  })
})
