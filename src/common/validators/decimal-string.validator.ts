import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export interface DecimalStringOptions {
  /** Maximum fractional digits allowed — matches the destination
   * `Decimal(24, N)` column's scale exactly (docs/backend-architecture.md
   * §4's precision table). */
  maxDecimalPlaces: number;
  /** Reject zero; only strictly positive values pass. Default `true` — every
   * money/quantity/rate field in this system requires positivity except
   * where a caller explicitly opts out. */
  positive?: boolean;
  /**
   * Total significant digits allowed (integer + fractional combined) —
   * matches the destination column's overall `Decimal(P, _)` precision.
   * Every `@IsDecimalString`-validated column in this schema is
   * `Decimal(24, N)`, so `24` is a safe default for all of them; pass a
   * different value only for a field backed by a different precision.
   *
   * Found via direct testing (Phase 12 hardening pass), not merely
   * suspected: before this bound existed, a client-supplied decimal with
   * MORE integer digits than its destination column allows (e.g.
   * `"999999999999999999999999999999.00"` against a `Decimal(24,2)`
   * column) passed this validator — nothing here checked the integer
   * part's length — reached PostgreSQL, and failed there with a raw
   * `numeric field overflow`, which `AllExceptionsFilter`'s generic Prisma
   * fallback then surfaced as an unclassified `500 DATABASE_ERROR` instead
   * of the `400 VALIDATION_ERROR` this is actually a case of.
   */
  maxTotalDigits?: number;
}

const DEFAULT_MAX_TOTAL_DIGITS = 24;

/**
 * Validates a JSON string as an exact decimal literal fit for
 * `new Prisma.Decimal(value)` — never a JS `number`
 * (docs/backend-architecture.md §4: "Use Prisma Decimal for all monetary and
 * quantity arithmetic... JSON request/response values are decimal strings").
 * Deliberately stricter than class-validator's own `@IsDecimal`, which
 * accepts signs, exponents, and unbounded fractional digits: this rejects
 * exponent notation, a leading `+`/`-`, a bare/trailing decimal point, and
 * more fractional digits than the destination column allows, per
 * backend-architecture.md §4 ("Reject exponent notation, NaN, infinity,
 * negative inputs, and zero where positivity is required").
 */
export function IsDecimalString(
  options: DecimalStringOptions,
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isDecimalString',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      constraints: [options],
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') {
            return false;
          }
          const [opts] = args.constraints as [DecimalStringOptions];
          const maxIntegerDigits = Math.max(
            1,
            (opts.maxTotalDigits ?? DEFAULT_MAX_TOTAL_DIGITS) -
              opts.maxDecimalPlaces,
          );
          const pattern = new RegExp(
            `^(0|[1-9]\\d{0,${maxIntegerDigits - 1}})(\\.\\d{1,${opts.maxDecimalPlaces}})?$`,
          );
          if (!pattern.test(value)) {
            return false;
          }
          if (opts.positive === false) {
            return true;
          }
          return !/^0(\.0+)?$/.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          const [opts] = args.constraints as [DecimalStringOptions];
          const positivity =
            opts.positive === false ? 'a non-negative' : 'a positive';
          const totalDigits = opts.maxTotalDigits ?? DEFAULT_MAX_TOTAL_DIGITS;
          return (
            `${args.property} must be ${positivity} decimal string with at ` +
            `most ${opts.maxDecimalPlaces} fractional digit(s), at most ` +
            `${totalDigits} significant digits in total, no sign, and no ` +
            'exponent notation'
          );
        },
      },
    });
  };
}
