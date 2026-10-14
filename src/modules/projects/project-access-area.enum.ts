/**
 * Which part of a project a request touches — the third axis of
 * authorization, next to role and `ProjectAccessAction`. It exists for the
 * CASHIER role: an employee who runs the cash ledger and must not see
 * suppliers, purchases, the warehouse or the construction objects.
 *
 * `GENERAL` is the default for every `assertAccess` call, so a CASHIER is
 * denied anywhere that has not explicitly opted in to `CASH`. A new
 * endpoint is therefore closed to cashiers until someone decides it should
 * not be — never open by omission.
 */
export enum ProjectAccessArea {
  /** Everything outside the cash ledger. CASHIER is denied here. */
  GENERAL = 'GENERAL',
  /** The cash ledger: transactions, balances, transaction categories, currency rates, and
   * the files attached to cash transactions. */
  CASH = 'CASH',
}
