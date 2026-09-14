import { createHash } from 'node:crypto';

/**
 * Canonicalizes a plain JSON-shaped value for hashing: object keys are
 * sorted so `{a:1,b:2}` and `{b:2,a:1}` hash identically, arrays keep their
 * given order (callers are responsible for stabilizing any order that is
 * not already semantically meaningful — see docs/transaction-design.md §3's
 * "item order stabilized" for the purchase-item-array case, not applicable
 * to Phase 4's single-row finance bodies), and `undefined` values are
 * dropped (matching `JSON.stringify`'s own behavior) so an explicit
 * `{x: undefined}` and an absent `x` hash the same.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) {
        result[key] = canonicalize(entry);
      }
    }
    return result;
  }
  return value;
}

/**
 * The idempotency request-hash mechanism (docs/transaction-design.md §3,
 * docs/adr/0005-idempotency-key-required.md): a SHA-256 hex digest of the
 * semantically significant request fields, computed identically regardless
 * of client-supplied key ordering. Two requests with the same
 * `Idempotency-Key` are the "same operation" only if this hash also
 * matches; a mismatch is `409 IDEMPOTENCY_KEY_REUSED`, never a silent
 * re-execution or a silently accepted second operation.
 *
 * Callers pass only the fields that determine the operation's effect
 * (decimal amounts as their validated strings, route IDs, the operation
 * kind) — never the bearer token, never server-computed/derived fields
 * (`amountUzs`, `direction`), so that a client retry with byte-identical
 * intent always reproduces the same hash even though nothing about the
 * client's original request bytes is replayed here.
 */
export function computeRequestHash(payload: Record<string, unknown>): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonical).digest('hex');
}
