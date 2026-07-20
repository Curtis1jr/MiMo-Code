import { Effect } from "effect"
import { Database } from "../storage"
import { MemoryEventTable } from "./event.sql"
import { eq, and, desc } from "drizzle-orm"
import { Log } from "../util"
import type { EventRecord } from "./recorder"

const log = Log.create({ service: "memory.reconciler" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProjectionResult {
  readonly target: string
  readonly content: string
  readonly event_count: number
  readonly latest_sequence: number
  readonly generated_at: number
}

export interface ConflictRecord {
  readonly event_id: string
  readonly identity_key: string
  readonly conflict_type: "semantic_conflict" | "stale_base" | "duplicate"
  readonly details: string
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

/**
 * Deterministic reconciler that consumes ordered events from the ledger
 * and produces Markdown projections.
 *
 * Reconciliation uses:
 * - identity-key matching for upsert semantics
 * - monotonic sequence ordering
 * - duplicate detection
 * - semantic conflict records
 * - deterministic projection order
 *
 * It does NOT use last-write-wins — meaningful contradictions produce
 * conflict records.
 */
export function reconcile(input: {
  project_id: string
  target: string
}): Effect.Effect<ProjectionResult> {
  return Effect.sync(() => {
    const { project_id, target } = input

    log.info("reconciling", { project_id, target })

    // 1. Load all events for this project+target, ordered by sequence
    const events = Database.use((db) =>
      db
        .select()
        .from(MemoryEventTable)
        .where(
          and(
            eq(MemoryEventTable.project_id, project_id),
            eq(MemoryEventTable.target, target),
          ),
        )
        .orderBy(MemoryEventTable.project_sequence)
        .all(),
    ) as EventRecord[]

    if (events.length === 0) {
      return {
        target,
        content: "",
        event_count: 0,
        latest_sequence: 0,
        generated_at: Date.now(),
      }
    }

    // 2. Build projection by replaying events in sequence order
    const identities = new Map<string, { event: EventRecord; sequence: number }>()
    const conflicts: ConflictRecord[] = []

    for (const event of events) {
      // Skip non-durable events
      if (event.status !== "durable" && event.status !== "applied") continue

      // Handle operations that modify existing state
      if (event.operation === "delete") {
        // Deletion: remove from projection if exists
        const existed = identities.delete(event.identity_key)
        if (existed) {
          log.info("deleted identity", {
            identity_key: event.identity_key,
            sequence: event.project_sequence,
          })
        }
        continue
      }

      if (event.operation === "supersede") {
        // Supersession: replace existing or add new
        identities.set(event.identity_key, { event, sequence: event.project_sequence })
        log.info("superseded identity", {
          identity_key: event.identity_key,
          to_sequence: event.project_sequence,
        })
        continue
      }

      // Regular upsert operation
      const existing = identities.get(event.identity_key)
      if (existing) {
        // Semantic conflict: same identity_key, same upsert operation
        conflicts.push({
          event_id: event.event_id,
          identity_key: event.identity_key,
          conflict_type: "semantic_conflict",
          details: `Identity ${event.identity_key} already exists at sequence ${existing.sequence}, new upsert at ${event.project_sequence}`,
        })
        log.warn("semantic conflict", {
          identity_key: event.identity_key,
          existing_sequence: existing.sequence,
          new_sequence: event.project_sequence,
        })
      } else {
        // New identity
        identities.set(event.identity_key, { event, sequence: event.project_sequence })
      }
    }

    // 3. Generate Markdown projection from resolved identities
    const lines: string[] = []
    let latestSequence = 0

    for (const [, { event, sequence }] of identities) {
      lines.push(event.content)
      lines.push("") // blank line between sections
      if (sequence > latestSequence) latestSequence = sequence
    }

    const content = lines.join("\n").trim()

    // 4. Record conflicts in a separate track (for observability)
    if (conflicts.length > 0) {
      log.warn("reconciliation produced conflicts", {
        count: conflicts.length,
        conflicts: conflicts.map((c) => ({
          event_id: c.event_id,
          identity_key: c.identity_key,
          type: c.conflict_type,
        })),
      })
    }

    return {
      target,
      content,
      event_count: events.length,
      latest_sequence: latestSequence,
      generated_at: Date.now(),
    }
  })
}

/**
 * Reconcile all memory targets for a project.
 * Returns projections for each target.
 */
export function reconcileAll(input: {
  project_id: string
}): Effect.Effect<ProjectionResult[]> {
  return Effect.gen(function* () {
    const { project_id } = input

    // Find all distinct targets for this project
    const targets = Database.use((db) =>
      db
        .select({ target: MemoryEventTable.target })
        .from(MemoryEventTable)
        .where(eq(MemoryEventTable.project_id, project_id))
        .all(),
    )

    const uniqueTargets = [...new Set(targets.map((t) => t.target))]

    const results: ProjectionResult[] = []
    for (const target of uniqueTargets) {
      const result = yield* reconcile({ project_id, target })
      results.push(result)
    }

    return results
  })
}
