/**
 * Operation intent, distinct from role — see
 * docs/backend-architecture.md §13/§14. Role alone cannot express
 * "PROJECT_MANAGER may read AND write their own project, but OWNER/
 * ACCOUNTANT may read any project and write none" without this axis.
 */
export enum ProjectAccessAction {
  READ = 'READ',
  WRITE = 'WRITE',
}
