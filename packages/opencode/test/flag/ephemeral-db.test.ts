import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs"

// Exercises MIMOCODE_EPHEMERAL against a REAL database init (no mocks) by
// spawning a fresh process with a controlled env + isolated XDG data dir, so
// each case decides the DB path and applies migrations from scratch.
function probe(env: Record<string, string | undefined>) {
  const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-ephemeral-test-"))
  const merged: Record<string, string | undefined> = { ...process.env }
  // Start from a clean slate so the host test env (which sets MIMOCODE_DB=:memory:)
  // does not leak into the case under test.
  delete merged.MIMOCODE_EPHEMERAL
  delete merged.MIMOCODE_DB
  merged.XDG_DATA_HOME = dataHome
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }

  // Open the DB, apply migrations, prove the schema is queryable, and report
  // the resolved path + journal mode. All against the real Database module.
  const script = `
    const { Database } = await import("./src/storage/index.ts")
    const migrations = Database.use((db) =>
      db.$client.query("SELECT count(*) as n FROM __drizzle_migrations").get(),
    )
    const sessions = Database.use((db) =>
      db.$client.query("SELECT count(*) as n FROM session").get(),
    )
    const journal = Database.use((db) => db.$client.query("PRAGMA journal_mode").get())
    process.stdout.write(
      JSON.stringify({
        path: Database.Path,
        migrations: migrations.n,
        sessions: sessions.n,
        journal: Object.values(journal)[0],
      }),
    )
  `
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--conditions=browser", "-e", script],
    cwd: process.cwd(),
    env: merged,
  })
  if (result.exitCode !== 0) {
    throw new Error("probe failed: " + result.stderr.toString())
  }
  const out = JSON.parse(result.stdout.toString()) as {
    path: string
    migrations: number
    sessions: number
    journal: string
  }
  // For an on-disk run the resolved path is an absolute .db file; for :memory:
  // no such file exists. Check the exact resolved path (and its WAL sidecar).
  const onDisk = out.path !== ":memory:"
  const fileExists = onDisk ? fs.existsSync(out.path) : false
  // A :memory: DB must never spill any .db file under the data dir.
  const strayDbFiles = fs.existsSync(dataHome)
    ? fs.readdirSync(dataHome, { recursive: true }).filter((f) => String(f).endsWith(".db"))
    : []
  fs.rmSync(dataHome, { recursive: true, force: true })
  return { ...out, fileExists, strayDbFiles }
}

describe("MIMOCODE_EPHEMERAL", () => {
  test("on: uses in-memory DB, applies schema, writes nothing to disk", () => {
    const r = probe({ MIMOCODE_EPHEMERAL: "1" })
    expect(r.path).toBe(":memory:")
    // Schema is present and queryable: migrations recorded, session table exists.
    expect(r.migrations).toBeGreaterThan(0)
    expect(r.sessions).toBe(0)
    // In-memory DBs cannot use WAL and never spill .db/.wal/.shm files to disk.
    expect(r.journal).toBe("memory")
    expect(r.strayDbFiles).toEqual([])
  })

  test("off: uses on-disk DB with WAL, creating a real .db file", () => {
    const r = probe({})
    expect(r.path).not.toBe(":memory:")
    expect(r.path.endsWith(".db")).toBe(true)
    expect(r.migrations).toBeGreaterThan(0)
    expect(r.sessions).toBe(0)
    expect(r.journal).toBe("wal")
    expect(r.fileExists).toBe(true)
  })

  test("explicit MIMOCODE_DB overrides ephemeral", () => {
    const r = probe({ MIMOCODE_EPHEMERAL: "1", MIMOCODE_DB: "override.db" })
    // Explicit MIMOCODE_DB wins: on-disk override.db, not the flag's :memory:.
    expect(r.path).not.toBe(":memory:")
    expect(r.path.endsWith("override.db")).toBe(true)
    expect(r.fileExists).toBe(true)
  })
})
