---
status: accepted
---

# Project creation and ALL project administrative metadata (including rename) are CLI-only, never an authenticated HTTP endpoint

The role model has no path to a write-capable "admin" over projects: OWNER and ACCOUNTANT are
read-only by product requirement, and PROJECT_MANAGER can mutate only the one project they're
already assigned to — which is circular for the act of creating a project or assigning its first
manager. A tempting shortcut would be to quietly let OWNER call `POST /projects`, since OWNER is
the closest thing to an administrator the system has. We deliberately did not: that would silently
grant OWNER a write capability the product specification defines as strictly read-only, for the
sake of API completeness rather than a real requirement. Project/manager provisioning instead lives
in `ProjectProvisioningService` (`src/modules/projects/`), invoked only through `src/cli/provision.ts`
— a CLI that boots the real Nest application context (so it shares exactly the same Prisma models,
validation, and atomicity as the HTTP path would) but is never wired to a controller or exposed over
the network. This is the same posture Phase 2 already established for user accounts (`prisma/seed.ts`
for development, an operator workflow implied for production) — no new provisioning philosophy, just
extended to cover projects and reassignment. If a real administrative role is introduced later, this
is the seam where its endpoints would call the same service; the service itself doesn't need to
change.

**Phase 3.1 correction:** the initial Phase 3 implementation drew the line incorrectly, treating
project _rename_ as ordinary manager-writable content (`PATCH /projects/:projectId`, authorized via
the same generic `ProjectAccessService.assertAccess(..., WRITE)` used for blocks/floors) rather than
administrative metadata. "PROJECT_MANAGER may operate on their project's content" does not imply
"may change the project's own administrative identity" — a project's `name`/`code`/`timezone`/active
state/manager assignment are all the same kind of fact, and only one of them (manager assignment) was
ever routed through provisioning. The endpoint was removed entirely; renaming now goes through
`ProjectProvisioningService.renameProject`, called only from the CLI, exactly like creation and
manager assignment. No exception was carved out for OWNER as a substitute.
