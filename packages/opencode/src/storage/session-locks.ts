import { Mutex } from "async-mutex"

type SessionID = string

/**
 * Per-session writer locks to prevent concurrent database writes from corrupting
 * session state. Mirrors Codex's LiveWriterLocks pattern.
 *
 * Without this safeguard, concurrent writes to the same SQLite database can
 * cause session drift - where sessions' scopes overlap, identities merge,
 * and boundaries dissolve.
 */
class SessionWriterLocks {
  private locks = new Map<SessionID, Mutex>()

  /**
   * Acquire a lock for the given session ID.
   * Returns a release function.
   *
   * The lock is per-session, so different sessions can write concurrently
   * without blocking each other. Only writes to the SAME session are serialized.
   */
  async acquire(sessionID: SessionID): Promise<() => void> {
    let lock = this.locks.get(sessionID)
    if (!lock) {
      lock = new Mutex()
      this.locks.set(sessionID, lock)
    }
    const release = await lock.acquire()
    return release
  }

  /**
   * Check if a session currently holds a lock.
   */
  isLocked(sessionID: SessionID): boolean {
    const lock = this.locks.get(sessionID)
    return lock ? lock.isLocked() : false
  }

  /**
   * Clean up locks for sessions that are no longer active.
   * Call this periodically to prevent memory leaks.
   */
  cleanup(activeSessionIDs: Set<SessionID>): void {
    for (const [id] of this.locks) {
      if (!activeSessionIDs.has(id)) {
        this.locks.delete(id)
      }
    }
  }
}

export const sessionWriterLocks = new SessionWriterLocks()

/**
 * Execute a function with a per-session writer lock.
 * Ensures that only one write operation per session can execute at a time.
 */
export async function withSessionLock<T>(
  sessionID: SessionID,
  fn: () => T | Promise<T>,
): Promise<T> {
  const release = await sessionWriterLocks.acquire(sessionID)
  try {
    return await fn()
  } finally {
    release()
  }
}
