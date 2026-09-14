import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  Currency,
  FinancialTransactionType,
} from '../../../generated/prisma/client.js';

interface ShapeCheckedFields {
  currency?: Currency;
  type?: FinancialTransactionType;
  exchangeRate?: unknown;
  currencyRateId?: unknown;
  rateOverrideReason?: unknown;
  source?: unknown;
  recipient?: unknown;
}

function shapeErrors(dto: ShapeCheckedFields): string[] {
  const errors: string[] = [];

  if (dto.currency === Currency.UZS) {
    if (dto.exchangeRate !== undefined) {
      errors.push('exchangeRate must not be supplied for UZS transactions');
    }
    if (dto.currencyRateId !== undefined) {
      errors.push('currencyRateId must not be supplied for UZS transactions');
    }
    if (dto.rateOverrideReason !== undefined) {
      errors.push(
        'rateOverrideReason must not be supplied for UZS transactions',
      );
    }
  } else if (dto.currency === Currency.USD) {
    const hasRateId = dto.currencyRateId !== undefined;
    const hasOverride =
      dto.exchangeRate !== undefined || dto.rateOverrideReason !== undefined;
    if (hasRateId && hasOverride) {
      errors.push(
        'supply either currencyRateId or exchangeRate+rateOverrideReason, not both',
      );
    } else if (!hasRateId && !hasOverride) {
      errors.push(
        'USD transactions require either currencyRateId or exchangeRate+rateOverrideReason',
      );
    } else if (!hasRateId) {
      if (dto.exchangeRate === undefined) {
        errors.push(
          'exchangeRate is required when currencyRateId is not supplied',
        );
      }
      if (dto.rateOverrideReason === undefined) {
        errors.push(
          'rateOverrideReason is required when currencyRateId is not supplied',
        );
      }
    }
  }

  if (dto.type === FinancialTransactionType.INCOME) {
    if (dto.recipient !== undefined) {
      errors.push(
        'recipient must not be supplied for INCOME transactions; use source instead',
      );
    }
  } else if (
    dto.type === FinancialTransactionType.EXPENSE ||
    dto.type === FinancialTransactionType.SALARY
  ) {
    if (dto.source !== undefined) {
      errors.push(
        'source must not be supplied for EXPENSE/SALARY transactions; use recipient instead',
      );
    }
  }

  return errors;
}

/**
 * Cross-field validation for `CreateFinancialTransactionDto` that a single
 * property-level `class-validator` decorator cannot express (each field's
 * requiredness depends on `currency` and `type`): docs/backend-architecture.md
 * §4's UZS-vs-USD rate rules, and the `source`(income)/`recipient`(expense,
 * salary) naming split for the same underlying `recipient` DB column (see
 * `FinancialTransaction.recipient`'s doc comment in schema.prisma). Attached
 * to a single property (`type`) but inspects the whole DTO via
 * `args.object` — the standard class-validator pattern for a class-level
 * rule, since class-validator has no first-class "validate the whole
 * object" decorator.
 */
export function IsValidFinancialTransactionShape(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isValidFinancialTransactionShape',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          return shapeErrors(args.object as ShapeCheckedFields).length === 0;
        },
        defaultMessage(args: ValidationArguments): string {
          const errors = shapeErrors(args.object as ShapeCheckedFields);
          return errors.join('; ');
        },
      },
    });
  };
}
