-- FINANCE and WAREHOUSE are project-scoped like PROJECT_MANAGER and the
-- retired CASHIER: a projectId is required for them and forbidden for
-- everyone else. The one-active-manager partial unique index is keyed on
-- role = 'PROJECT_MANAGER', so a project may have any number of either.
ALTER TABLE "User" DROP CONSTRAINT "User_role_projectId_check";
ALTER TABLE "User" ADD CONSTRAINT "User_role_projectId_check" CHECK (
    ("role" IN ('PROJECT_MANAGER', 'CASHIER', 'FINANCE', 'WAREHOUSE') AND "projectId" IS NOT NULL) OR
    ("role" NOT IN ('PROJECT_MANAGER', 'CASHIER', 'FINANCE', 'WAREHOUSE') AND "projectId" IS NULL)
);
