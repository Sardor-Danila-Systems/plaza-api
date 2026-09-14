const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Parses the `\d+[smhd]` duration strings env.validation.ts already validates
 * (e.g. "15m", "30d") into milliseconds, for computing `expiresAt` timestamps.
 * Deliberately not the `ms` npm package: the input shape is already narrowly
 * validated at startup, so a two-line parser is simpler than a dependency.
 */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) {
    throw new Error(`Invalid duration string: "${value}"`);
  }
  const [, amount, unit] = match;
  return Number(amount) * UNIT_MS[unit];
}
