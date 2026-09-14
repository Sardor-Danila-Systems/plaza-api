---
status: accepted
---

# Disabled-account status is revealed only after a correct password

Login must make "unknown email" and "wrong password" indistinguishable (both externally and by
response timing — see `PasswordService`'s dummy-hash verification) to prevent account enumeration.
A disabled account is different: the specification explicitly wants a distinct `USER_DISABLED`
response for it (§17, §24), which on its face reveals "this email belongs to a real, disabled
account" to whoever asks. We resolve this by checking `isActive` only _after_ the submitted
password has already been verified correct against that account's real hash. Someone who does not
know the password gets the same indistinguishable `INVALID_CREDENTIALS` as any other guess,
disabled or not — the account's existence is not leaked to them. Someone who does know the correct
password already has strong evidence of a legitimate association with that account, so telling them
"this account is disabled" is not the kind of enumeration the indistinguishability requirement is
protecting against.
