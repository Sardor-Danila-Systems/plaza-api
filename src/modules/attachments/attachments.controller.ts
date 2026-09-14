import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.js';
import { AttachmentsService } from './attachments.service.js';
import { AttachmentResponseDto } from './dto/attachment-response.dto.js';
import { LinkAttachmentDto } from './dto/link-attachment.dto.js';
import { ListAttachmentsQueryDto } from './dto/list-attachments-query.dto.js';
import { PaginatedAttachmentsResponseDto } from './dto/paginated-attachments-response.dto.js';

@ApiTags('attachments')
@ApiBearerAuth('access-token')
@Controller('projects/:projectId/attachments')
export class AttachmentsController {
  constructor(private readonly attachmentsService: AttachmentsService) {}

  @Post()
  @HttpCode(201)
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Upload a file (JPEG/PNG/WebP/PDF)',
    description:
      'PROJECT_MANAGER of this project only. Returns a READY (unlinked) attachment — link it to a business record with a separate call.',
  })
  @ApiCreatedResponse({ type: AttachmentResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description:
      'FILE_TOO_LARGE | UNSUPPORTED_FILE_TYPE | ATTACHMENT_UPLOAD_FAILED',
    type: ErrorResponseDto,
  })
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    if (!file) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'A file is required',
      });
    }
    return this.attachmentsService.upload(user, projectId, file, req.id);
  }

  @Post(':id/link')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Link a READY attachment to exactly one business record',
    description: 'PROJECT_MANAGER of this project only.',
  })
  @ApiOkResponse({ type: AttachmentResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'ATTACHMENT_NOT_READY | UNSUPPORTED_ATTACHMENT_TARGET',
    type: ErrorResponseDto,
  })
  async link(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkAttachmentDto,
    @Req() req: Request,
  ): Promise<AttachmentResponseDto> {
    return this.attachmentsService.link(user, projectId, id, dto, req.id);
  }

  @Get()
  @ApiOperation({
    summary: 'List attachments (optionally filtered to one linked entity)',
  })
  @ApiOkResponse({ type: PaginatedAttachmentsResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListAttachmentsQueryDto,
  ): Promise<PaginatedAttachmentsResponseDto> {
    return this.attachmentsService.list(user, projectId, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get attachment metadata' })
  @ApiOkResponse({ type: AttachmentResponseDto })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AttachmentResponseDto> {
    return this.attachmentsService.get(user, projectId, id);
  }

  @Get(':id/download')
  @ApiOperation({ summary: 'Download the verified file' })
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  async download(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const file = await this.attachmentsService.download(user, projectId, id);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.filename.replace(/"/g, '')}"`,
    );
    res.send(file.buffer);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete a never-linked attachment',
    description:
      'Only PENDING/READY/FAILED attachments may be deleted — a LINKED one is retained forever with its business record. PROJECT_MANAGER of this project only.',
  })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ type: ErrorResponseDto })
  @ApiNotFoundResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'ATTACHMENT_LINKED',
    type: ErrorResponseDto,
  })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.attachmentsService.deleteOrphan(user, projectId, id, req.id);
  }
}
