/**
 * WARLORDS — Hashing helpers for credential material.
 *
 * Session tokens and initData are stored ONLY as SHA-256 digests; raw values
 * never touch the database or logs. Comparisons over secret-derived digests
 * use constant-time equality.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

/** Constant-time equality for equal-length hex digests; any mismatch → false. */
export function safeDigestEqual(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false
  return timingSafeEqual(Buffer.from(aHex, 'hex'), Buffer.from(bHex, 'hex'))
}
