import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { IsInt, IsString, Min } from 'class-validator';

/**
 * There is no business endpoint yet to exercise the global ValidationPipe
 * against (Phase 1 intentionally has none — see
 * docs/backend-architecture.md's phase plan). This test instantiates the
 * exact same ValidationPipe configuration main.ts installs globally and
 * proves the convention every future DTO will rely on, rather than skipping
 * "validation behavior" coverage until a real endpoint exists.
 */
class SampleDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(0)
  quantity!: number;
}

function createPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) =>
      new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: errors.flatMap((error) =>
          Object.values(error.constraints ?? {}),
        ),
      }),
  });
}

describe('global ValidationPipe convention', () => {
  const metadata = { type: 'body', metatype: SampleDto } as const;

  it('strips properties not declared on the DTO when whitelist alone would apply', async () => {
    // Isolates `whitelist` from `forbidNonWhitelisted` to document what each
    // flag actually does: whitelist silently strips; forbidNonWhitelisted
    // (enabled together with it below) turns that into a hard rejection
    // instead. The global pipe in main.ts enables both, matching
    // docs/backend-architecture.md §9's literal requirement.
    const whitelistOnlyPipe = new ValidationPipe({
      whitelist: true,
      transform: true,
    });
    const result = (await whitelistOnlyPipe.transform(
      { name: 'cement', quantity: 5, extraField: 'should be removed' },
      metadata,
    )) as SampleDto & { extraField?: string };

    expect(result.extraField).toBeUndefined();
    expect(result.name).toBe('cement');
  });

  it('rejects (rather than silently strips) a field not declared on the DTO', async () => {
    const pipe = createPipe();

    await expect(
      pipe.transform(
        { name: 'cement', quantity: 5, extraField: 'x' },
        metadata,
      ),
    ).rejects.toMatchObject({
      response: { code: 'VALIDATION_ERROR' },
    });
  });

  it('transforms a plain object into an instance of the DTO class', async () => {
    const pipe = createPipe();
    const result = await pipe.transform(
      { name: 'cement', quantity: 5 },
      metadata,
    );

    expect(result).toBeInstanceOf(SampleDto);
  });

  it('rejects invalid field values with a VALIDATION_ERROR code', async () => {
    const pipe = createPipe();

    await expect(
      pipe.transform({ name: 'cement', quantity: -5 }, metadata),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
  });

  it('does NOT implicitly coerce a numeric-looking string (money/quantity safety convention)', async () => {
    const pipe = createPipe();

    // "5" (a string) must NOT be silently accepted as satisfying @IsInt() on
    // `quantity` — implicit conversion is off precisely so a Decimal-shaped
    // string value later phases pass for money/quantity fields is never
    // silently coerced into a JavaScript number (docs/backend-architecture.md §4).
    await expect(
      pipe.transform({ name: 'cement', quantity: '5' }, metadata),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
  });
});
