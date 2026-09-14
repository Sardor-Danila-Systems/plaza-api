---
status: accepted
---

# Supplier debt may be settled in a currency different from the purchase's invoice currency

An earlier design draft rejected any settlement whose currency didn't match the originating
purchase (`SETTLEMENT_CURRENCY_MISMATCH`) as the conservative default, since no business
confirmation was available yet. The business has since confirmed the opposite is required in
practice: a supplier invoiced in USD is commonly paid in whichever currency is on hand (e.g. UZS),
at whatever rate is agreed at settlement time. We now allow this, with one hard rule: the debt's
own currency never changes, and whenever the settlement currency differs from the debt currency in
a way that isn't already resolvable through a currency's own recorded UZS rate, the caller must
supply an explicit, allocation-specific exchange rate — the backend never derives it from the
purchase's original invoice rate, the payment's own currency-to-UZS rate, or a live provider quote.
See [transaction-design.md](../transaction-design.md#5-settlement-allocation-cross-currency-settlement)
for the exact formula (`debtAmountSettled`, `settlementExchangeRate`, and the purely-informational
`exchangeDifferenceUzs` reporting figure). The alternative considered — silently converting through
today's rate — was rejected because it would let the exchange-rate-of-the-moment invisibly
determine how much debt was extinguished, which is exactly the kind of implicit conversion this
system's currency rules forbid everywhere else (see §7 of the specification).
