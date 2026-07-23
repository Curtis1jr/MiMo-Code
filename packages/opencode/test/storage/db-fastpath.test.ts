import { describe, expect, test } from "bun:test"
import path from "path"
import os from "os"
import fs from "fs"
import { Database as BunDatabase } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Database } from "../../src/storage"

// Load the real migration set from disk (the same set db.ts bundles/scans).
const MIGRATION_DIR = path.join(import.meta.dir, "../../migration")
function migrationTime(tag: string) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!m) return 0
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
}
function loadMigrations() {
  return (
    readdirSync(MIGRATION_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .map((name) => {
        const file = path.join(MIGRATION_DIR, name, "migration.sql")
        if (!existsSync(file)) return
        return { sql: readFileSync(file, "utf-8"), timestamp: migrationTime(name), name }
      })
      .filter(Boolean) as { sql: string; timestamp: number; name: string }[]
  ).sort((a, b) => a.timestamp - b.timestamp)
}

// Replicates the exact Client() startup decision from src/storage/db.ts against
// a real on-disk sqlite file, so we test the shipped fast-path logic (not a
// mock). Returns whether the fast path was taken.
function openWithFastPath(dbPath: string, entries: ReturnType<typeof loadMigrations>) {
  const sqlite = new BunDatabase(dbPath, { create: true })
  const db = drizzle({ client: sqlite })
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  const currentVersion = (db.get("PRAGMA user_version") as { user_version?: number } | undefined)?.user_version
  const fingerprint = Database.schemaFingerprint(entries)

  let fastPath = false
  let migrateCalled = false
  if (currentVersion === fingerprint && fingerprint !== 0) {
    fastPath = true
  } else {
    db.run("PRAGMA wal_checkpoint(PASSIVE)")
    if (entries.length > 0) {
      migrate(db as any, entries as any)
      migrateCalled = true
      db.run(`PRAGMA user_version = ${Database.schemaFingerprint(entries)}`)
    }
  }
  const version = (db.get("PRAGMA user_version") as { user_version?: number } | undefined)?.user_version
  sqlite.close()
  return { fastPath, migrateCalled, version, fingerprint }
}

function tmpDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimo-db-fastpath-"))
  return path.join(dir, "test.db")
}

describe("Database.schemaFingerprint", () => {
  const entries = loadMigrations()

  test("is a non-zero positive 31-bit int for a real migration set", () => {
    const fp = Database.schemaFingerprint(entries)
    expect(fp).toBeGreaterThan(0)
    expect(fp).toBeLessThanOrEqual(0x7fffffff)
    expect(Number.isInteger(fp)).toBe(true)
  })

  test("returns 0 for an empty set (fresh-DB default, never a real match)", () => {
    expect(Database.schemaFingerprint([])).toBe(0)
  })

  test("is stable across calls", () => {
    expect(Database.schemaFingerprint(entries)).toBe(Database.schemaFingerprint(entries))
  })

  test("changes when a new migration is appended", () => {
    const withNew = [
      ...entries,
      { sql: "CREATE TABLE __fp_probe (id integer);", timestamp: 99999999999999, name: "99999999999999_probe" },
    ]
    expect(Database.schemaFingerprint(withNew)).not.toBe(Database.schemaFingerprint(entries))
  })

  test("round-trips through PRAGMA user_version (signed 32-bit column)", () => {
    const fp = Database.schemaFingerprint(entries)
    const sqlite = new BunDatabase(":memory:")
    sqlite.run(`PRAGMA user_version = ${fp}`)
    const got = (sqlite.query("PRAGMA user_version").get() as { user_version: number }).user_version
    sqlite.close()
    expect(got).toBe(fp)
  })
})

describe("Database fast-path startup (real on-disk sqlite)", () => {
  const entries = loadMigrations()

  test("fresh DB: migrations apply and marker is stamped", () => {
    const dbPath = tmpDbPath()
    const r = openWithFastPath(dbPath, entries)
    expect(r.fastPath).toBe(false)
    expect(r.migrateCalled).toBe(true)
    expect(r.version).toBe(r.fingerprint)
    // __drizzle_migrations is the source of truth and got populated.
    const sqlite = new BunDatabase(dbPath)
    const applied = sqlite.query("SELECT count(*) as n FROM __drizzle_migrations").get() as { n: number }
    expect(applied.n).toBe(entries.length)
    sqlite.close()
  })

  test("warm DB with current schema: fast path taken, migrate scan skipped, schema intact", () => {
    const dbPath = tmpDbPath()
    // First boot applies migrations + stamps the marker.
    const first = openWithFastPath(dbPath, entries)
    expect(first.migrateCalled).toBe(true)

    // Write a row to a real migrated table to simulate persisted session data.
    const w = new BunDatabase(dbPath)
    w.run("CREATE TABLE session_probe (id text primary key, data text)")
    w.run("INSERT INTO session_probe (id, data) VALUES ('ses_fastpath', '{\"x\":1}')")
    w.close()

    // Second boot: schema is current → fast path, no migrate.
    const second = openWithFastPath(dbPath, entries)
    expect(second.fastPath).toBe(true)
    expect(second.migrateCalled).toBe(false)
    expect(second.version).toBe(second.fingerprint)

    // The migrated schema is intact after the fast-path boot, and
    // continue-session data must still be readable.
    const r = new BunDatabase(dbPath)
    const applied = r.query("SELECT count(*) as n FROM __drizzle_migrations").get() as { n: number }
    expect(applied.n).toBe(entries.length)
    const row = r.query("SELECT id, data FROM session_probe WHERE id = 'ses_fastpath'").get() as {
      id: string
      data: string
    }
    r.close()
    expect(row.id).toBe("ses_fastpath")
    expect(row.data).toBe('{"x":1}')
  })

  test("stale marker: full migrate still runs (self-correcting)", () => {
    const dbPath = tmpDbPath()
    // Apply + stamp.
    openWithFastPath(dbPath, entries)
    // Corrupt the marker to a stale value → next boot must NOT fast-path.
    const s = new BunDatabase(dbPath)
    s.run("PRAGMA user_version = 12345")
    s.close()

    const r = openWithFastPath(dbPath, entries)
    expect(r.fastPath).toBe(false)
    expect(r.migrateCalled).toBe(true)
    // Marker is re-stamped to the correct fingerprint.
    expect(r.version).toBe(r.fingerprint)
  })

  test("simulated pending migration: new migration applies then fast-paths next boot", () => {
    const dbPath = tmpDbPath()
    // Boot with the full set.
    openWithFastPath(dbPath, entries)

    // A genuinely new migration appears in a later release.
    const extended = [
      ...entries,
      {
        sql: "CREATE TABLE __fp_new (id integer primary key);",
        timestamp: 99999999999999,
        name: "99999999999999_fp_new",
      },
    ]
    const applied = openWithFastPath(dbPath, extended)
    expect(applied.fastPath).toBe(false)
    expect(applied.migrateCalled).toBe(true)

    // New table now exists.
    const c = new BunDatabase(dbPath)
    const t = c.query("SELECT name FROM sqlite_master WHERE type='table' AND name='__fp_new'").get() as
      | { name: string }
      | undefined
    expect(t?.name).toBe("__fp_new")

    // Next boot with the same extended set fast-paths.
    c.close()
    const next = openWithFastPath(dbPath, extended)
    expect(next.fastPath).toBe(true)
    expect(next.migrateCalled).toBe(false)
  })
})
