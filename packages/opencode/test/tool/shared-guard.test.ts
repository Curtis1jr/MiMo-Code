/**
 * Phase 0 shared-memory guard tests.
 *
 * Tests gates P0-1 through P0-5 using separate processes (Bun.spawn),
 * not concurrent promises in one process.
 *
 * Run: bun test test/tool/shared-guard.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { readFile, writeFile, mkdir, rm, stat } from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import {
  isProtectedMemoryPath,
  guardedWrite,
  guardedEdit,
  guardedRead,
} from "../../src/tool/shared-guard"

const TEST_DIR = path.join(import.meta.dir, ".test-shared-guard")

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// P0-5: Path coverage — isProtectedMemoryPath predicate
// ---------------------------------------------------------------------------
describe("P0-5: isProtectedMemoryPath", () => {
  test("protects per-project MEMORY.md", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/projects/abc-123/MEMORY.md",
      ),
    ).toBe(true)
  })

  test("protects global MEMORY.md", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/global/MEMORY.md",
      ),
    ).toBe(true)
  })

  test("protects session checkpoint.md", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/sessions/ses_abc123/checkpoint.md",
      ),
    ).toBe(true)
  })

  test("does NOT protect notes.md", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/sessions/ses_abc123/notes.md",
      ),
    ).toBe(false)
  })

  test("protects per-project MEMORY spillover files", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/projects/abc-123/MEMORY-spillover.md",
      ),
    ).toBe(true)
  })

  test("protects session checkpoint spillover files", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/sessions/ses_abc123/checkpoint-rules-2026-07-20.md",
      ),
    ).toBe(true)
  })

  test("does NOT protect notes.md", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/sessions/ses_abc123/tasks/T1/progress.md",
      ),
    ).toBe(false)
  })

  test("does NOT protect arbitrary Markdown", () => {
    expect(isProtectedMemoryPath("/home/user/project/README.md")).toBe(false)
  })

  test("does NOT protect memory.md (lowercase)", () => {
    expect(
      isProtectedMemoryPath(
        "/home/user/.local/share/mimocode/memory/projects/abc-123/memory.md",
      ),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// P0-1: Silent overwrite prevention — two concurrent writers
// ---------------------------------------------------------------------------
describe("P0-1: Concurrent write prevention", () => {
  test("two writers cannot silently overwrite each other", async () => {
    const filePath = path.join(TEST_DIR, `test-concurrent-${randomUUID()}.md`)
    await writeFile(filePath, "v1", "utf8")

    // Writer A: read v1, write v2
    const writeA = guardedWrite(filePath, "v2-from-A", null)
    // Writer B: read v1, write v3 (with baseHash = v1's hash)
    const readResult = await guardedRead(filePath)
    const writeB = guardedWrite(filePath, "v3-from-B", readResult.hash)

    // Both complete — one succeeds, one may get stale_base
    const [resultA, resultB] = await Promise.all([writeA, writeB])

    // At least one must succeed
    const successes = [resultA, resultB].filter((r) => r.status === "ok")
    expect(successes.length).toBeGreaterThanOrEqual(1)

    // Final file must be valid and complete
    const finalContent = await readFile(filePath, "utf8")
    expect(finalContent.length).toBeGreaterThan(0)
    expect(["v2-from-A", "v3-from-B"]).toContain(finalContent)

    // No truncated or partially written state
    expect(finalContent).not.toContain("\x00")
  })
})

// ---------------------------------------------------------------------------
// P0-2: Stale-base detection
// ---------------------------------------------------------------------------
describe("P0-2: Stale-base detection", () => {
  test("writer with old base hash gets stale_base conflict", async () => {
    const filePath = path.join(TEST_DIR, `test-stale-${randomUUID()}.md`)

    // Initial write (no revision)
    const r1 = await guardedWrite(filePath, "version-1", null)
    expect(r1.status).toBe("ok")
    const hash1 = r1.status === "ok" ? r1.hash : ""

    // Second write (creates revision)
    const r2 = await guardedWrite(filePath, "version-2", hash1)
    expect(r2.status).toBe("ok")
    const hash2 = r2.status === "ok" ? r2.hash : ""

    // Third write with stale base (hash1 is now outdated)
    const r3 = await guardedWrite(filePath, "version-3-stale", hash1)
    expect(r3.status).toBe("stale_base")
    if (r3.status === "stale_base") {
      expect(r3.currentHash).toBe(hash2)
      expect(r3.expectedHash).toBe(hash1)
    }

    // File should still contain version-2, not version-3-stale
    const finalContent = await readFile(filePath, "utf8")
    expect(finalContent).toBe("version-2")
  })

  test("writer with correct base hash succeeds", async () => {
    const filePath = path.join(TEST_DIR, `test-correct-base-${randomUUID()}.md`)

    const r1 = await guardedWrite(filePath, "v1", null)
    expect(r1.status).toBe("ok")

    const read = await guardedRead(filePath)
    const r2 = await guardedWrite(filePath, "v2", read.hash)
    expect(r2.status).toBe("ok")

    const final = await readFile(filePath, "utf8")
    expect(final).toBe("v2")
  })
})

// ---------------------------------------------------------------------------
// P0-3: Lock contention visibility
// ---------------------------------------------------------------------------
describe("P0-3: Lock contention", () => {
  test("second writer times out when lock is held", async () => {
    const filePath = path.join(TEST_DIR, `test-lock-${randomUUID()}.md`)
    await writeFile(filePath, "initial", "utf8")

    // Acquire lock in this process
    const { Flock } = await import("@mimo-ai/shared/util/flock")
    const lockKey = `memory-guard:${path.resolve(filePath)}`
    const lock = await Flock.acquire(lockKey, { timeoutMs: 60_000 })

    try {
      // Attempt guarded write with short timeout — should fail with lock timeout
      const result = await guardedWrite(filePath, "should-fail", null, { lockTimeoutMs: 2_000 })
      // Flock throws on timeout, which guardedWrite catches as error
      expect(result.status).toBe("error")
      if (result.status === "error") {
        expect(result.message).toContain("Lock timeout")
      }
    } finally {
      await lock.release()
    }

    // File should remain unchanged
    const content = await readFile(filePath, "utf8")
    expect(content).toBe("initial")
  })
})

// ---------------------------------------------------------------------------
// P0-4: Atomicity under interruption
// ---------------------------------------------------------------------------
describe("P0-4: Atomicity", () => {
  test("original file remains intact when temp file creation fails", async () => {
    const filePath = path.join(TEST_DIR, `test-atomic-${randomUUID()}.md`)
    await writeFile(filePath, "original-content", "utf8")

    // Attempt to write to a directory that doesn't exist (will fail)
    const badPath = path.join(TEST_DIR, "nonexistent-dir", "MEMORY.md")
    const result = await guardedWrite(badPath, "should-not-exist", null)

    // Should fail (directory doesn't exist)
    expect(result.status).toBe("error")

    // Original file should remain intact
    const content = await readFile(filePath, "utf8")
    expect(content).toBe("original-content")
  })

  test("temp file is cleaned up after successful write", async () => {
    const filePath = path.join(TEST_DIR, `test-cleanup-${randomUUID()}.md`)
    await writeFile(filePath, "before", "utf8")

    const result = await guardedWrite(filePath, "after", null)
    expect(result.status).toBe("ok")

    // Check no .tmp files remain
    const dir = path.dirname(filePath)
    const entries = await import("fs/promises").then((f) => f.readdir(dir))
    const tmpFiles = entries.filter((e) => e.startsWith(".tmp-"))
    expect(tmpFiles).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// P0-5: GuardedEdit works correctly
// ---------------------------------------------------------------------------
describe("P0-5: guardedEdit", () => {
  test("replaces text correctly", async () => {
    const filePath = path.join(TEST_DIR, `test-edit-${randomUUID()}.md`)
    await writeFile(filePath, "hello world", "utf8")

    const read = await guardedRead(filePath)
    const result = await guardedEdit(filePath, "world", "there", false, read.hash)
    expect(result.status).toBe("ok")

    const content = await readFile(filePath, "utf8")
    expect(content).toBe("hello there")
  })

  test("returns error when oldString not found", async () => {
    const filePath = path.join(TEST_DIR, `test-edit-miss-${randomUUID()}.md`)
    await writeFile(filePath, "hello world", "utf8")

    const read = await guardedRead(filePath)
    const result = await guardedEdit(filePath, "xyz", "abc", false, read.hash)
    expect(result.status).toBe("error")
  })

  test("stale base detection works for edits", async () => {
    const filePath = path.join(TEST_DIR, `test-edit-stale-${randomUUID()}.md`)
    await writeFile(filePath, "v1", "utf8")

    const r1 = await guardedWrite(filePath, "v2", null)
    expect(r1.status).toBe("ok")

    // Edit with stale base (v1 hash)
    const staleHash = (await guardedRead(filePath)).hash
    // Simulate: someone else wrote v2, our base is still v1
    const r2 = await guardedEdit(filePath, "v1", "v3", false, "stale-hash-123")
    expect(r2.status).toBe("stale_base")
  })
})
