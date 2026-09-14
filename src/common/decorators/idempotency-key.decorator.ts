import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Extracts the required `Idempotency-Key` header (docs/transaction-design.md
 * §3: "Required header: Idempotency-Key (client-generated, opaque, >=16
 * bytes of entropy recommended)"). The >=16-byte figure is a recommendation
 * to clients, not a server-enforced minimum — this only rejects an entirely
 * missing/blank header (`400 VALIDATION_ERROR`) or an implausibly long one,
 * to bound what gets stored in `PostedOperation.idempotencyKey`.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const header = request.headers['idempotency-key'];
    const value = Array.isArray(header) ? header[0] : header;

    if (!value || value.trim().length === 0) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Idempotency-Key header is required',
      });
    }
    if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `Idempotency-Key header must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      });
    }
    return value;
  },
);
