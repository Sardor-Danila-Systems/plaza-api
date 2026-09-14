---
status: accepted
---

# Money/inventory-posting endpoints require a client idempotency key

The primary client is mobile-first over unreliable networks, which means retried POSTs are
expected, not exceptional. Without protection, a retried purchase/payment/advance/transfer request
would double-receive inventory, double-deduct cash, or double-create debt. We require an
`Idempotency-Key` header on every purchase, supplier payment, supplier advance, and warehouse
transfer creation/cancellation endpoint, and persist `(projectId, actorId, operationKind, key)`
with a canonical request hash atomically with the operation's effects (`PostedOperation` table). A
replay with the same key and payload returns the already-committed result instead of re-executing;
a replay with the same key but a different payload is rejected as `409
IDEMPOTENCY_KEY_REUSED` rather than silently executed. We deliberately did not add this to every
GET/list endpoint or to low-risk metadata edits (comments) — only to operations that move money or
stock, since that's where duplication is unacceptable and the mobile-retry risk is concrete.
