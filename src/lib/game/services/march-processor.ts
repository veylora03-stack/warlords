/**
 * WARLORDS — March processor facade (Phase 33).
 *
 * Server-side entry points for march state advancement. The lazy processor
 * (list/get/process routes) and any FUTURE worker both drive the SAME
 * exactly-once pipelines — there is no second processing path. Each function
 * is idempotent: racing callers converge on exactly one transition (the
 * conditional status claim arbitrates), and each takes the standard
 * march:engine → db:write lock order.
 */

import { dbWrite } from '@/lib/db'
import { withKeyLock } from '@/lib/concurrency/mutex'
import { withWriteRetry } from './player-registration.service'
import { MARCH_ENGINE_LOCK, processArrivalInTx, processReturnInTx } from './march.service'

const PROCESSOR_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const

export interface ProcessorResult {
  /** True when THIS call performed the state transition (exactly one caller). */
  processed: boolean
}

/**
 * Advances one march's arrival if the server clock says it is due.
 * Idempotent — a second concurrent caller resolves as `{ processed: false }`.
 */
export async function runMarchArrival(marchId: string): Promise<ProcessorResult> {
  return withKeyLock(MARCH_ENGINE_LOCK, () =>
    withKeyLock('db:write', () =>
      withWriteRetry(() =>
        dbWrite.$transaction(
          (tx) => processArrivalInTx(tx, marchId, new Date()),
          PROCESSOR_TX_OPTIONS,
        ),
      ),
    ),
  ).then((processed) => ({ processed }))
}

/**
 * Advances one march's homecoming if the server clock says it is due.
 * Idempotent — a second concurrent caller resolves as `{ processed: false }`.
 */
export async function runMarchHomecoming(marchId: string): Promise<ProcessorResult> {
  return withKeyLock(MARCH_ENGINE_LOCK, () =>
    withKeyLock('db:write', () =>
      withWriteRetry(() =>
        dbWrite.$transaction(
          (tx) => processReturnInTx(tx, marchId, new Date()),
          PROCESSOR_TX_OPTIONS,
        ),
      ),
    ),
  ).then((processed) => ({ processed }))
}
