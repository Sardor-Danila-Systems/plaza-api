import { registerDecorator, ValidationOptions } from 'class-validator';
import { isValidBusinessDate } from '../date/business-date.util.js';

/**
 * Validates a `YYYY-MM-DD` calendar date string (docs/backend-architecture.md
 * §4/§2's business-date convention) — stricter than class-validator's own
 * `@IsDateString()`, which accepts full ISO-8601 timestamps and does not
 * reject non-existent calendar dates like `2026-02-30`.
 */
export function IsBusinessDate(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isBusinessDate',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidBusinessDate(value);
        },
        defaultMessage(): string {
          return 'must be a valid calendar date in YYYY-MM-DD form';
        },
      },
    });
  };
}
