import { ApiProperty } from '@nestjs/swagger';

export class AccessTokenResponseDto {
  @ApiProperty({ description: 'A newly issued short-lived JWT' })
  accessToken!: string;
}
