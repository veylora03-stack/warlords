/**
 * WARLORDS — Keyed in-process mutex.
 *
 * Serializes async critical sections that share the same key (e.g. one player's
 * wallet) so read-modify-write flows never interleave inside a single server
 * process. This is the MVP concurrency backbone for the economy engine:
 *
 *   single-node MVP  → deterministic serialization (this module)
 *   PostgreSQL prod  → same call-sites; row locks / advisory locks remain the
 *                      DB-level backstop (docs/ECONOMY_ARCHITECTURE.md)
 *
 * Properties:
 *  - FIFO fairness: waiters run in arrival order.
 *  - A failing critical section NEVER poisons the chain (errors propagate to
 *    the caller only; subsequent sections still run).
 *  - Keys with no waiters are evicted from the map — no unbounded growth.
 *  - NOT reentrant: nesting the same key deadlocks by design (same as any
 *    non-reentrant lock) — critical sections must not compose recursively.
 */

const chains = new Map<string, Promise<unknown>>()

/**
 * Runs `fn` as the exclusive critical section for `key`. Concurrent calls with
 * the same key queue (FIFO); different keys run in parallel.
 */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = chains.get(key) ?? Promise.resolve()
  // Run the section regardless of the tail's outcome; surface only our result.
  const run = tail.then(fn, fn)

  // Keep the chain alive for the next waiter, then evict ourselves when idle.
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, settled)
  void settled.then(() => {
    if (chains.get(key) === settled) chains.delete(key)
  })

  return run
}

/** Test seam — number of keys currently holding/queueing a chain. */
export function activeLockKeys(): number {
  return chains.size
}
