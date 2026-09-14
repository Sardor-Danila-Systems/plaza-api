import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';
import { RolesGuard } from './guards/roles.guard.js';
import { PasswordService } from './password.service.js';
import { TokenService } from './token.service.js';

@Module({
  // JwtModule.register({}) with no options: every call site (TokenService)
  // passes its own secret/issuer/audience/expiresIn explicitly from
  // AppConfigService — nothing here should have a module-level default that
  // could silently diverge from validated config.
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    // Global: every route requires authentication unless @Public(), and
    // every route enforces @Roles(...) if declared. See
    // docs/backend-architecture.md §9 "default deny" posture.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenService],
})
export class AuthModule {}
