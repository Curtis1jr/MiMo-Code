/**
 * Phase 4 — Projection materialization, manifest integration, snapshot tests.
 *
 * Tests the runtime path: canonical ledger → reconciler → atomic generated projection.
 *
 * Run: bun test test/memory/phase4.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { Effect } from "effect"
import { randomUUID } from "crypto"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import { MemoryEventTable } from "../../src/memory/event.sql"
import { eq, and } from "drizzle-orm"
import {
  Service as RecorderService,
  layer as recorderLayer,
  type MemoryMutation,
} from "../../src/memory/recorder"
import {
  Service as ManifestService,
  layer as manifestLayer,
} from "../../src/memory/manifest"
import {
  generateProjection,
  generateAllProjections,
  generateOverlay,
  writeProjectionAtomic,
  type Projection,
} from "../../src/memory/projection"
import {
  isProjectionPath,
  isProjectionWriteBlocked,
  PROJECTION_WRITE_ERROR,
} from "../../src/tool/shared-guard"

const TEST_DIR = path.join(import.meta.dir, ".test-phase4")
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

function runWithRecorders<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(recorderLayer)) as Effect.Effect<A, never, never>,
  )
}

function runWithBoth<A>(effect: Effect.Effect<A, any, any>): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(recorderLayer)).pipe(Effect.provide(manifestLayer)) as Effect.Effect<A, never, never>,
  )
}

async function submitMutation(mutation: MemoryMutation): Promise<any> {
  return runWithRecorders(
    Effect.gen(function* () {
      const recorder = yield* RecorderService
      return yield* recorder.submit(mutation)
    }),
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
// P4-4.1: Projection generated solely from ledger events
// ---------------------------------------------------------------------------
describe("P4-4.1: Projection from ledger", () => {
  test("projection content matches ledger events", async () => {
    const projectId = "p4-proj-ledger"

    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4p1-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "proj-rule-1",
      content: "# Projection Rule 1",
      writer: "checkpoint-writer",
    })

    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4p1-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "proj-rule-2",
      content: "# Projection Rule 2",
      writer: "checkpoint-writer",
    })

    const projection = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(projection.content).toContain("# Projection Rule 1")
    expect(projection.content).toContain("# Projection Rule 2")
    expect(projection.event_count).toBe(2)
    expect(projection.latest_sequence).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P4-4.2: Projection metadata matches ledger state
// ---------------------------------------------------------------------------
describe("P4-4.2: Projection metadata", () => {
  test("projection includes all required metadata fields", async () => {
    const projectId = "p4-proj-meta"

    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4m-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "meta-rule",
      content: "# Meta Rule",
      writer: "checkpoint-writer",
    })

    const projection = await Effect.runPromise(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(projection).toHaveProperty("target")
    expect(projection).toHaveProperty("content")
    expect(projection).toHaveProperty("content_hash")
    expect(projection).toHaveProperty("event_count")
    expect(projection).toHaveProperty("latest_sequence")
    expect(projection).toHaveProperty("generated_at")
    expect(projection).toHaveProperty("high_water_mark")
    expect(projection).toHaveProperty("projection_revision")
    expect(projection).toHaveProperty("policy_version")
    expect(projection).toHaveProperty("recorder_identity")

    expect(projection.high_water_mark).toBe(projection.latest_sequence)
    expect(projection.policy_version).toBe("1")
    expect(projection.recorder_identity).toBe("memory-recorder")
    expect(projection.content_hash).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// P4-4.3: Direct projection write rejection
// ---------------------------------------------------------------------------
describe("P4-4.3: Projection write rejection", () => {
  test("isProjectionPath identifies protected files", () => {
    expect(isProjectionPath("/some/path/memory/projects/pid/MEMORY.md")).toBe(true)
    expect(isProjectionPath("/some/path/memory/projects/pid/MEMORY-spillover.md")).toBe(true)
    expect(isProjectionPath("/some/path/memory/global/MEMORY.md")).toBe(true)
    expect(isProjectionPath("/some/path/memory/sessions/sid/checkpoint.md")).toBe(true)
    expect(isProjectionPath("/some/path/memory/sessions/sid/checkpoint-topic.md")).toBe(true)
    expect(isProjectionPath("/some/path/other/file.md")).toBe(false)
    expect(isProjectionPath("/some/path/memory/sessions/sid/notes.md")).toBe(false)
  })

  test("isProjectionWriteBlocked returns true by default", () => {
    expect(isProjectionWriteBlocked()).toBe(true)
  })

  test("isProjectionWriteBlocked returns false in migration mode", () => {
    process.env.MIMOCODE_MIGRATION_MODE = "1"
    expect(isProjectionWriteBlocked()).toBe(false)
    delete process.env.MIMOCODE_MIGRATION_MODE
    expect(isProjectionWriteBlocked()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// P4-4.4: Atomic projection write
// ---------------------------------------------------------------------------
describe("P4-4.4: Atomic projection write", () => {
  test("writeProjectionAtomic writes content to file", async () => {
    const filePath = path.join(TEST_DIR, "test-projection.md")
    const content = "# Test Projection\nContent here."

    const result = await writeProjectionAtomic(filePath, content)
    expect(result.success).toBe(true)

    const written = await fs.readFile(filePath, "utf8")
    expect(written).toBe(content)
  })

  test("writeProjectionAtomic preserves previous on failure", async () => {
    const filePath = path.join(TEST_DIR, "preserve-test.md")
    const original = "# Original content"
    await fs.writeFile(filePath, original)

    // Try to write to a non-existent directory (should fail)
    const badPath = path.join(TEST_DIR, "nonexistent-dir", "test.md")
    const result = await writeProjectionAtomic(badPath, "# New content")

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()

    // Original should be preserved
    const preserved = await fs.readFile(filePath, "utf8")
    expect(preserved).toBe(original)
  })
})

// ---------------------------------------------------------------------------
// P4-4.5: Manifest fields
// ---------------------------------------------------------------------------
describe("P4-4.5: Manifest fields", () => {
  test("manifest contains all required fields", async () => {
    const projectId = "p4-manifest-fields"
    const sessionId = "ses_p4f-1"

    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: sessionId,
          worker_id: "lane-test",
          canonical_store_id: "worker-lane-test",
        })
      }),
    )

    expect(manifest).toHaveProperty("manifest_id")
    expect(manifest).toHaveProperty("project_id")
    expect(manifest).toHaveProperty("session_id")
    expect(manifest).toHaveProperty("worker_id")
    expect(manifest).toHaveProperty("canonical_store_id")
    expect(manifest).toHaveProperty("ledger_high_water_mark")
    expect(manifest).toHaveProperty("projection_revision")
    expect(manifest).toHaveProperty("projection_hash")
    expect(manifest).toHaveProperty("policy_version")
    expect(manifest).toHaveProperty("recorder_identity")
    expect(manifest).toHaveProperty("files_loaded")
    expect(manifest).toHaveProperty("memories_loaded")
    expect(manifest).toHaveProperty("pending_overlay_revision")
    expect(manifest).toHaveProperty("conflicts")
    expect(manifest).toHaveProperty("unresolved_context")
    expect(manifest).toHaveProperty("created_at")
    expect(manifest).toHaveProperty("refreshed_at")

    expect(manifest.manifest_id).toBeTruthy()
    expect(manifest.worker_id).toBe("lane-test")
    expect(manifest.canonical_store_id).toBe("worker-lane-test")
    expect(manifest.created_at).toBe(manifest.refreshed_at)
  })
})

// ---------------------------------------------------------------------------
// P4-4.6: Snapshot isolation — later events don't alter pinned view
// ---------------------------------------------------------------------------
describe("P4-4.6: Snapshot isolation", () => {
  test("pinned snapshot is stable regardless of later events", async () => {
    const projectId = "p4-snap-iso"

    // Create event before manifest
    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4s-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "snap-v1",
      content: "# Snap V1",
      writer: "checkpoint-writer",
    })

    // Create manifest
    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: "ses_p4s-manifest",
        })
      }),
    )

    const hwm = manifest.ledger_high_water_mark

    // Insert event AFTER manifest
    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4s-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "snap-v2",
      content: "# Snap V2",
      writer: "checkpoint-writer",
    })

    // Manifest's high-water mark should NOT change
    const current = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.get("ses_p4s-manifest")
      }),
    )

    expect(current!.ledger_high_water_mark).toBe(hwm)
  })
})

// ---------------------------------------------------------------------------
// P4-4.7: Refresh advances snapshot
// ---------------------------------------------------------------------------
describe("P4-4.7: Refresh advances snapshot", () => {
  test("refresh advances high-water mark and revision", async () => {
    const projectId = "p4-refresh"

    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4r-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "refresh-v1",
      content: "# Refresh V1",
      writer: "checkpoint-writer",
    })

    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: "ses_p4r-manifest",
        })
      }),
    )

    const originalHwm = manifest.ledger_high_water_mark
    const originalRevision = manifest.projection_revision

    // Add more events
    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4r-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "refresh-v2",
      content: "# Refresh V2",
      writer: "checkpoint-writer",
    })

    // Refresh
    const refreshed = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.refresh("ses_p4r-manifest")
      }),
    )

    expect(refreshed.ledger_high_water_mark).toBeGreaterThan(originalHwm)
    expect(refreshed.projection_revision).toBe(originalRevision + 1)
    expect(refreshed.refreshed_at).toBeGreaterThan(manifest.created_at)
  })
})

// ---------------------------------------------------------------------------
// P4-4.8: Pending overlay
// ---------------------------------------------------------------------------
describe("P4-4.8: Pending overlay", () => {
  test("pending events appear through overlay", async () => {
    const projectId = "p4-overlay"

    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4o-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "overlay-v1",
      content: "# Overlay V1",
      writer: "checkpoint-writer",
    })

    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: "ses_p4o-manifest",
        })
      }),
    )

    // Add events after manifest
    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4o-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "overlay-v2",
      content: "# Overlay V2",
      writer: "checkpoint-writer",
    })

    // Get pending events
    const pending = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.getPendingEvents(manifest)
      }),
    )

    expect(pending.length).toBeGreaterThan(0)
    expect(pending.some((e: any) => e.identity_key === "overlay-v2")).toBe(true)
    // Should NOT include events before manifest
    expect(pending.every((e: any) => e.project_sequence > manifest.ledger_high_water_mark)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// P4-4.9: Cross-project isolation
// ---------------------------------------------------------------------------
describe("P4-4.9: Cross-project isolation", () => {
  test("events from different projects do not mix", async () => {
    const projectA = "p4-iso-A"
    const projectB = "p4-iso-B"

    await submitMutation({
      project_id: projectA,
      session_id: "ses_p4i-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "iso-rule-A",
      content: "# Project A Rule",
      writer: "checkpoint-writer",
    })

    await submitMutation({
      project_id: projectB,
      session_id: "ses_p4i-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "iso-rule-B",
      content: "# Project B Rule",
      writer: "checkpoint-writer",
    })

    const projA = await Effect.runPromise(
      generateProjection({ project_id: projectA, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    const projB = await Effect.runPromise(
      generateProjection({ project_id: projectB, target: "MEMORY.md" }) as Effect.Effect<any, never, never>,
    )

    expect(projA.content).toContain("Project A Rule")
    expect(projA.content).not.toContain("Project B Rule")

    expect(projB.content).toContain("Project B Rule")
    expect(projB.content).not.toContain("Project A Rule")
  })
})

// ---------------------------------------------------------------------------
// P4-4.10: Cross-session isolation
// ---------------------------------------------------------------------------
describe("P4-4.10: Cross-session isolation", () => {
  test("different sessions get independent manifests", async () => {
    const projectId = "p4-cross-session"

    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4x-1",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "x-rule-1",
      content: "# X Rule 1",
      writer: "checkpoint-writer",
    })

    const manifest1 = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: "ses_p4x-manifest-1",
        })
      }),
    )

    // Add more events
    await submitMutation({
      project_id: projectId,
      session_id: "ses_p4x-2",
      kind: "memory_upsert",
      scope: "project",
      target: "MEMORY.md",
      operation: "upsert",
      identity_key: "x-rule-2",
      content: "# X Rule 2",
      writer: "checkpoint-writer",
    })

    const manifest2 = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: "ses_p4x-manifest-2",
        })
      }),
    )

    // Session 2 should have a higher HWM than session 1
    expect(manifest2.ledger_high_water_mark).toBeGreaterThan(manifest1.ledger_high_water_mark)

    // Session 1's pending events should include the event from session 2
    const pending1 = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.getPendingEvents(manifest1)
      }),
    )

    expect(pending1.some((e: any) => e.identity_key === "x-rule-2")).toBe(true)
  })
})
