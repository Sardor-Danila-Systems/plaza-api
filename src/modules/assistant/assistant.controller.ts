import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { Role } from '../../generated/prisma/client.js';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { AssistantService } from './assistant.service.js';
import {
  ChatRequestDto,
  ChatResponseDto,
  ConfirmActionDto,
} from './dto/chat.dto.js';

@ApiTags('assistant')
@ApiBearerAuth('access-token')
@Roles(Role.OWNER, Role.DEVELOPER, Role.ACCOUNTANT)
@Controller('assistant')
export class AssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Post('chat')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ask the owner assistant a question',
    description:
      'OWNER/DEVELOPER/ACCOUNTANT. Reads data as the caller. Writes are only proposed (pendingActions) and need /assistant/actions/confirm.',
  })
  @ApiOkResponse({ type: ChatResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  chat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChatRequestDto,
  ): Promise<ChatResponseDto> {
    return this.assistant.chat(user, dto);
  }

  @Post('actions/confirm')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Execute a write the assistant proposed',
    description:
      'Re-checks permissions as the caller. Idempotent: confirming the same proposal twice returns the same record.',
  })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmActionDto,
    @Req() req: Request,
  ): Promise<unknown> {
    return this.assistant.confirm(user, dto.token, req.id);
  }
}
