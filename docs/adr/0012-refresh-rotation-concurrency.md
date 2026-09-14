---
status: accepted
---

# Refresh-token rotation: any reuse of a consumed token revokes the whole session, with no exception for a "genuine" concurrent race

Two requests presenting the same refresh token nearly simultaneously (a slow network causing a
client retry, or a genuine replay attempt) must not both succeed. The Phase 0 financial-transaction
design (docs/transaction-design.md) solves its equivalent problem with a project-row
`SELECT ... FOR UPDATE` under `Serializable` isolation — deliberately not reused here (auth
sessions are independent of construction-project financial state, and pulling in that machinery for
a single-row problem would be exactly the "unnecessary complexity" this phase was told to avoid).
Instead, rotation consumes the old token with `UPDATE "RefreshToken" SET "consumedAt" = now() WHERE
id = $1 AND "consumedAt" IS NULL`. PostgreSQL serializes concurrent `UPDATE`s targeting the same row
at the row level regardless of isolation level, so exactly one of two concurrent attempts ever
matches a row; the loser reliably observes `count: 0`.

An earlier draft of this logic tried to be lenient here: revoke the whole session on a _replay_ of
an already-settled token, but merely reject (leaving the session intact) when the loser lost a
_fast concurrent_ race, on the theory that the latter is more likely benign. Implementing that
distinction turned out to be unreliable in practice — this phase's own concurrency test flaked
between the two outcomes depending on request scheduling, because "concurrent" and "delayed replay"
are not actually distinguishable from the server's side; both look identical (a consumed token
presented again). We removed the distinction: **any reuse of a consumed refresh token revokes the
entire session**, matching industry-standard OAuth2 refresh-token-rotation reuse detection. This is
deterministic and testable, at a real UX cost — a client that fires two refresh requests for the
same token concurrently loses the session entirely, even the "winning" request's newly-issued
token. The correct mitigation is client-side: never have more than one refresh request in flight at
a time for a given session (a single-flight/mutex guard around the refresh call, standard practice
in frontend auth libraries for exactly this reason) — this is a client implementation requirement
this backend now assumes, not an optional nicety.
