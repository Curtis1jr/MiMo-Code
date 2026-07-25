import { Context, Effect, Layer } from "effect"
import { createHash } from "crypto"
import { Database } from "../storage"
import { MemoryEventTable } from "./event.sql"
import { eq, and, desc } from "drizzle-orm"
import { Log } from "../util"
import type { EventRecord } from "./recorder"

const log = Log.create({ service: "memory.manifest" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionManifest {
  readonly manifest_id: string
  readonly project_id: string
  readonly session_id: string
  readonly worker_id: string
  readonly canonical_store_id: string
  readonly ledger_high_water_mark: number
  readonly projection_revision: number
  readonly projection_hash: string
  readonly policy_version: string
  readonly recorder_identity: string
  readonly files_loaded: readonly string[]
  readonly memories_loaded: readonly string[]
  readonly pending_overlay_revision: number
  readonly conflicts: readonly string[]
  readonly unresolved_context: readonly string[]
  readonly created_at: number
  readonly refreshed_at: number
}

export interface ManifestSnapshot {
  readonly manifest: SessionManifest
  readonly events_since_manifest: readonly EventRecord[]
  readonly pending_count: number
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface Interface {
  /** Create a new session manifest at session start. */
  readonly create: (input: {
    project_id: string
    session_id: string
    worker_id?: string
    canonical_store_id?: string
    files_loaded?: string[]
    memories_loaded?: string[]
  }) => Effect.Effect<SessionManifest>

  /** Get the current manifest for a session. */
  readonly get: (session_id: string) => Effect.Effect<SessionManifest | null>

  /** Get events since manifest's high-water mark (pending overlay). */
  readonly getPendingEvents: (manifest: SessionManifest) => Effect.Effect<EventRecord[]>

  /** Get full snapshot: manifest + pending events. */
  readonly getSnapshot: (session_id: string) => Effect.Effect<ManifestSnapshot | null>

  /** Refresh manifest: advance high-water mark, update projection hash. */
  readonly refresh: (session_id: string) => Effect.Effect<SessionManifest>

  /** Serialize manifest for injection into system prompt. */
  readonly serialize: (manifest: SessionManifest) => string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionManifest") {}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

// In-memory manifest store (per-session)
const manifests = new Map<string, SessionManifest>()

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layer: Layer.Layer<Service, never, never> = Layer.effect(
  Service,
  Effect.gen(function* () {
    /** Create a new session manifest */
    const create: Interface["create"] = (input) =>
      Effect.sync(() => {
        const now = Date.now()
        const manifestId = `manifest-${input.session_id}-${now}`

        // Get current project_sequence as high-water mark
        const row = Database.use((db) =>
          db
            .select({ project_sequence: MemoryEventTable.project_sequence })
            .from(MemoryEventTable)
            .where(eq(MemoryEventTable.project_id, input.project_id))
            .orderBy(desc(MemoryEventTable.project_sequence))
            .limit(1)
            .get(),
        )
        const highWaterMark = row?.project_sequence ?? 0

        // Get current projection hash (from latest durable event)
        const latestEvent = Database.use((db) =>
          db
            .select({ content: MemoryEventTable.content })
            .from(MemoryEventTable)
            .where(
              and(
                eq(MemoryEventTable.project_id, input.project_id),
                eq(MemoryEventTable.status, "durable"),
              ),
            )
            .orderBy(desc(MemoryEventTable.project_sequence))
            .limit(1)
            .get(),
        )
        const projectionHash = latestEvent ? contentHash(latestEvent.content) : ""

        const manifest: SessionManifest = {
          manifest_id: manifestId,
          project_id: input.project_id,
          session_id: input.session_id,
          worker_id: input.worker_id ?? "",
          canonical_store_id: input.canonical_store_id ?? "",
          ledger_high_water_mark: highWaterMark,
          projection_revision: 1,
          projection_hash: projectionHash,
          policy_version: "1",
          recorder_identity: "memory-recorder",
          files_loaded: input.files_loaded ?? [],
          memories_loaded: input.memories_loaded ?? [],
          pending_overlay_revision: 0,
          conflicts: [],
          unresolved_context: [],
          created_at: now,
          refreshed_at: now,
        }

        manifests.set(input.session_id, manifest)
        log.info("manifest created", {
          manifest_id: manifestId,
          session_id: input.session_id,
          project_id: input.project_id,
          high_water_mark: highWaterMark,
        })

        return manifest
      })

    /** Get current manifest for a session */
    const get: Interface["get"] = (session_id) =>
      Effect.sync(() => manifests.get(session_id) ?? null)

    /** Get events since manifest's high-water mark */
    const getPendingEvents: Interface["getPendingEvents"] = (manifest) =>
      Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(MemoryEventTable)
            .where(
              and(
                eq(MemoryEventTable.project_id, manifest.project_id),
                eq(MemoryEventTable.status, "durable"),
              ),
            )
            .orderBy(MemoryEventTable.project_sequence)
            .all(),
        ).filter((e: any) => e.project_sequence > manifest.ledger_high_water_mark) as EventRecord[],
      )

    /** Get full snapshot */
    const getSnapshot: Interface["getSnapshot"] = (session_id) =>
      Effect.gen(function* () {
        const manifest = yield* get(session_id)
        if (!manifest) return null

        const pending = yield* getPendingEvents(manifest)
        return {
          manifest,
          events_since_manifest: pending,
          pending_count: pending.length,
        }
      })

    /** Refresh manifest */
    const refresh: Interface["refresh"] = (session_id) =>
      Effect.gen(function* () {
        const current = yield* get(session_id)
        if (!current) {
          return yield* Effect.die(`No manifest for session ${session_id}`)
        }

        const now = Date.now()
        const row = Database.use((db) =>
          db
            .select({ project_sequence: MemoryEventTable.project_sequence })
            .from(MemoryEventTable)
            .where(eq(MemoryEventTable.project_id, current.project_id))
            .orderBy(desc(MemoryEventTable.project_sequence))
            .limit(1)
            .get(),
        )
        const highWaterMark = row?.project_sequence ?? 0

        const latestEvent = Database.use((db) =>
          db
            .select({ content: MemoryEventTable.content })
            .from(MemoryEventTable)
            .where(
              and(
                eq(MemoryEventTable.project_id, current.project_id),
                eq(MemoryEventTable.status, "durable"),
              ),
            )
            .orderBy(desc(MemoryEventTable.project_sequence))
            .limit(1)
            .get(),
        )
        const projectionHash = latestEvent ? contentHash(latestEvent.content) : ""

        const refreshed: SessionManifest = {
          ...current,
          ledger_high_water_mark: highWaterMark,
          projection_revision: current.projection_revision + 1,
          projection_hash: projectionHash,
          refreshed_at: now,
        }

        manifests.set(session_id, refreshed)
        log.info("manifest refreshed", {
          session_id,
          old_mark: current.ledger_high_water_mark,
          new_mark: highWaterMark,
        })

        return refreshed
      })

    /** Serialize manifest for system prompt injection */
    const serialize: Interface["serialize"] = (manifest) =>
      [
        `## Session Memory Manifest`,
        ``,
        `Manifest ID: ${manifest.manifest_id}`,
        `Project: ${manifest.project_id}`,
        `Session: ${manifest.session_id}`,
        `Worker: ${manifest.worker_id || "(none)"}`,
        `Canonical store: ${manifest.canonical_store_id || "(default)"}`,
        `Ledger high-water mark: ${manifest.ledger_high_water_mark}`,
        `Projection revision: ${manifest.projection_revision}`,
        `Projection hash: ${manifest.projection_hash.slice(0, 16)}...`,
        `Policy version: ${manifest.policy_version}`,
        `Recorder: ${manifest.recorder_identity}`,
        `Pending overlay revision: ${manifest.pending_overlay_revision}`,
        `Conflicts: ${manifest.conflicts.length}`,
        `Unresolved context: ${manifest.unresolved_context.length}`,
        `Created at: ${new Date(manifest.created_at).toISOString()}`,
        `Refreshed at: ${new Date(manifest.refreshed_at).toISOString()}`,
        ``,
        `**Memory snapshot is pinned.** To see events added after this manifest, request a refresh.`,
      ].join("\n")

    return Service.of({
      create,
      get,
      getPendingEvents,
      getSnapshot,
      refresh,
      serialize,
    })
  }),
)

export const defaultLayer = Layer.suspend(() => layer)
