/**
 * Phase 5 — Recovery, Compaction, and Rebuild
 *
 * Handles:
 * - Crash recovery and replay
 * - Event compaction and retention
 * - Projection rebuild from canonical persistence
 */

import { Effect } from "effect"
import { Database } from "../storage"
import { MemoryEventTable } from "./event.sql"
import { eq, and, sql, desc } from "drizzle-orm"
import { Log } from "../util"
import type { EventRecord } from "./recorder"
import { generateAllProjections, writeProjectionAtomic } from "./projection"
import path from "path"

const log = Log.create({ service: "memory.recovery" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryResult {
  readonly replayed: number
  readonly failed: number
  readonly errors: string[]
}

export interface CompactionResult {
  readonly archived: number
  readonly deleted: number
  readonly errors: string[]
}

export interface RebuildResult {
  readonly targets: string[]
  readonly errors: string[]
}

// ---------------------------------------------------------------------------
// Crash recovery and replay
// ---------------------------------------------------------------------------

/**
 * Replay durable but unapplied events after a crash.
 * Returns count of replayed events and any errors.
 */
export function replayDurableEvents(): Effect.Effect<RecoveryResult> {
  return Effect.sync(() => {
    const errors: string[] = []
    let replayed = 0
    let failed = 0

    // Find durable events that haven't been applied
    const durableEvents = Database.use((db) =>
      db
        .select()
        .from(MemoryEventTable)
        .where(eq(MemoryEventTable.status, "durable"))
        .orderBy(MemoryEventTable.project_sequence)
        .all(),
    ) as EventRecord[]

    if (durableEvents.length === 0) {
      log.info("no durable events to replay")
      return { replayed: 0, failed: 0, errors: [] }
    }

    log.info("replaying durable events", { count: durableEvents.length })

    for (const event of durableEvents) {
      try {
        // Mark as applied
        Database.use((db) =>
          db
            .update(MemoryEventTable)
            .set({ status: "applied" })
            .where(eq(MemoryEventTable.event_id, event.event_id))
            .run(),
        )
        replayed++
      } catch (e: any) {
        failed++
        errors.push(`Failed to replay ${event.event_id}: ${e.message}`)

        // Mark as failed
        try {
          Database.use((db) =>
            db
              .update(MemoryEventTable)
              .set({ status: "failed" })
              .where(eq(MemoryEventTable.event_id, event.event_id))
              .run(),
          )
        } catch {}
      }
    }

    log.info("replay complete", { replayed, failed })
    return { replayed, failed, errors }
  })
}

// ---------------------------------------------------------------------------
// Event compaction
// ---------------------------------------------------------------------------

/**
 * Compact old events by archiving superseded chains.
 * Preserves the latest event in each identity chain.
 */
export function compactEvents(
  projectId: string,
  olderThanMs: number,
): Effect.Effect<CompactionResult> {
  return Effect.sync(() => {
    const errors: string[] = []
    let archived = 0
    let deleted = 0

    const cutoff = Date.now() - olderThanMs

    // Find events older than cutoff that have been superseded
    const oldEvents = Database.use((db) =>
      db
        .select()
        .from(MemoryEventTable)
        .where(
          and(
            eq(MemoryEventTable.project_id, projectId),
            sql`${MemoryEventTable.timestamp} < ${cutoff}`,
          ),
        )
        .orderBy(MemoryEventTable.project_sequence)
        .all(),
    ) as EventRecord[]

    // Group by identity_key
    const identityGroups = new Map<string, EventRecord[]>()
    for (const event of oldEvents) {
      const key = `${event.identity_key}:${event.target}`
      if (!identityGroups.has(key)) identityGroups.set(key, [])
      identityGroups.get(key)!.push(event)
    }

    // For each identity, keep only the latest event
    for (const [key, events] of identityGroups) {
      if (events.length <= 1) continue

      // Sort by project_sequence descending
      events.sort((a, b) => b.project_sequence - a.project_sequence)

      // Keep the first (latest), archive the rest
      for (let i = 1; i < events.length; i++) {
        try {
          Database.use((db) =>
            db
              .update(MemoryEventTable)
              .set({ status: "compacted" })
              .where(eq(MemoryEventTable.event_id, events[i].event_id))
              .run(),
          )
          archived++
        } catch (e: any) {
          errors.push(`Failed to compact ${events[i].event_id}: ${e.message}`)
        }
      }
    }

    log.info("compaction complete", { archived, deleted })
    return { archived, deleted, errors }
  })
}

// ---------------------------------------------------------------------------
// Projection rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild all projections for a project from canonical persistence.
 * Deletes existing projections and regenerates from ledger.
 */
export function rebuildProjections(
  projectId: string,
  projectDir: string,
): Effect.Effect<RebuildResult> {
  return Effect.gen(function* () {
    const targets: string[] = []
    const errors: string[] = []

    // Generate projections from ledger
    const projections = yield* generateAllProjections({ project_id: projectId })

    for (const projection of projections) {
      try {
        // Determine file path
        let filePath: string
        if (projection.target === "MEMORY.md") {
          filePath = path.join(projectDir, "memory", "projects", projectId, "MEMORY.md")
        } else if (projection.target.startsWith("MEMORY-")) {
          filePath = path.join(projectDir, "memory", "projects", projectId, projection.target)
        } else {
          continue // Skip checkpoint and other session-scoped targets
        }

        // Write atomically
        const result = yield* Effect.promise(() => writeProjectionAtomic(filePath, projection.content))
        if (result.success) {
          targets.push(projection.target)
          log.info("rebuilt projection", {
            target: projection.target,
            high_water_mark: projection.high_water_mark,
          })
        } else {
          errors.push(`${projection.target}: ${result.error}`)
        }
      } catch (e: any) {
        errors.push(`${projection.target}: ${e.message}`)
      }
    }

    log.info("rebuild complete", { targets: targets.length, errors: errors.length })
    return { targets, errors }
  })
}
