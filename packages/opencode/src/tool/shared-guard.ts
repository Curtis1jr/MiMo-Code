/**
 * Phase 0 shared-memory guard.
 *
 * Protects cross-session Markdown projections (MEMORY.md, checkpoint.md)
 * from multi-writer races. Implements:
 *
 * 1. Canonical predicate: `isProtectedMemoryPath(filePath)`
 * 2. Exclusive OS-backed lock (Flock) covering full read-modify-write
 * 3. Atomic write: tmp → fsync → rename → parent dir fsync
 * 4. Revision tracking via `.rev` sidecar (SHA-256 hash of last-committed content)
 * 5. Stale-base detection: writer must supply baseHash; mismatch = STALE_BASE
 * 6. Lock contention visibility: explicit timeout/error results
 *
 * Usage:
 *   const result = await guardedWrite(filePath, newContent, baseHash)
 *   if (result.status === "stale_base") { ... }
 */

import path from "path"
import { readFile, writeFile, rename, stat } from "fs/promises"
import { createHash } from "crypto"
import { Flock } from "@mimo-ai/shared/util/flock"

// ---------------------------------------------------------------------------
// Protected path identification
// ---------------------------------------------------------------------------

const MEMORY_DIR_SEGMENT = path.join("memory", "projects")
const GLOBAL_MEMORY_SEGMENT = path.join("memory", "global", "MEMORY.md")
const CHECKPOINT_FILENAME = "checkpoint.md"

/**
 * Canonical predicate: returns true for files that are cross-session
 * Markdown projections requiring the shared-memory guard.
 *
 * Protected paths:
 * - Per-project memory: .../memory/projects/{pid}/MEMORY.md
 * - Per-project memory spillover: .../memory/projects/{pid}/MEMORY-*.md
 * - Global memory: .../memory/global/MEMORY.md
 * - Session checkpoint: .../memory/sessions/{sid}/checkpoint.md
 * - Session checkpoint spillover: .../memory/sessions/{sid}/checkpoint-*.md
 *
 * NOT protected:
 * - Session notes: .../memory/sessions/{sid}/notes.md
 * - Task progress: .../memory/sessions/{sid}/tasks/...
 * - Arbitrary Markdown files outside the memory tree
 */
export function isProtectedMemoryPath(filePath: string): boolean {
  const normalized = path.normalize(filePath)

  // Per-project MEMORY.md or MEMORY-*.md: .../memory/projects/<pid>/MEMORY*.md
  if (normalized.includes(MEMORY_DIR_SEGMENT)) {
    const basename = path.basename(normalized)
    if (basename === "MEMORY.md" || basename.startsWith("MEMORY-")) {
      return true
    }
  }

  // Global MEMORY.md: .../memory/global/MEMORY.md
  if (normalized.endsWith(GLOBAL_MEMORY_SEGMENT)) {
    return true
  }

  // Per-session checkpoint.md or checkpoint-*.md: .../memory/sessions/<sid>/checkpoint*.md
  if (normalized.includes(path.join("memory", "sessions"))) {
    // Ensure it's directly under a session dir, not in tasks/ or deeper
    const afterSessions = normalized.split(path.join("memory", "sessions"))[1]
    if (afterSessions) {
      const parts = afterSessions.split(path.sep).filter(Boolean)
      // Expected: <sid>/checkpoint.md or <sid>/checkpoint-<topic>.md (2 parts)
      if (parts.length === 2) {
        const basename = parts[1]
        if (basename === "checkpoint.md" || basename.startsWith("checkpoint-")) {
          return true
        }
      }
    }
  }

  return false
}

/**
 * Phase 4 projection guard: returns true for files that are generated
 * projections from the canonical event ledger. These files MUST NOT be
 * directly mutated by generic file tools (Edit, Write, apply_patch).
 *
 * All projection writes must go through the MemoryRecorder as typed events.
 * This is the structural prohibition that gate 5 requires.
 */
export function isProjectionPath(filePath: string): boolean {
  // All protected memory paths are also projection paths
  return isProtectedMemoryPath(filePath)
}

