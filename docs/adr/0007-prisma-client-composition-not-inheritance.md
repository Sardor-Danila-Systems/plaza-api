---
status: accepted
---

# PrismaService composes the generated client instead of extending it

The well-known NestJS+Prisma pattern is `class PrismaService extends PrismaClient`. Phase 1
implementation empirically found this broken under Prisma ORM v7's new `prisma-client` generator:
`new (class Sub extends PrismaClient {})()` is not `instanceof Sub` — the generated client's
constructor (`$Class.getPrismaClientClass()`) does not preserve subclass identity, almost
certainly because it returns a Proxy-wrapped instance internally for its `prisma.model.method()`
magic property access, which per JavaScript class semantics replaces `this` for any subclass and
breaks `instanceof`/prototype-chain checks on the subclass. This was verified directly (see the
Phase 1 report) both through Nest's `TestingModule` and with a plain subclass outside any
framework, ruling out a Jest/Nest-specific cause. `PrismaService` therefore holds the client as a
`readonly client: PrismaClient` property and implements `OnModuleInit`/`OnModuleDestroy` itself to
call `$connect`/`$disconnect`; every business service calls `this.prisma.client.<model>` /
`this.prisma.client.$transaction(...)` instead of `this.prisma.<model>` directly. This is one extra
property hop everywhere Prisma is used from Phase 4 onward — accepted because there is no working
alternative under this Prisma major version, and revisiting it later (if a future Prisma version
restores subclassing support) is a mechanical rename, not a redesign.
