import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ChatTurnDto {
  @ApiProperty({ enum: ['user', 'assistant'] })
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(20_000)
  text!: string;
}

export class ChatRequestDto {
  @ApiProperty({
    type: [ChatTurnDto],
    description:
      'The conversation so far as plain text turns, oldest first, ending with the new user question.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  messages!: ChatTurnDto[];

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'The project open in the UI, so "this project" has a meaning.',
  })
  @IsOptional()
  @IsUUID()
  currentProjectId?: string;
}

export class PendingActionDto {
  @ApiProperty() id!: string;
  @ApiProperty() kind!: string;
  @ApiProperty() projectId!: string;
  @ApiProperty() summary!: string;
  @ApiProperty({ type: Object }) payload!: Record<string, unknown>;
  @ApiProperty({ description: 'Send back to /assistant/actions/confirm.' })
  token!: string;
  @ApiProperty() expiresAt!: string;
}

export class ChatResponseDto {
  @ApiProperty() reply!: string;
  @ApiProperty({ type: [PendingActionDto] })
  pendingActions!: PendingActionDto[];
  @ApiProperty({
    type: [String],
    description: 'Tools the assistant used, in order.',
  })
  toolsUsed!: string[];
}

export class ConfirmActionDto {
  @ApiProperty()
  @IsString()
  @MaxLength(8_000)
  token!: string;
}
