import { Context, Effect, Layer } from "effect"
import { randomUUID } from "crypto"
import { Database } from "../storage"
import { MemoryEventTable } from "./event.sql"
import { eq, and, desc, sql } from "drizzle-orm"
import { Log } from "../util"
import { Flock } from "@mimo-ai/shared/util/flock"

const log = Log.create({ service: "memory.recorder" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MutationKind = "memory_upsert" | "memory_delete" | "memory_supersede" | "checkpoint_update" | "spillover_update"
export type MutationScope = "project" | "global" | "session"
export type MutationOperation = "upsert" | "delete" | "supersede" | "replace"
export type MutationWriter =
  | "checkpoint-writer"
  | "agent-edit"
  | "agent-write"
  | "reconciler"
  | "migration"
  | "replay"

export interface MemoryMutation {
  readonly project_id: string
  readonly session_id: string
  readonly kind: MutationKind
  readonly scope: MutationScope
  readonly target: string
  readonly operation: MutationOperation
  readonly identity_key: string
  readonly content: string
  readonly source_turn?: string
  readonly writer: MutationWriter
  readonly base_revision?: string
}

export type EventStatus =
  | "accepted"
  | "durable"
  | "applied"
  | "duplicate"
  | "stale_base"
  | "semantic_conflict"
  | "rejected_policy"
  | "failed"

export interface Receipt {
  readonly event_id: string
  readonly status: EventStatus
  readonly project_sequence: number
  readonly session_sequence: number
  readonly timestamp: number
}

export interface EventRecord {
  readonly event_id: string
  readonly project_id: string
  readonly session_id: string
  readonly session_sequence: number
  readonly project_sequence: number
  readonly timestamp: number
  readonly kind: string
  readonly scope: string
  readonly target: string
  readonly operation: string
  readonly identity_key: string
  readonly content: string
  readonly source_turn: string | null
  readonly writer: string
  readonly base_revision: string | null
  readonly policy_version: string
  readonly status: string
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  /** Submit a mutation. Returns a receipt with event_id and status. */
  readonly submit: (mutation: MemoryMutation) => Effect.Effect<Receipt>

  /** Query events for a project, ordered by project_sequence. */
  readonly query: (input: {
    project_id: string
    target?: string
    since_sequence?: number
    limit?: number
  }) => Effect.Effect<EventRecord[]>

  /** Get the latest project_sequence for a project. */
  readonly latestSequence: (project_id: string) => Effect.Effect<number>

  /** Get a specific event by ID. */
  readonly getEvent: (event_id: string) => Effect.Effect<EventRecord | null>

  /** Health check — is the recorder accepting mutations? */
  readonly health: () => Effect.Effect<{
    queueDepth: number
    queueCapacity: number
    latestProjectSequence: number
    failedEventCount: number
  }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/MemoryRecorder") {}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_TIMEOUT_MS = 30_000
const POLICY_VERSION = "1"
const QUEUE_CAPACITY = 100

const ALLOWED_WRITERS: MutationWriter[] = [
  "checkpoint-writer",
  "agent-edit",
  "agent-write",
  "reconciler",
  "migration",
  "replay",
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return require("crypto").createHash("sha256").update(content).digest("hex")
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Per-project sequence counters (in-memory, rebuilt from DB on startup)
    const projectSequences = new Map<string, number>()
    // Per-session sequence counters
    const sessionSequences = new Map<string, number>()
    // Queue depth tracking
    let queueDepth = 0

    /** Get or initialize project sequence from DB */
    function getProjectSequence(projectId: string): number {
      if (projectSequences.has(projectId)) return projectSequences.get(projectId)!
      const row = Database.use((db) =>
        db
          .select({ project_sequence: MemoryEventTable.project_sequence })
          .from(MemoryEventTable)
          .where(eq(MemoryEventTable.project_id, projectId))
          .orderBy(desc(MemoryEventTable.project_sequence))
          .limit(1)
          .get(),
      )
      const seq = row?.project_sequence ?? 0
      projectSequences.set(projectId, seq)
      return seq
    }

    /** Get or initialize session sequence from DB */
    function getSessionSequence(sessionId: string): number {
      if (sessionSequences.has(sessionId)) return sessionSequences.get(sessionId)!
      const row = Database.use((db) =>
        db
          .select({ session_sequence: MemoryEventTable.session_sequence })
          .from(MemoryEventTable)
          .where(eq(MemoryEventTable.session_id, sessionId))
          .orderBy(desc(MemoryEventTable.session_sequence))
          .limit(1)
          .get(),
      )
      const seq = row?.session_sequence ?? 0
      sessionSequences.set(sessionId, seq)
      return seq
    }

    /** Append event to SQLite ledger */
    function appendEvent(
      event: Omit<MemoryMutation, "base_revision"> & {
        event_id: string
        session_sequence: number
        project_sequence: number
        timestamp: number
        base_revision: string | null
        status: string
      },
    ): void {
      Database.use((db) =>
        db.insert(MemoryEventTable).values(event).run(),
      )
    }

    /** Check for duplicate identity_key */
    function findDuplicate(
      identityKey: string,
      projectId: string,
      target: string,
    ): EventRecord | null {
      return Database.use((db) =>
        db
          .select()
          .from(MemoryEventTable)
          .where(
            and(
              eq(MemoryEventTable.identity_key, identityKey),
              eq(MemoryEventTable.project_id, projectId),
              eq(MemoryEventTable.target, target),
            ),
          )
          .orderBy(desc(MemoryEventTable.project_sequence))
          .limit(1)
          .get(),
      ) as EventRecord | null
    }

    /** Get latest event for a target to check base_revision */
    function getLatestEvent(
      projectId: string,
      target: string,
    ): { content: string } | null {
      return Database.use((db) =>
        db
          .select({ content: MemoryEventTable.content })
          .from(MemoryEventTable)
          .where(
            and(
              eq(MemoryEventTable.project_id, projectId),
              eq(MemoryEventTable.target, target),
            ),
          )
          .orderBy(desc(MemoryEventTable.project_sequence))
          .limit(1)
          .get(),
      ) as { content: string } | null
    }

    // --- Submit ---
    const submit: Interface["submit"] = (mutation) =>
      Effect.gen(function* () {
        const eventId = randomUUID()
        const timestamp = Date.now()

        // Policy check
        if (!ALLOWED_WRITERS.includes(mutation.writer)) {
          log.warn("rejected_policy: unknown writer", { writer: mutation.writer })
          return {
            event_id: eventId,
            status: "rejected_policy" as EventStatus,
            project_sequence: 0,
            session_sequence: 0,
            timestamp,
          }
        }

        // Queue capacity check
        if (queueDepth >= QUEUE_CAPACITY) {
          log.warn("queue full, applying backpressure", { queueDepth, QUEUE_CAPACITY })
          return {
            event_id: eventId,
            status: "rejected_policy" as EventStatus,
            project_sequence: 0,
            session_sequence: 0,
            timestamp,
          }
        }

        queueDepth++

        // Acquire per-project lock for ordering
        const lockKey = `memory-recorder:project:${mutation.project_id}`
        const lock = yield* Effect.tryPromise({
          try: () => Flock.acquire(lockKey, { timeoutMs: LOCK_TIMEOUT_MS }),
          catch: (e) => new Error(`Lock timeout: ${e}`),
        }).pipe(Effect.orDie)

        try {
          // 1. Check duplicate — but allow supersede and delete operations
          // (these are corrections, not duplicates)
          if (mutation.operation !== "supersede" && mutation.operation !== "delete") {
            const existing = findDuplicate(mutation.identity_key, mutation.project_id, mutation.target)
            if (existing) {
              log.info("duplicate event rejected", {
                event_id: existing.event_id,
                identity_key: mutation.identity_key,
              })
              return {
                event_id: existing.event_id,
                status: "duplicate" as EventStatus,
                project_sequence: existing.project_sequence,
                session_sequence: existing.session_sequence,
                timestamp,
              }
            }
          }

          // 2. Check stale base
          if (mutation.base_revision) {
            const latestEvent = getLatestEvent(mutation.project_id, mutation.target)
            if (latestEvent) {
              const currentHash = contentHash(latestEvent.content)
              if (currentHash !== mutation.base_revision) {
                log.warn("stale_base detected", {
                  expected: mutation.base_revision,
                  current: currentHash,
                })
                return {
                  event_id: eventId,
                  status: "stale_base" as EventStatus,
                  project_sequence: getProjectSequence(mutation.project_id),
                  session_sequence: getSessionSequence(mutation.session_id),
                  timestamp,
                }
              }
            }
          }

          // 3. Assign sequences
          const projectSeq = getProjectSequence(mutation.project_id) + 1
          projectSequences.set(mutation.project_id, projectSeq)

          const sessionSeq = getSessionSequence(mutation.session_id) + 1
          sessionSequences.set(mutation.session_id, sessionSeq)

          // 4. Append to ledger (durable in WAL)
          appendEvent({
            ...mutation,
            event_id: eventId,
            session_sequence: sessionSeq,
            project_sequence: projectSeq,
            timestamp,
            base_revision: mutation.base_revision ?? null,
            status: "durable",
          })

          log.info("event persisted", {
            event_id: eventId,
            project_id: mutation.project_id,
            session_id: mutation.session_id,
            project_sequence: projectSeq,
            session_sequence: sessionSeq,
            target: mutation.target,
            operation: mutation.operation,
          })

          return {
            event_id: eventId,
            status: "durable" as EventStatus,
            project_sequence: projectSeq,
            session_sequence: sessionSeq,
            timestamp,
          }
        } finally {
          queueDepth--
          yield* Effect.tryPromise({
            try: () => lock.release(),
            catch: () => undefined,
          }).pipe(Effect.orDie)
        }
      })

    // --- Query ---
    const query: Interface["query"] = (input) =>
      Effect.sync(() => {
        const conditions = [eq(MemoryEventTable.project_id, input.project_id)]
        if (input.target) conditions.push(eq(MemoryEventTable.target, input.target))
        const limit = input.limit ?? 100

        return Database.use((db) =>
          db
            .select()
            .from(MemoryEventTable)
            .where(and(...conditions))
            .orderBy(MemoryEventTable.project_sequence)
            .limit(limit)
            .all(),
        ) as EventRecord[]
      })

    // --- latestSequence ---
    const latestSequence: Interface["latestSequence"] = (projectId) =>
      Effect.sync(() => getProjectSequence(projectId))

    // --- getEvent ---
    const getEvent: Interface["getEvent"] = (eventId) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(MemoryEventTable)
            .where(eq(MemoryEventTable.event_id, eventId))
            .get(),
        ) as EventRecord | null,
      )

    // --- health ---
    const health: Interface["health"] = () =>
      Effect.sync(() => {
        const seq = getProjectSequence("global")
        const failedCount = Database.use((db) =>
          db
            .select({ count: sql<number>`count(*)` })
            .from(MemoryEventTable)
            .where(eq(MemoryEventTable.status, "failed"))
            .get(),
        )?.count ?? 0

        return {
          queueDepth,
          queueCapacity: QUEUE_CAPACITY,
          latestProjectSequence: seq,
          failedEventCount: failedCount,
        }
      })

    log.info("MemoryRecorder initialized")

    return Service.of({
      submit,
      query,
      latestSequence,
      getEvent,
      health,
    })
  }),
)

export const defaultLayer = Layer.suspend(() => layer)
