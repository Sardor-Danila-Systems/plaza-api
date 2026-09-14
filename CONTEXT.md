# Euro Plaza Management System

Euro Plaza Group manages construction projects with separate cash, suppliers,
purchases, warehouses, and construction costs. This glossary defines the language
used in the backend architecture and business workflows.

## Projects and access

**Project**:
A construction development whose financial and material operations are independent
of other developments.
_Avoid_: Company, portfolio, site (when referring to the whole project)

**Project Manager**:
The person assigned to exactly one project who may record and correct its business
operations.

**Owner**:
A reader who can inspect every project independently.
_Avoid_: Administrator, superuser

**Accountant**:
A reader who can inspect every project independently and download its reports.

**Building Block**:
A named building within one project.
_Avoid_: Warehouse, project

**Floor**:
A construction level belonging to one building block.

## Cash and supplier obligations

**Financial Transaction**:
A record of cash entering or leaving one project, with its original currency and
the UZS equivalent valued at the rate used for that transaction.
_Avoid_: Purchase (when referring to the entire invoice), stock movement

**Cash Balance**:
The net cash recorded by a project's financial transactions, including corrections.

**Exchange Rate Snapshot**:
The UZS value of one unit of the original currency fixed for a particular operation.
_Avoid_: Current rate (when describing a historical operation)

**Supplier**:
A vendor with whom one project purchases materials, settles debts, or places
advances.

**Purchase**:
A supplier invoice recorded together with receipt of its materials into one
warehouse; payment may occur at receipt or later.
_Avoid_: Payment, expense (when referring only to cash leaving the project)

**Purchase Item**:
A quantity of one material received at an agreed unit price as part of a purchase.

**Supplier Debt**:
The unpaid portion of a purchase owed to its supplier.
_Avoid_: Negative advance

**Supplier Payment**:
Cash paid to settle specified supplier debts.
_Avoid_: Advance, purchase total

**Supplier Advance**:
Cash previously paid to a supplier that remains available for a future purchase.
_Avoid_: Debt payment, expense recognition

**Settlement Allocation**:
The portion of a supplier payment or supplier advance assigned to a specific
purchase.
_Avoid_: Automatic netting

**Carrying Value**:
The UZS value retained for an outstanding debt or advance from the operation that
created it.

**Settlement Exchange Difference**:
The difference between the UZS carrying values of a settled obligation and the
funding used to settle it.
_Avoid_: Cash movement, inventory revaluation

**Salary Expense**:
Cash paid to a named recipient for work, without maintaining an employee register.

## Materials and inventory

**Warehouse**:
A material storage location within one project, with its own balances.
_Avoid_: Building block

**Material**:
A project-specific construction supply measured in a defined unit.

**Unit**:
A named measure used for material quantities, such as bag, kilogram, or cubic metre.

**Inventory Balance**:
The quantity and UZS carrying value of one material held in one warehouse.
_Avoid_: Project stock (when referring to only one warehouse)

**Stock Movement**:
A historical record of a change in material quantity and value at one warehouse.

**Weighted Average Cost**:
The cost per unit obtained by dividing an inventory balance's total carrying value
by its quantity.
_Avoid_: Latest purchase price

**Write-off**:
Material consumed from a warehouse for a specified building block and floor, valued
at the cost fixed when that consumption was recorded.
_Avoid_: Cash expense, supplier return

**Warehouse Transfer**:
Movement of material and its carrying value between two warehouses of the same
project.
_Avoid_: Purchase, cash transaction

**Low Stock**:
A warehouse's material quantity below the material's minimum stock threshold.

## History and corrections

**Posted Operation**:
A recorded business action whose financial, supplier, or inventory effects have
taken effect together.

**Cancellation**:
A correction that neutralizes a posted operation while retaining the original and
the reason for correcting it.
_Avoid_: Deletion, commercial return

**Reversal**:
A linked compensating record that negates an original operation's effects using
the original quantities, values, and exchange rates.

**Refund**:
An actual return of cash, recorded when it occurs.
_Avoid_: Cancellation of a correctly recorded payment

**Audit Entry**:
A record identifying who performed a business action, what changed, and when it
happened.