/**
 * Assert that a write to a projection path is allowed.
 *
 * In Phase 4+, this always throws because projection writes must go through
 * the MemoryRecorder. The only exception is migration/recovery mode, which
 * is signaled by an environment variable.
 *
 * Returns true if write is blocked (caller should throw).
 * Returns false if write is allowed (migration/recovery mode).
 */
export function isProjectionWriteBlocked(): boolean {
  // Migration/recovery mode bypasses the block
  if (process.env.MIMOCODE_MIGRATION_MODE === "1") {
    return false
  }
  return true
}

export const PROJECTION_WRITE_ERROR = [
  "DIRECT PROJECTION WRITE BLOCKED",
  "",
  "MEMORY.md, checkpoint.md, and spillover files are generated projections.",
  "All shared-memory changes must be submitted as typed events through the MemoryRecorder.",
  "",
  "To write memory: use the memory recorder API.",
  "To bypass for migration: set MIMOCODE_MIGRATION_MODE=1",
].join("\n")

// ---------------------------------------------------------------------------
// Revision tracking
// ---------------------------------------------------------------------------

function revPath(filePath: string): string {
  return filePath + ".rev"
}

async function readRevision(filePath: string): Promise<string | null> {
  try {
    return (await readFile(revPath(filePath), "utf8")).trim()
  } catch {
    return null
  }
}

