import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { Currency } from '../../generated/prisma/client.js';

interface CurrencyRateCheckedFields {
  currency?: Currency;
  exchangeRate?: unknown;
  currencyRateId?: unknown;
  rateOverrideReason?: unknown;
}

function shapeErrors(dto: CurrencyRateCheckedFields): string[] {
  const errors: string[] = [];
  if (dto.currency === Currency.UZS) {
    if (dto.exchangeRate !== undefined) {
      errors.push('exchangeRate must not be supplied for UZS');
    }
    if (dto.currencyRateId !== undefined) {
      errors.push('currencyRateId must not be supplied for UZS');
    }
    if (dto.rateOverrideReason !== undefined) {
      errors.push('rateOverrideReason must not be supplied for UZS');
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
        'USD requires either currencyRateId or exchangeRate+rateOverrideReason',
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
  return errors;
}

/**
 * The reusable UZS/USD rate-shape rule (docs/backend-architecture.md §4):
 * UZS never carries rate fields; USD requires exactly one of an existing
 * `currencyRateId` or an explicit `exchangeRate` + `rateOverrideReason`.
 * First established as `IsValidFinancialTransactionShape` in Phase 4's
 * `CreateFinancialTransactionDto`; extracted here so Phase 6's supplier
 * advance/debt-payment DTOs (and Phase 7's purchase DTO) reuse the exact
 * same rule instead of a second, potentially-drifting copy.
 */
export function IsValidCurrencyRateShape(
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isValidCurrencyRateShape',
      target: object.constructor,
      propertyName: propertyName as string,
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          return (
            shapeErrors(args.object as CurrencyRateCheckedFields).length === 0
          );
        },
        defaultMessage(args: ValidationArguments): string {
          return shapeErrors(args.object as CurrencyRateCheckedFields).join(
            '; ',
          );
        },
      },
    });
  };
}
