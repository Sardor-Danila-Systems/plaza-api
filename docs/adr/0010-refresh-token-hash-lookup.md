---
status: accepted
---

# Refresh tokens are looked up by a direct unique index on their SHA-256 hash

The specification's suggested pattern is an opaque two-part token (`sessionId.secret`) specifically
so a refresh token can be looked up by an indexed ID without scanning every stored hash. That
concern doesn't apply here: `passwordHash` must use a slow, salted, non-deterministic algorithm
(argon2id) because it protects against offline brute-forcing of a leaked hash, but a refresh token
secret is already ≥32 bytes of high-entropy random data — brute-forcing the _secret itself_ is
infeasible regardless of hash speed, so the hash only needs to prevent a stolen database dump from
handing out working refresh tokens directly. SHA-256 is fast and, critically, **deterministic**:
the same secret always produces the same hash, so `RefreshToken.tokenHash` can carry a plain unique
index and be looked up with `WHERE tokenHash = $1` in O(log n), no table scan and no composite ID
needed. This is an equally safe mechanism to the suggested two-part design (per the specification's
own "not a mandatory override if the approved architecture already defines an equally safe
mechanism" clause) with one less moving part — no ID-parsing step, no risk of ID/secret confusion.
