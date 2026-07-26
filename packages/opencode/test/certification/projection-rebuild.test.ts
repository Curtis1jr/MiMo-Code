/**
 * Certification Gate 7: Projection Rebuild — LIVE PROOF
 *
 * Tests actual projection generation from the memory ledger database.
 * Proves: projections are deterministic, rebuild from ledger produces same output.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { randomUUID } from "crypto"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import { MemoryEventTable } from "../../src/memory/event.sql"
import { eq } from "drizzle-orm"
import { generateProjection } from "../../src/memory/projection"
import { Effect } from "effect"

const TEST_DIR = path.join(import.meta.dir, ".test-projection")
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

function insertEvent(overrides: Partial<typeof MemoryEventTable.$inferInsert> & {
  event_id: string
  project_id: string
  session_id: string
  identity_key: string
  content: string
  writer: string
}): void {
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
// RB-1: Projection generation from ledger
// ---------------------------------------------------------------------------
describe("RB-1: Projection generation from ledger", () => {
  test("projection is generated from durable events", async () => {
    const projectId = "proj-rebuild-1"

    // Insert events
    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "section-1",
      content: "# Section 1\nContent for section 1",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "section-2",
      content: "# Section 2\nContent for section 2",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 2,
    })

    // Generate projection
    const projection = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as any,
    )

    expect(projection.event_count).toBe(2)
    expect(projection.content).toContain("Section 1")
    expect(projection.content).toContain("Section 2")
    expect(projection.content_hash).toBeTruthy()
    expect(projection.high_water_mark).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// RB-2: Deterministic rebuild
// ---------------------------------------------------------------------------
describe("RB-2: Deterministic rebuild", () => {
  test("rebuilding projection produces identical content", async () => {
    const projectId = "proj-rebuild-det"

    insertEvent({
      event_id: randomUUID(),
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "det-section",
      content: "# Deterministic\nContent",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    // First build
    const first = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as any,
    )

    // Second build
    const second = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as any,
    )

    // Must be identical
    expect(first.content_hash).toBe(second.content_hash)
    expect(first.content).toBe(second.content)
    expect(first.high_water_mark).toBe(second.high_water_mark)
  })
})

// ---------------------------------------------------------------------------
// RB-3: Supersession in projections
// ---------------------------------------------------------------------------
describe("RB-3: Supersession in projections", () => {
  test("superseded events are replaced in projection", async () => {
    const projectId = "proj-rebuild-supersede"

    // Insert original
    insertEvent({
      event_id: "evt-original",
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "mutable-section",
      content: "# Original Content",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    // Insert supersession
    insertEvent({
      event_id: "evt-superseded",
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "mutable-section",
      content: "# Updated Content",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 2,
      operation: "supersede",
      supersedes_event_id: "evt-original",
    })

    // Generate projection
    const projection = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as any,
    )

    // Should contain updated content, not original
    expect(projection.content).toContain("Updated Content")
    expect(projection.content).not.toContain("Original Content")
    expect(projection.event_count).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// RB-4: Delete operations in projections
// ---------------------------------------------------------------------------
describe("RB-4: Delete operations in projections", () => {
  test("deleted events are excluded from projection", async () => {
    const projectId = "proj-rebuild-delete"

    // Insert event
    insertEvent({
      event_id: "evt-to-delete",
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "deletable-section",
      content: "# To Be Deleted",
      writer: "checkpoint-writer",
      project_sequence: 1,
      session_sequence: 1,
    })

    // Insert another event
    insertEvent({
      event_id: "evt-keep",
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "keep-section",
      content: "# Keep This",
      writer: "checkpoint-writer",
      project_sequence: 2,
      session_sequence: 2,
    })

    // Delete the first
    insertEvent({
      event_id: "evt-delete-op",
      project_id: projectId,
      session_id: "ses-1",
      identity_key: "deletable-section",
      content: "",
      writer: "checkpoint-writer",
      project_sequence: 3,
      session_sequence: 3,
      operation: "delete",
    })

    // Generate projection
    const projection = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as any,
    )

    // Should not contain deleted content
    expect(projection.content).not.toContain("To Be Deleted")
    expect(projection.content).toContain("Keep This")
  })
})

// ---------------------------------------------------------------------------
// RB-5: Empty projection
// ---------------------------------------------------------------------------
describe("RB-5: Empty projection", () => {
  test("project with no events produces empty projection", async () => {
    const projection = await Effect.runPromise(
      generateProjection({ project_id: "nonexistent-project", target: "MEMORY.md" }) as any,
    )

    expect(projection.event_count).toBe(0)
    expect(projection.content).toBe("")
    expect(projection.content_hash).toBe("")
    expect(projection.high_water_mark).toBe(0)
  })
})
