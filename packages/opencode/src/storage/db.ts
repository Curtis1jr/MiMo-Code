import { type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { LocalContext } from "../util"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util"
import { NamedError } from "@mimo-ai/shared/util/error"
import z from "zod"
import path from "path"
import { readFileSync, readdirSync, existsSync } from "fs"
import { Flag } from "../flag/flag"
import { InstallationChannel } from "../installation/version"
import { InstanceState } from "@/effect"
import { iife } from "@/util/iife"
import { init } from "#db"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })

export function getChannelPath() {
  if (["latest", "beta", "prod"].includes(InstallationChannel) || Flag.MIMOCODE_DISABLE_CHANNEL_DB)
    return path.join(Global.Path.data, "mimocode.db")
  const safe = InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")
  return path.join(Global.Path.data, `mimocode-${safe}.db`)
}

export const Path = iife(() => {
  if (Flag.MIMOCODE_DB) {
    if (Flag.MIMOCODE_DB === ":memory:" || path.isAbsolute(Flag.MIMOCODE_DB)) return Flag.MIMOCODE_DB
    return path.join(Global.Path.data, Flag.MIMOCODE_DB)
  }
  return getChannelPath()
})

export type Transaction = SQLiteTransaction<"sync", void>

type Client = SQLiteBunDatabase

type Journal = { sql: string; timestamp: number; name: string }[]

function time(tag: string) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(tag)
  if (!match) return 0
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )
}

function migrations(dir: string): Journal {
  const dirs = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  const sql = dirs
    .map((name) => {
      const file = path.join(dir, name, "migration.sql")
      if (!existsSync(file)) return
      return {
        sql: readFileSync(file, "utf-8"),
        timestamp: time(name),
        name,
      }
    })
    .filter(Boolean) as Journal

  return sql.sort((a, b) => a.timestamp - b.timestamp)
}

// A compact, 32-bit-signed fingerprint of the fully-applied migration set,
// stored in `PRAGMA user_version` as a cheap "schema is current" marker.
//
// We cannot store the latest migration's folderMillis directly (it exceeds a
// 32-bit int), so we fold the migration count + the latest migration's
// timestamp and name into a stable FNV-1a hash. When this matches the DB's
// user_version we know the on-disk schema already reflects every bundled
// migration, so we can skip the (redundant) migrate() scan + startup WAL
// checkpoint entirely. The value 0 (the default for a fresh DB) can never
// collide with a real fingerprint, so a fresh DB always takes the full path.
export function schemaFingerprint(entries: Journal): number {
  if (entries.length === 0) return 0
  const latest = entries[entries.length - 1]!
  const key = `${entries.length}:${latest.timestamp}:${latest.name}`
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // Fold to a non-zero positive 31-bit int so it round-trips through
  // PRAGMA user_version (a signed 32-bit column) without sign ambiguity and
  // never equals the fresh-DB default of 0.
  const folded = (hash >>> 1) & 0x7fffffff
  return folded === 0 ? 1 : folded
}

export const Client = lazy(() => {
  log.info("opening database", { path: Path })

  const db = init(Path)

  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA synchronous = NORMAL")
  db.run("PRAGMA busy_timeout = 5000")
  db.run("PRAGMA cache_size = -64000")
  db.run("PRAGMA foreign_keys = ON")

  // In a production build OPENCODE_MIGRATIONS is inlined as JSON (no dir scan);
  // in dev we scan the migration/ folder, but only on the slow path below.
  const bundled = typeof OPENCODE_MIGRATIONS !== "undefined" ? OPENCODE_MIGRATIONS : undefined

  // Fast path: if the DB's user_version already matches the fingerprint of the
  // fully-applied migration set, the schema is current. Skip migrate() (which,
  // even though drizzle already skips applied migrations, still parses the
  // whole set + emits a misleading "applying migrations" log every boot) AND
  // skip the synchronous startup WAL checkpoint — the single most expensive
  // phase (~13-21ms on a large DB) and redundant with wal_autocheckpoint. This
  // is self-correcting: a stale/zero marker falls through to the full path.
  const currentVersion = (db.get("PRAGMA user_version") as { user_version?: number } | undefined)?.user_version
  const bundledFingerprint = bundled ? schemaFingerprint(bundled) : undefined
  if (!Flag.MIMOCODE_SKIP_MIGRATIONS && bundledFingerprint !== undefined && currentVersion === bundledFingerprint) {
    log.info("schema current, fast-path startup", { version: currentVersion })
    return db
  }

  // Slow path: schema may be stale (fresh DB, real pending migration, or dev
  // run). Checkpoint the WAL, run the full migrate scan, then stamp the marker.
  db.run("PRAGMA wal_checkpoint(PASSIVE)")

  const entries = bundled ?? migrations(path.join(import.meta.dirname, "../../migration"))
  if (entries.length > 0) {
    log.info("applying migrations", {
      count: entries.length,
      mode: bundled ? "bundled" : "dev",
    })
    if (Flag.MIMOCODE_SKIP_MIGRATIONS) {
      for (const item of entries) {
        item.sql = "select 1;"
      }
      migrate(db, entries)
    } else {
      migrate(db, entries)
      // Stamp the marker so the next boot takes the fast path.
      db.run(`PRAGMA user_version = ${schemaFingerprint(entries)}`)
    }
  }

  return db
})

export function close() {
  Client().$client.close()
  Client.reset()
}

export type TxOrDb = Transaction | Client

const ctx = LocalContext.create<{
  tx: TxOrDb
  effects: (() => void | Promise<void>)[]
}>("database")

export function use<T>(callback: (trx: TxOrDb) => T): T {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
      for (const effect of effects) effect()
      return result
    }
    throw err
  }
}

export function effect(fn: () => any | Promise<any>) {
  const bound = InstanceState.bind(fn)
  try {
    ctx.use().effects.push(bound)
  } catch {
    bound()
  }
}

type NotPromise<T> = T extends Promise<any> ? never : T

export function transaction<T>(
  callback: (tx: TxOrDb) => NotPromise<T>,
  options?: {
    behavior?: "deferred" | "immediate" | "exclusive"
  },
): NotPromise<T> {
  try {
    return callback(ctx.use().tx)
  } catch (err) {
    if (err instanceof LocalContext.NotFound) {
      const effects: (() => void | Promise<void>)[] = []
      const txCallback = InstanceState.bind((tx: TxOrDb) => ctx.provide({ tx, effects }, () => callback(tx)))
      const result = Client().transaction(txCallback, { behavior: options?.behavior })
      for (const effect of effects) effect()
      return result as NotPromise<T>
    }
    throw err
  }
}
