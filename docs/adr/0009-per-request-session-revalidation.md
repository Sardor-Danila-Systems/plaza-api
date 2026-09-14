---
status: accepted
---

# Every authenticated request re-checks the session and user from the database

A stateless JWT (verify signature and expiry, trust the claims) cannot express "this session was
just revoked" or "this user was just deactivated" until the token's own expiry passes — the
approved architecture (docs/backend-architecture.md §9) explicitly rejects that: "Reject revoked or
expired sessions... trust database role and assignment rather than stale token claims." Phase 2's
`JwtAuthGuard` therefore looks up the `RefreshSession` (by the access token's `sid` claim) and its
`User` on every authenticated request, rejecting immediately if the session is revoked/expired or
the user is inactive. This costs one indexed database read per authenticated request — accepted
deliberately, per docs/backend-architecture.md §10's own framing ("correctness is more important
than avoiding one indexed user lookup") — in exchange for `POST /auth/logout` and admin
deactivation taking effect immediately for access tokens too, not just refresh tokens. A future
phase may add a short-lived in-memory cache of session validity if this read is ever measured as a
real bottleneck; that would be a performance optimization, not a security model change.
