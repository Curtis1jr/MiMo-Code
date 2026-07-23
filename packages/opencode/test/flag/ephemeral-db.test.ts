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
    // Ephemeral resolves to a named shared-cache in-memory URI (NOT bare
    // ":memory:", which would be private per connection) so every connection in
    // the process shares one in-memory DB. See the same-DB test below.
    expect(r.path).toBe("file:mimocode-ephemeral?mode=memory&cache=shared")
    // Schema is present and queryable: migrations recorded, session table exists.
    expect(r.migrations).toBeGreaterThan(0)
    expect(r.sessions).toBe(0)
    // The load-bearing invariant for an in-memory DB is that it never uses WAL
    // (WAL requires a real file and would spill .wal/.shm sidecars). The exact
    // journal_mode string for a "mode=memory" URI is platform/driver dependent
    // — bun:sqlite reports "memory" on macOS but "delete" on Linux — and both
    // are fine because a memory DB writes nothing to disk regardless. So assert
    // WAL is off and (below) that no files spill, not a specific mode string.
    expect(r.journal).not.toBe("wal")
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

  // THE core guarantee: within one process, ALL database access hits the SAME
  // in-memory database. We prove it by writing a row through the app's DB layer
  // (Database.use → the lazy() singleton connection) and then reading it back
  // through a SECOND, independently opened connection to the same resolved
  // Database.Path in the SAME process. With a bare ":memory:" DB that second
  // connection would be a brand-new EMPTY database and see 0 rows; with the
  // shared-cache URI it sees the row, proving one shared DB.
  test("same process: a second connection sees data written via the app DB", () => {
    const dataHome = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-ephemeral-shared-"))
    const merged: Record<string, string | undefined> = { ...process.env }
    delete merged.MIMOCODE_DB
    merged.XDG_DATA_HOME = dataHome
    merged.MIMOCODE_EPHEMERAL = "1"

    const script = `
      const { Database } = await import("./src/storage/index.ts")
      const { Database: BunDatabase } = await import("bun:sqlite")

      // Touch the app DB first so the lazy() singleton opens the (shared-cache)
      // connection and applies migrations, then write through that SAME
      // connection. A dedicated table keeps this independent of app schema.
      const marker = "shared_marker_" + Date.now()
      Database.use((db) => {
        db.$client.run("CREATE TABLE shared_probe (v TEXT)")
        db.$client.run("INSERT INTO shared_probe (v) VALUES (?)", [marker])
      })

      // Open a SECOND, independent connection to the SAME resolved path and read
      // it back. For bare ":memory:" this is a different EMPTY database and the
      // table would not even exist; for the shared-cache URI it is the SAME DB.
      const second = new BunDatabase(Database.Path)
      let viaSecond = -1
      try {
        viaSecond = second.query("SELECT count(*) AS n FROM shared_probe WHERE v = ?").get(marker).n
      } catch (e) {
        viaSecond = -1 // table missing => a separate, empty in-memory DB
      }
      second.close()

      const viaApp = Database.use((db) =>
        db.$client.query("SELECT count(*) AS n FROM shared_probe WHERE v = ?").get(marker).n,
      )

      process.stdout.write(JSON.stringify({ path: Database.Path, viaSecond, viaApp }))
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--conditions=browser", "-e", script],
      cwd: process.cwd(),
      env: merged,
    })
    fs.rmSync(dataHome, { recursive: true, force: true })
    if (result.exitCode !== 0) {
      throw new Error("shared-db probe failed: " + result.stderr.toString())
    }
    const out = JSON.parse(result.stdout.toString()) as { path: string; viaSecond: number; viaApp: number }

    expect(out.path).toBe("file:mimocode-ephemeral?mode=memory&cache=shared")
    // The app-layer singleton obviously sees its own write.
    expect(out.viaApp).toBe(1)
    // The independent second connection sees the SAME row => one shared DB.
    // (Would be 0 for a bare ":memory:" private-per-connection database.)
    expect(out.viaSecond).toBe(1)
  })
})
