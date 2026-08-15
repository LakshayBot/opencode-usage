/**
 * In-flight deduplication for events. The database enforces uniqueness via
 * PRIMARY KEY, but a bounded in-memory set avoids pointless INSERT attempts
 * when opencode re-emits the same part (session replay, UI re-subscription).
 */

const MAX_KEYS = 5000

export class EventDeduplicator {
  private seen = new Set<string>()

  /** Returns true when the key was already seen in this process. */
  alreadySeen(key: string): boolean {
    return this.seen.has(key)
  }

  /** Marks a key as seen. Returns false when it was already present. */
  mark(key: string): boolean {
    if (this.seen.has(key)) return false
    if (this.seen.size >= MAX_KEYS) {
      // Drop oldest by FIFO (Set iteration order) to bound memory.
      const first = this.seen.values().next().value
      if (first !== undefined) this.seen.delete(first)
    }
    this.seen.add(key)
    return true
  }
}