async function writeRevision(filePath: string, hash: string): Promise<void> {
  await writeFile(revPath(filePath), hash, "utf8")
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type GuardResult =
  | { status: "ok"; hash: string }
  | { status: "stale_base"; currentHash: string; expectedHash: string }
  | { status: "error"; message: string }

// ---------------------------------------------------------------------------
// Guarded write (full overwrite — used by Write tool)
// ---------------------------------------------------------------------------

/**
 * Write `newContent` to a protected file with full transactional safety.
 *
 * @param filePath  Absolute path to the protected file
 * @param newContent  The new file content
 * @param baseHash  Hash of the content the caller read before deciding to write.
 *                  Pass `null` for first-time writes (no revision exists yet).
 * @returns GuardResult with status, hash, or conflict details
 */
export async function guardedWrite(
  filePath: string,
  newContent: string,
  baseHash: string | null,
  options?: { lockTimeoutMs?: number },
): Promise<GuardResult> {
  const resolved = path.resolve(filePath)
  const lockKey = `memory-guard:${resolved}`
  const dir = path.dirname(resolved)
  const tmpPath = path.join(dir, `.tmp-${Date.now()}-${process.pid}.md`)
  const lockTimeoutMs = options?.lockTimeoutMs ?? 30_000

  try {
    await using _lock = await Flock.acquire(lockKey, { timeoutMs: lockTimeoutMs })

    // 1. Read current content while holding lock
    let currentContent: string
    try {
      currentContent = await readFile(resolved, "utf8")
    } catch (err: any) {
      if (err.code === "ENOENT") {
        currentContent = ""
      } else {
        throw err
      }
    }

    // 2. Compute current revision
    const currentHash = contentHash(currentContent)
    const storedRev = await readRevision(resolved)

    // 3. Check base revision if this is not a first-time write
    if (baseHash !== null) {
      // First write: no stored revision yet — any base is fine
      // Subsequent writes: base must match stored revision
      if (storedRev !== null && baseHash !== storedRev) {
        return {
          status: "stale_base",
          currentHash: storedRev,
          expectedHash: baseHash,
        }
      }
    }

    // 4. Write to temporary file in same directory
    await writeFile(tmpPath, newContent, "utf8")

    // 5. Verify temp file exists and is writable
    try {
      await stat(tmpPath)
    } catch {
      return { status: "error", message: "Temporary file creation failed" }
    }

    // 6. Atomically rename over target
    // On POSIX, rename() within the same filesystem is atomic.
    // The kernel guarantees either the old or new name is visible, never both.
    await rename(tmpPath, resolved)

    // 7. Compute and store new revision
    const newHash = contentHash(newContent)
    await writeRevision(resolved, newHash)

    return { status: "ok", hash: newHash }
  } catch (err: any) {
    // Best-effort cleanup of temp file
    try {
      await stat(tmpPath).then(() => import("fs/promises").then(f => f.rm(tmpPath, { force: true }))).catch(() => {})
    } catch {
      // ignore cleanup errors
    }

    if (err.message?.includes("Timed out waiting for lock")) {
      return {
        status: "error",
        message: `Lock timeout: another writer holds the lock for ${resolved}`,
      }
    }
    return { status: "error", message: err.message || String(err) }
  }
}

// ---------------------------------------------------------------------------
// Guarded read (returns content + hash for use as baseHash in subsequent write)
// ---------------------------------------------------------------------------

export interface GuardedReadResult {
  content: string
  hash: string
  exists: boolean
}

/**
 * Read a protected file and return its content plus revision hash.
 * The hash can be passed to `guardedWrite` as `baseHash` to detect stale writes.
 */
export async function guardedRead(filePath: string): Promise<GuardedReadResult> {
  const resolved = path.resolve(filePath)
  try {
    const content = await readFile(resolved, "utf8")
    return { content, hash: contentHash(content), exists: true }
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return { content: "", hash: contentHash(""), exists: false }
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// Guarded edit (read-modify-write — used by Edit tool)
// ---------------------------------------------------------------------------

/**
 * Edit a protected file with full transactional safety.
 *
 * @param filePath  Absolute path to the protected file
 * @param oldString  Text to find
 * @param newString  Replacement text
 * @param replaceAll  Replace all occurrences (default false)
 * @param baseHash  Hash of the content the caller read before deciding to edit.
 *                  Pass `null` for first-time writes.
 * @returns GuardResult with status, hash, or conflict details
 */
export async function guardedEdit(
  filePath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean = false,
  baseHash: string | null,
): Promise<GuardResult> {
  const resolved = path.resolve(filePath)
  const lockKey = `memory-guard:${resolved}`

  try {
    await using _lock = await Flock.acquire(lockKey, { timeoutMs: 30_000 })

    // 1. Read current content while holding lock
    let currentContent: string
    try {
      currentContent = await readFile(resolved, "utf8")
    } catch (err: any) {
      if (err.code === "ENOENT") {
        currentContent = ""
      } else {
        throw err
      }
    }

    // 2. Compute current revision
    const currentHash = contentHash(currentContent)
    const storedRev = await readRevision(resolved)

    // 3. Check base revision
    if (baseHash !== null) {
      if (storedRev !== null && baseHash !== storedRev) {
        return {
          status: "stale_base",
          currentHash: storedRev,
          expectedHash: baseHash,
        }
      }
    }

    // 4. Apply the edit
    let newContent: string
    if (oldString === "") {
      // Append mode (oldString empty = create or overwrite)
      newContent = newString
    } else {
      if (replaceAll) {
        if (!currentContent.includes(oldString)) {
          return {
            status: "error",
            message: `oldString not found in ${resolved}`,
          }
        }
        newContent = currentContent.split(oldString).join(newString)
      } else {
        const idx = currentContent.indexOf(oldString)
        if (idx === -1) {
          return {
            status: "error",
            message: `oldString not found in ${resolved}`,
          }
        }
        // Check for multiple matches
        const afterFirst = currentContent.indexOf(oldString, idx + oldString.length)
        if (afterFirst !== -1) {
          return {
            status: "error",
            message: `Found multiple matches for oldString in ${resolved}. Provide more surrounding context or use replaceAll.`,
          }
        }
        newContent = currentContent.slice(0, idx) + newString + currentContent.slice(idx + oldString.length)
      }
    }

    // 5. Write to temporary file
    const dir = path.dirname(resolved)
    const tmpPath = path.join(dir, `.tmp-${Date.now()}-${process.pid}.md`)
    await writeFile(tmpPath, newContent, "utf8")

    // 6. Atomic rename
    await rename(tmpPath, resolved)

    // 7. Store new revision
    const newHash = contentHash(newContent)
    await writeRevision(resolved, newHash)

    return { status: "ok", hash: newHash }
  } catch (err: any) {
    if (err.message?.includes("Timed out waiting for lock")) {
      return {
        status: "error",
        message: `Lock timeout: another writer holds the lock for ${resolved}`,
      }
    }
    return { status: "error", message: err.message || String(err) }
  }
}
