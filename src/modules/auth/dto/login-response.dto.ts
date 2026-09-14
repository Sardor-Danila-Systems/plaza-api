import { ApiProperty } from '@nestjs/swagger';
import { SafeUserDto } from './safe-user.dto.js';

/**
 * The refresh token is deliberately NOT a field here — it is delivered only
 * as an HttpOnly cookie (docs/backend-architecture.md §9's approved cookie
 * model for browser/PWA clients), never in a JSON body a script could read.
 */
export class LoginResponseDto {
  @ApiProperty({
    description: 'Short-lived JWT; send as `Authorization: Bearer <token>`',
  })
  accessToken!: string;

  @ApiProperty({ type: SafeUserDto })
  user!: SafeUserDto;
}
