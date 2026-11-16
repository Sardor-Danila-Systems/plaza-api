/**
 * Which part of a project a request touches — the third axis of
 * authorization, next to role and `ProjectAccessAction`. It exists for the
 * roles that own only one part of a project: the (retired) CASHIER, FINANCE
 * (бухгалтер) and WAREHOUSE (кладовщик) — see ProjectAccessService.
 *
 * `GENERAL` is the default for every `assertAccess` call, and a role
 * limited to some areas is denied anywhere it has not been granted. A new
 * endpoint is therefore closed to those roles until someone tags it with
 * the area it belongs to — never open by omission.
 */
export enum ProjectAccessArea {
  /** The project record itself (name, code) — every screen is titled with
   * it, so every role assigned to the project may read it. */
  PROJECT = 'PROJECT',
  /** Construction objects and anything not tagged with a narrower area. */
  GENERAL = 'GENERAL',
  /** The cash ledger: transactions, balances, transaction categories, currency rates, and
   * the files attached to cash transactions. */
  CASH = 'CASH',
  /** Money outside the cash ledger: suppliers, their advances, debts and
   * payments, purchases, their files, the audit log and the financial
   * summaries and reports. */
  FINANCE = 'FINANCE',
  /** The warehouse: warehouses, materials and their categories, units,
   * stock balances, write-offs, transfers, and material reports. */
  INVENTORY = 'INVENTORY',
}
