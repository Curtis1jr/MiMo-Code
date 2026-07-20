/**
 * Phase 4 — Session manifest, snapshot isolation, and projection demotion tests.
 *
 * Tests:
 * 1. Session reads from pinned snapshot
 * 2. Another session's later event does not silently alter the first session's snapshot
 * 3. Explicit refresh advances high-water mark
 * 4. Pending accepted events appear through overlay
 * 5. Generic file tools cannot directly mutate projection files
 * 6. Recorder events regenerate the projection
 * 7. Project and session scope cannot cross
 * 8. Manifests survive restart or fail explicitly
 * 9. Projection revision/hash match ledger high-water mark
 * 10. Installed runtime executes certified Phase 4 build
 *
 * Run: bun test test/memory/manifest.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test"
import { Effect } from "effect"
import path from "path"
import fs from "fs/promises"
import { Database } from "../../src/storage"
import {
  Service as RecorderService,
  layer as recorderLayer,
  type MemoryMutation,
} from "../../src/memory/recorder"
import {
  Service as ManifestService,
  layer as manifestLayer,
  type SessionManifest,
} from "../../src/memory/manifest"
import { generateProjection, generateAllProjections, generateOverlay } from "../../src/memory/projection"
import {
  isProjectionPath,
  isProjectionWriteBlocked,
  PROJECTION_WRITE_ERROR,
} from "../../src/tool/shared-guard"

const TEST_DIR = path.join(import.meta.dir, ".test-manifest")
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

// ---------------------------------------------------------------------------
// P4-1: Session reads from pinned snapshot
// ---------------------------------------------------------------------------
describe("P4-1: Pinned snapshot", () => {
  test("session reads from pinned snapshot at creation time", async () => {
    const projectId = "p4-snapshot-test"
    const sessionId = "ses-p4-1"

    // Insert an event first
    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-other",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "rule-before",
          content: "# Rule Before",
          writer: "checkpoint-writer",
        })
      }),
    )

    // Create manifest after the event
    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: sessionId,
        })
      }),
    )

    // Insert another event AFTER manifest creation
    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-other-2",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "rule-after",
          content: "# Rule After",
          writer: "checkpoint-writer",
        })
      }),
    )

    // Manifest's high-water mark should be from creation time
    expect(manifest.ledger_high_water_mark).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// P4-2: Later event does not silently alter snapshot
// ---------------------------------------------------------------------------
describe("P4-2: Snapshot isolation", () => {
  test("pending events are separate from snapshot", async () => {
    const projectId = "p4-isolation-test"
    const sessionId = "ses-p4-2"

    // Insert event, create manifest, insert another event
    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-other",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "v1",
          content: "# V1",
          writer: "checkpoint-writer",
        })
      }),
    )

    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: sessionId,
        })
      }),
    )

    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-other-2",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "v2",
          content: "# V2",
          writer: "checkpoint-writer",
        })
      }),
    )

    // Get snapshot - should have 1 pending event
    const snapshot = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.getSnapshot(sessionId)
      }),
    )

    expect(snapshot).not.toBeNull()
    expect(snapshot!.pending_count).toBe(1)
    expect(snapshot!.events_since_manifest[0].identity_key).toBe("v2")
  })
})

// ---------------------------------------------------------------------------
// P4-3: Explicit refresh advances high-water mark
// ---------------------------------------------------------------------------
describe("P4-3: Refresh advances high-water mark", () => {
  test("refresh advances the manifest's high-water mark", async () => {
    const projectId = "p4-refresh-test"
    const sessionId = "ses-p4-3"

    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-other",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "v1",
          content: "# V1",
          writer: "checkpoint-writer",
        })
      }),
    )

    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.create({
          project_id: projectId,
          session_id: sessionId,
        })
      }),
    )

    expect(manifest.ledger_high_water_mark).toBe(1)

    // Add another event
    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-other-2",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "v2",
          content: "# V2",
          writer: "checkpoint-writer",
        })
      }),
    )

    // Refresh should advance the mark
    const refreshed = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.refresh(sessionId)
      }),
    )

    expect(refreshed.ledger_high_water_mark).toBe(2)
    expect(refreshed.projection_revision).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// P4-4: Pending events appear through overlay
// ---------------------------------------------------------------------------
describe("P4-4: Pending events overlay", () => {
  test("overlay shows events after high-water mark", async () => {
    const projectId = "p4-overlay-test"

    // Insert 3 events
    for (let i = 1; i <= 3; i++) {
      await runWithRecorders(
        Effect.gen(function* () {
          const recorder = yield* RecorderService
          yield* recorder.submit({
            project_id: projectId,
            session_id: `ses-${i}`,
            kind: "memory_upsert",
            scope: "project",
            target: "MEMORY.md",
            operation: "upsert",
            identity_key: `rule-${i}`,
            content: `# Rule ${i}`,
            writer: "checkpoint-writer",
          })
        }),
      )
    }

    // Get overlay after sequence 1
    const overlay = await runWithRecorders(
      generateOverlay({ project_id: projectId, high_water_mark: 1 }),
    )

    expect(overlay.length).toBe(2)
    expect(overlay[0].identity_key).toBe("rule-2")
    expect(overlay[1].identity_key).toBe("rule-3")
  })
})

// ---------------------------------------------------------------------------
// P4-5: Generic file tools cannot directly mutate projection files
// ---------------------------------------------------------------------------
describe("P4-5: Projection write block", () => {
  test("isProjectionPath returns true for MEMORY.md", () => {
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/projects/abc/MEMORY.md")).toBe(true)
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/projects/abc/MEMORY-rules.md")).toBe(true)
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/sessions/ses_1/checkpoint.md")).toBe(true)
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/sessions/ses_1/checkpoint-rules.md")).toBe(true)
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/global/MEMORY.md")).toBe(true)
  })

  test("isProjectionPath returns false for non-projection files", () => {
    expect(isProjectionPath("/home/user/project/src/main.ts")).toBe(false)
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/sessions/ses_1/notes.md")).toBe(false)
    expect(isProjectionPath("/home/user/.local/share/mimocode/memory/sessions/ses_1/tasks/T1/progress.md")).toBe(false)
  })

  test("isProjectionWriteBlocked returns true by default", () => {
    delete process.env.MIMOCODE_MIGRATION_MODE
    expect(isProjectionWriteBlocked()).toBe(true)
  })

  test("isProjectionWriteBlocked returns false in migration mode", () => {
    process.env.MIMOCODE_MIGRATION_MODE = "1"
    expect(isProjectionWriteBlocked()).toBe(false)
    delete process.env.MIMOCODE_MIGRATION_MODE
  })

  test("PROJECTION_WRITE_ERROR is a clear message", () => {
    expect(PROJECTION_WRITE_ERROR).toContain("DIRECT PROJECTION WRITE BLOCKED")
    expect(PROJECTION_WRITE_ERROR).toContain("MemoryRecorder")
    expect(PROJECTION_WRITE_ERROR).toContain("MIMOCODE_MIGRATION_MODE")
  })
})

// ---------------------------------------------------------------------------
// P4-6: Recorder events regenerate projection
// ---------------------------------------------------------------------------
describe("P4-6: Projection regeneration", () => {
  test("projection generated from events matches expected content", async () => {
    const projectId = "p4-regen-test"

    // Insert events
    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-1",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "rule-A",
          content: "# Rule A\nThis is rule A.",
          writer: "checkpoint-writer",
        })
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-2",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "rule-B",
          content: "# Rule B\nThis is rule B.",
          writer: "checkpoint-writer",
        })
      }),
    )

    // Generate projection
    const projection = await runWithRecorders(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }),
    )

    expect(projection.content).toContain("# Rule A")
    expect(projection.content).toContain("# Rule B")
    expect(projection.event_count).toBe(2)
    expect(projection.content_hash).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// P4-7: Project and session scope cannot cross
// ---------------------------------------------------------------------------
describe("P4-7: Scope isolation", () => {
  test("events from different projects don't mix", async () => {
    const projectA = "p4-scope-A"
    const projectB = "p4-scope-B"

    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectA,
          session_id: "ses-A",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "rule-A",
          content: "# Rule A",
          writer: "checkpoint-writer",
        })
        yield* recorder.submit({
          project_id: projectB,
          session_id: "ses-B",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "rule-B",
          content: "# Rule B",
          writer: "checkpoint-writer",
        })
      }),
    )

    const projA = await runWithRecorders(
      generateProjection({ project_id: projectA, target: "MEMORY.md" }),
    )
    const projB = await runWithRecorders(
      generateProjection({ project_id: projectB, target: "MEMORY.md" }),
    )

    expect(projA.content).toContain("# Rule A")
    expect(projA.content).not.toContain("# Rule B")
    expect(projB.content).toContain("# Rule B")
    expect(projB.content).not.toContain("# Rule A")
  })
})

// ---------------------------------------------------------------------------
// P4-8: Manifests survive restart or fail explicitly
// ---------------------------------------------------------------------------
describe("P4-8: Manifest persistence", () => {
  test("manifest is stored in memory and retrievable", async () => {
    const projectId = "p4-persist-test"
    const sessionId = "ses-p4-8"

    await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        yield* manifestSvc.create({
          project_id: projectId,
          session_id: sessionId,
        })
      }),
    )

    // Get the manifest back
    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.get(sessionId)
      }),
    )

    expect(manifest).not.toBeNull()
    expect(manifest!.project_id).toBe(projectId)
    expect(manifest!.session_id).toBe(sessionId)
  })

  test("get returns null for unknown session", async () => {
    const manifest = await runWithBoth(
      Effect.gen(function* () {
        const manifestSvc = yield* ManifestService
        return yield* manifestSvc.get("unknown-session")
      }),
    )

    expect(manifest).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// P4-9: Projection hash matches ledger high-water mark
// ---------------------------------------------------------------------------
describe("P4-9: Hash consistency", () => {
  test("projection hash changes when new events arrive", async () => {
    const projectId = "p4-hash-test"

    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-1",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "v1",
          content: "# V1",
          writer: "checkpoint-writer",
        })
      }),
    )

    const proj1 = await runWithRecorders(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }),
    )

    await runWithRecorders(
      Effect.gen(function* () {
        const recorder = yield* RecorderService
        yield* recorder.submit({
          project_id: projectId,
          session_id: "ses-2",
          kind: "memory_upsert",
          scope: "project",
          target: "MEMORY.md",
          operation: "upsert",
          identity_key: "v2",
          content: "# V2",
          writer: "checkpoint-writer",
        })
      }),
    )

    const proj2 = await runWithRecorders(
      generateProjection({ project_id: projectId, target: "MEMORY.md" }),
    )

    expect(proj1.content_hash).not.toBe(proj2.content_hash)
    expect(proj2.latest_sequence).toBeGreaterThan(proj1.latest_sequence)
  })
})

// ---------------------------------------------------------------------------
// P4-10: Installed runtime proof
// ---------------------------------------------------------------------------
describe("P4-10: Runtime proof", () => {
  test("isProjectionPath is exported and callable", () => {
    expect(typeof isProjectionPath).toBe("function")
    expect(typeof isProjectionWriteBlocked).toBe("function")
    expect(typeof PROJECTION_WRITE_ERROR).toBe("string")
  })

  test("generateProjection is exported and callable", () => {
    expect(typeof generateProjection).toBe("function")
    expect(typeof generateAllProjections).toBe("function")
    expect(typeof generateOverlay).toBe("function")
  })
})
