import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * The ONLY field `PATCH P/finances/:id` may change
 * (docs/backend-architecture.md's route table: "PATCH comment only"; the
 * business-rules table: "comments and attachments may be edited"). Every
 * other posted field is immutable — see the database trigger enforcing this
 * as a backstop (phase4_allow_comment_edit migration).
 */
export class EditCommentDto {
  @ApiProperty({ example: 'Corrected description after review' })
  @IsString()
  @Length(1, 1000)
  comment!: string;
}
