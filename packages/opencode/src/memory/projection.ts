import { Effect } from "effect"
import path from "path"
import { createHash } from "crypto"
import { Database } from "../storage"
import { MemoryEventTable } from "./event.sql"
import { eq, and, desc } from "drizzle-orm"
import { Log } from "../util"
import type { EventRecord } from "./recorder"

const log = Log.create({ service: "memory.projection" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Projection {
  readonly target: string
  readonly content: string
  readonly content_hash: string
  readonly event_count: number
  readonly latest_sequence: number
  readonly generated_at: number
  readonly high_water_mark: number
  readonly projection_revision: number
  readonly policy_version: string
  readonly recorder_identity: string
}

// ---------------------------------------------------------------------------
// Projection generator
// ---------------------------------------------------------------------------

/**
 * Generate a projection for a specific target from ledger events.
 *
 * This is the canonical way to produce MEMORY.md, checkpoint.md, and spillover
 * files. The projection is deterministic — same events always produce the same
 * output.
 */
export function generateProjection(input: {
  project_id: string
  target: string
}): Effect.Effect<Projection> {
  return Effect.sync(() => {
    const { project_id, target } = input

    const events = Database.use((db) =>
      db
        .select()
        .from(MemoryEventTable)
        .where(
          and(
            eq(MemoryEventTable.project_id, project_id),
            eq(MemoryEventTable.target, target),
            eq(MemoryEventTable.status, "durable"),
          ),
        )
        .orderBy(MemoryEventTable.project_sequence)
        .all(),
    ) as EventRecord[]

    if (events.length === 0) {
      return {
        target,
        content: "",
        content_hash: "",
        event_count: 0,
        latest_sequence: 0,
        generated_at: Date.now(),
        high_water_mark: 0,
        projection_revision: 1,
        policy_version: "1",
        recorder_identity: "memory-recorder",
      }
    }

    // Build projection by replaying events in sequence order
    const identities = new Map<string, { event: EventRecord; sequence: number }>()

    for (const event of events) {
      if (event.operation === "delete") {
        identities.delete(event.identity_key)
        continue
      }

      if (event.operation === "supersede") {
        identities.set(event.identity_key, { event, sequence: event.project_sequence })
        continue
      }

      // Regular upsert
      identities.set(event.identity_key, { event, sequence: event.project_sequence })
    }

    // Generate content from resolved identities
    const lines: string[] = []
    let latestSequence = 0

    for (const [, { event, sequence }] of identities) {
      lines.push(event.content)
      lines.push("")
      if (sequence > latestSequence) latestSequence = sequence
    }

    const content = lines.join("\n").trim()
    const contentHash = createHash("sha256").update(content).digest("hex")

    return {
      target,
      content,
      content_hash: contentHash,
      event_count: events.length,
      latest_sequence: latestSequence,
      generated_at: Date.now(),
      high_water_mark: latestSequence,
      projection_revision: 1,
      policy_version: "1",
      recorder_identity: "memory-recorder",
    }
  })
}

/**
 * Generate all projections for a project.
 */
export function generateAllProjections(input: {
  project_id: string
}): Effect.Effect<Projection[]> {
  return Effect.gen(function* () {
    const { project_id } = input

    const targets = Database.use((db) =>
      db
        .select({ target: MemoryEventTable.target })
        .from(MemoryEventTable)
        .where(
          and(
            eq(MemoryEventTable.project_id, project_id),
            eq(MemoryEventTable.status, "durable"),
          ),
        )
        .all(),
    )

    const uniqueTargets = [...new Set(targets.map((t: any) => t.target))]

    const results: Projection[] = []
    for (const target of uniqueTargets) {
      const projection = yield* generateProjection({ project_id, target })
      results.push(projection)
    }

    return results
  })
}

/**
 * Generate a pending-event overlay for events not yet in projections.
 */
export function generateOverlay(input: {
  project_id: string
  high_water_mark: number
}): Effect.Effect<EventRecord[]> {
  return Effect.sync(() =>
    Database.use((db) =>
      db
        .select()
        .from(MemoryEventTable)
        .where(
          and(
            eq(MemoryEventTable.project_id, input.project_id),
            eq(MemoryEventTable.status, "durable"),
          ),
        )
        .orderBy(MemoryEventTable.project_sequence)
        .all(),
    ).filter((e: any) => e.project_sequence > input.high_water_mark) as EventRecord[],
  )
}

/**
 * Atomic projection write: tmp → fsync → rename → parent dir fsync.
 * Preserves previous projection if write fails.
 */
export async function writeProjectionAtomic(
  filePath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  const fs = await import("fs/promises")

  const tmpPath = filePath + ".tmp." + Date.now()
  const parentDir = path.dirname(filePath)

  try {
    // Write to temp file
    const handle = await fs.open(tmpPath, "w")
    await handle.write(content)
    await handle.datasync()
    await handle.close()

    // Rename atomically
    await fs.rename(tmpPath, filePath)

    // Sync parent directory
    const parentHandle = await fs.open(parentDir, "r")
    await parentHandle.sync()
    await parentHandle.close()

    return { success: true }
  } catch (e: any) {
    // Clean up temp file on failure
    try { await fs.unlink(tmpPath) } catch {}
    return { success: false, error: e.message }
  }
}

/**
 * Materialize all projections for a project to disk.
 * Called after durable events are persisted.
 */
export async function materializeProjections(
  projectId: string,
  projectDir: string,
): Promise<{ targets: string[]; errors: string[] }> {
  const targets: string[] = []
  const errors: string[] = []

  try {
    const projections = await Effect.runPromise(
      generateAllProjections({ project_id: projectId }) as Effect.Effect<any[], never, never>,
    )

    for (const projection of projections) {
      try {
        // Determine file path based on target
        let filePath: string
        if (projection.target === "MEMORY.md") {
          filePath = path.join(projectDir, "memory", "projects", projectId, "MEMORY.md")
        } else if (projection.target === "checkpoint.md") {
          // Checkpoint is session-scoped, skip for project-level materialization
          continue
        } else if (projection.target.startsWith("MEMORY-")) {
          filePath = path.join(projectDir, "memory", "projects", projectId, projection.target)
        } else {
          // Unknown target, skip
          continue
        }

        // Ensure directory exists
        const fsPromises = await import("fs/promises")
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true })

        // Write atomically
        const result = await writeProjectionAtomic(filePath, projection.content)
        if (result.success) {
          targets.push(projection.target)
          log.info("projection materialized", {
            target: projection.target,
            high_water_mark: projection.high_water_mark,
            content_hash: projection.content_hash.slice(0, 16),
          })
        } else {
          errors.push(`${projection.target}: ${result.error}`)
        }
      } catch (e: any) {
        errors.push(`${projection.target}: ${e.message}`)
      }
    }
  } catch (e: any) {
    errors.push(`materialization failed: ${e.message}`)
  }

  return { targets, errors }
}
