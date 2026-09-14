import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: 'manager@euro-plaza.example' })
  // Trimmed before @IsEmail() runs: a pasted email with incidental
  // whitespace should validate, not bounce with a confusing 400. Case/
  // final normalization for lookup still happens once, in
  // email-normalization.ts — this is only so validation itself isn't
  // whitespace-sensitive.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail()
  email!: string;

  @ApiProperty({ example: 'correct horse battery staple', writeOnly: true })
  @IsString()
  @MinLength(1)
  password!: string;
}
