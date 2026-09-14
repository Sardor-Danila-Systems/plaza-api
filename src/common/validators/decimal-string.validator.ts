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
}

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
          const pattern = new RegExp(
            `^(0|[1-9]\\d*)(\\.\\d{1,${opts.maxDecimalPlaces}})?$`,
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
          return (
            `${args.property} must be ${positivity} decimal string with at ` +
            `most ${opts.maxDecimalPlaces} fractional digit(s), no sign, ` +
            'and no exponent notation'
          );
        },
      },
    });
  };
}
