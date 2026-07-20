import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

/**
 * Canonical append-only event ledger for shared memory mutations.
 *
 * This is the single source of truth. MEMORY.md, checkpoint.md, and spillover
 * files are generated projections — not canonical state.
 *
 * Every mutation enters through MemoryRecorder, which:
 *   1. Validates policy
 *   2. Assigns project_sequence
 *   3. Appends this immutable event
 *   4. Issues accepted + durable receipts
 *
 * Corrections occur through later events — rows are never rewritten.
 */
export const MemoryEventTable = sqliteTable(
  "memory_event",
  {
    // Event identity — UUID-v7, globally unique, time-sortable
    event_id: text().primaryKey(),

    // Project scope — which project's memory this event belongs to
    project_id: text().notNull(),

    // Session scope — which session submitted this event
    session_id: text().notNull(),

    // Ordering — per-session monotonic, per-project monotonic
    session_sequence: integer().notNull(),
    project_sequence: integer().notNull(),

    // Timestamp — ms since epoch, assigned by recorder
    timestamp: integer().notNull(),

    // Event classification
    kind: text().notNull(),
    // "memory_upsert" | "memory_delete" | "memory_supersede" | "checkpoint_update" | "spillover_update"

    scope: text().notNull(),
    // "project" | "global" | "session"

    target: text().notNull(),
    // "MEMORY.md" | "checkpoint.md" | "MEMORY-<topic>.md" | "checkpoint-<topic>.md"

    operation: text().notNull(),
    // "upsert" | "delete" | "supersede" | "replace"

    // Semantic identity — dedup key within scope+target
    identity_key: text().notNull(),

    // The actual content (Markdown body for projections)
    content: text().notNull(),

    // Source trace — where this event came from
    source_turn: text(),
    writer: text().notNull(),
    // "checkpoint-writer" | "agent-edit" | "agent-write" | "reconciler" | "migration" | "replay"

    // Optimistic concurrency — base revision the writer read before deciding to write
    base_revision: text(),

    // Policy
    policy_version: text().notNull().default("1"),

    // Lifecycle status — never rewritten
    status: text().notNull(),
    // "accepted" | "durable" | "applied" | "duplicate" | "stale_base" | "semantic_conflict" | "rejected_policy" | "failed"
  },
  (table) => [
    index("memory_event_project_idx").on(table.project_id, table.project_sequence),
    index("memory_event_session_idx").on(table.session_id, table.session_sequence),
    index("memory_event_identity_idx").on(table.identity_key, table.project_id, table.target),
    index("memory_event_status_idx").on(table.status),
    index("memory_event_timestamp_idx").on(table.timestamp),
  ],
)
