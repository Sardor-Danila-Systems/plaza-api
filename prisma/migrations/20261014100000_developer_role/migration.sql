-- Developer/support account: full read and write access to every project.
-- Not project-scoped, so the existing User_role_projectId_check constraint
-- (projectId must be NULL for every role except PROJECT_MANAGER and CASHIER)
-- already covers it; no constraint change is needed.
ALTER TYPE "Role" ADD VALUE 'DEVELOPER';
