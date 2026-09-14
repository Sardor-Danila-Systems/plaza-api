/**
 * The three link targets docs/backend-architecture.md §10 approves: "Permit
 * income/expense finance targets, purchase targets, and supplier payments."
 * `FINANCIAL_TRANSACTION` is further restricted, at the service layer, to
 * `INCOME`/`EXPENSE` rows only — not every `FinancialTransactionType` (a
 * purchase's own cash effect is reached via `PURCHASE` instead; a debt
 * payment or advance funding via `SUPPLIER_PAYMENT`).
 */
export enum AttachmentTarget {
  PURCHASE = 'PURCHASE',
  FINANCIAL_TRANSACTION = 'FINANCIAL_TRANSACTION',
  SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT',
}
