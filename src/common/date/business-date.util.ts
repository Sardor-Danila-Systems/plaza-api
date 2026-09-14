const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A business date, per docs/backend-architecture.md §4 ("Store business
 * dates as PostgreSQL `date`") — a calendar day with no time-of-day and no
 * timezone, always the `YYYY-MM-DD` form. Rejects otherwise-parseable but
 * non-calendar strings (`2026-02-30`) that `new Date(value)` would silently
 * roll forward, since `Date`'s own parsing is exactly the kind of implicit
 * behavior this system avoids for anything financial.
 */
export function isValidBusinessDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * "Today" as a business date, observed in `timezone` — the project's own
 * timezone (docs/backend-architecture.md §2: "What timezone defines a
 * date? | Project timezone... Defines day boundaries without using the
 * server's timezone"). Built on `Intl.DateTimeFormat` (Node's ICU data),
 * not a timezone-database dependency: the `en-CA` locale's date format is
 * exactly `YYYY-MM-DD`, which is the only reason it is used here rather
 * than for anything locale-related.
 */
export function todayInTimezone(
  timezone: string,
  now: Date = new Date(),
): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * docs/backend-architecture.md §2: "Can operations be backdated? | ...
 * Reject future business dates." Plain string comparison is correct and
 * exact for two `YYYY-MM-DD` values — no date-object round trip needed.
 */
export function isFutureBusinessDate(
  occurredAt: string,
  timezone: string,
  now: Date = new Date(),
): boolean {
  return occurredAt > todayInTimezone(timezone, now);
}
