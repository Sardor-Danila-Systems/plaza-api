import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
// `import type`: Request/Response are interfaces with no runtime value
// (Express doesn't `new` them) — isolatedModules + emitDecoratorMetadata
// require this to be explicit so decorator metadata emits `Object` for
// these parameters instead of attempting a nonexistent value reference.
import type { Request, Response } from 'express';
import { ErrorResponseDto } from '../../common/dto/error-response.dto.js';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  AUTH_COOKIE_PATH,
  CSRF_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
} from './auth.constants.js';
import { AuthService } from './auth.service.js';
import { CurrentUser } from './decorators/current-user.decorator.js';
import { Public } from './decorators/public.decorator.js';
import { AccessTokenResponseDto } from './dto/access-token-response.dto.js';
import { ChangePasswordDto } from './dto/change-password.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { LoginResponseDto } from './dto/login-response.dto.js';
import { SafeUserDto } from './dto/safe-user.dto.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { AuthRateLimitGuard } from './guards/auth-rate-limit.guard.js';
import { CsrfGuard } from './guards/csrf.guard.js';
import type { AuthenticatedUser } from './types/authenticated-user.js';

// Per-IP, per-minute. Generous enough that a legitimate user retrying a
// mistyped password, or a client refreshing on every tab focus, never hits
// it, while still meaningfully throttling scripted credential stuffing (see
// AuthRateLimitGuard's class doc for what this is/isn't).
const LOGIN_RATE_LIMIT = new AuthRateLimitGuard(50, 60_000);
const REFRESH_RATE_LIMIT = new AuthRateLimitGuard(100, 60_000);

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: AppConfigService,
  ) {}

  @Public()
  @UseGuards(LOGIN_RATE_LIMIT)
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate with email and password' })
  @ApiOkResponse({ type: LoginResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid credentials',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'Account is disabled (only returned after a correct password)',
    type: ErrorResponseDto,
  })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const result = await this.authService.login(dto.email, dto.password);
    this.setAuthCookies(response, result.refreshSecret, result.csrfToken);

    return {
      accessToken: result.accessToken,
      user: SafeUserDto.fromAuthenticatedUser({
        id: result.user.id,
        email: result.user.email,
        displayName: result.user.displayName,
        role: result.user.role,
        projectId: result.user.projectId,
        sessionId: '', // not part of the public user shape
      }),
    };
  }

  @Public()
  @UseGuards(REFRESH_RATE_LIMIT, CsrfGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth('refresh_token')
  @ApiOperation({
    summary: 'Rotate the refresh token and issue a new access token',
  })
  @ApiOkResponse({ type: AccessTokenResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Invalid, expired, or revoked refresh token',
    type: ErrorResponseDto,
  })
  @ApiForbiddenResponse({
    description: 'CSRF token mismatch, or account disabled',
    type: ErrorResponseDto,
  })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AccessTokenResponseDto> {
    const refreshSecret: unknown = request.cookies?.[REFRESH_TOKEN_COOKIE];
    if (typeof refreshSecret !== 'string' || refreshSecret.length === 0) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: 'Missing refresh token',
      });
    }

    const result = await this.authService.refresh(refreshSecret);
    this.setAuthCookies(response, result.refreshSecret, result.csrfToken);
    return { accessToken: result.accessToken };
  }

  @UseGuards(CsrfGuard)
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Revoke the current session' })
  @ApiNoContentResponse({ description: 'Session revoked' })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiForbiddenResponse({
    description: 'CSRF token mismatch',
    type: ErrorResponseDto,
  })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(user.sessionId);
    this.clearAuthCookies(response);
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Return the authenticated user' })
  @ApiOkResponse({ type: SafeUserDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  me(@CurrentUser() user: AuthenticatedUser): SafeUserDto {
    return SafeUserDto.fromAuthenticatedUser(user);
  }

  @Patch('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Update the authenticated user's own profile",
    description:
      'Self-service only — operates on req.user, no :userId param exists ' +
      'to target another account. Allowlists displayName only; role, ' +
      'projectId, isActive, and email are never accepted here.',
  })
  @ApiOkResponse({ type: SafeUserDto })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateMeDto,
  ): Promise<SafeUserDto> {
    const updated = await this.authService.updateDisplayName(
      user.id,
      dto.displayName,
    );
    return SafeUserDto.fromAuthenticatedUser({
      id: updated.id,
      email: updated.email,
      displayName: updated.displayName,
      role: updated.role,
      projectId: updated.projectId,
      sessionId: user.sessionId,
    });
  }

  @Post('change-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: "Change the authenticated user's own password",
    description:
      'Verifies currentPassword first. On success, revokes every OTHER ' +
      'refresh session for this user (this device/session stays logged in).',
  })
  @ApiNoContentResponse({ description: 'Password changed' })
  @ApiUnauthorizedResponse({ type: ErrorResponseDto })
  @ApiConflictResponse({
    description: 'INVALID_CURRENT_PASSWORD',
    type: ErrorResponseDto,
  })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.authService.changePassword(
      user.id,
      user.sessionId,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  private setAuthCookies(
    response: Response,
    refreshSecret: string,
    csrfToken: string,
  ): void {
    const cookieOptions = {
      httpOnly: true,
      secure: this.config.useSecureCookies,
      sameSite: this.config.cookieSameSite,
      path: AUTH_COOKIE_PATH,
      maxAge: this.config.refreshTokenTtlMs,
      // Omitted entirely (undefined) when COOKIE_DOMAIN isn't set — same
      // host-only behavior as before this option existed.
      ...(this.config.cookieDomain ? { domain: this.config.cookieDomain } : {}),
    };
    response.cookie(REFRESH_TOKEN_COOKIE, refreshSecret, cookieOptions);
    response.cookie(CSRF_TOKEN_COOKIE, csrfToken, {
      ...cookieOptions,
      httpOnly: false,
    });
  }

  private clearAuthCookies(response: Response): void {
    // clearCookie must be called with the SAME path/domain the cookie was
    // set with, or the browser treats it as an unrelated cookie and the
    // original one is never actually removed.
    const clearOptions = {
      path: AUTH_COOKIE_PATH,
      ...(this.config.cookieDomain ? { domain: this.config.cookieDomain } : {}),
    };
    response.clearCookie(REFRESH_TOKEN_COOKIE, clearOptions);
    response.clearCookie(CSRF_TOKEN_COOKIE, clearOptions);
  }
}
