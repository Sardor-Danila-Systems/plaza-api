import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Wraps argon2 so the rest of the codebase never imports the library
 * directly or chooses its own parameters. Uses argon2's own current
 * defaults (argon2id, 64 MiB memory, 3 iterations, 4 threads — OWASP's
 * current baseline recommendation) rather than exposing them as tunable
 * environment variables: a misconfigured "faster" work factor set via env
 * var is a realistic way this could get weakened by mistake later, and there
 * is no concrete requirement yet that justifies that risk.
 */
@Injectable()
export class PasswordService {
  /**
   * A fixed, precomputed hash of a placeholder string, verified against on
   * every login attempt for an email that doesn't exist. Without this, a
   * request for an unknown email returns in microseconds while a request for
   * a known email takes tens of milliseconds (real argon2 verification),
   * letting an attacker enumerate valid accounts purely by response timing
   * even though the response *body* is identical either way. This constant
   * is not a secret — it never corresponds to any real user's password.
   */
  private static readonly DUMMY_HASH_PROMISE = argon2.hash(
    'a-fixed-placeholder-value-never-a-real-password',
    { type: argon2.argon2id },
  );

  async hash(plainPassword: string): Promise<string> {
    return argon2.hash(plainPassword, { type: argon2.argon2id });
  }

  async verify(hash: string, plainPassword: string): Promise<boolean> {
    return argon2.verify(hash, plainPassword);
  }

  /** Spends the same argon2 verification time as a real login attempt, for
   * the "email not found" branch of login — see DUMMY_HASH_PROMISE. Always
   * resolves to `false`; the result is intentionally never used for a
   * decision, only its timing. */
  async verifyAgainstDummyHash(plainPassword: string): Promise<boolean> {
    const dummyHash = await PasswordService.DUMMY_HASH_PROMISE;
    return argon2.verify(dummyHash, plainPassword);
  }
}
