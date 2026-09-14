/**
 * The single normalization rule for login identifiers, per
 * docs/backend-data-model.md ("normalizing email is explicit; case-insensitive
 * application comparisons alone do not replace the unique normalized stored
 * key"). Every lookup and every write goes through this — never compare or
 * store a raw, un-normalized email. The approved Phase 0 model defines email
 * as the only login identifier (no phone field), so there is no
 * email-vs-phone ambiguity to resolve here.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
