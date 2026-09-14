# Frontend Integration Handoff

Status: backend is implemented through Phase 8 only. Do not assume Phase 9 features exist.

## Runtime

- Local base URL: `http://localhost:3000`
- Swagger UI: `http://localhost:3000/docs` when `SWAGGER_ENABLED=true`
- Authentication: bearer access token for API calls, plus HttpOnly refresh cookie for refresh/logout.
- JSON body limit: 1 MB.
- Dates: business dates are `YYYY-MM-DD`; the server stores business dates as PostgreSQL `date` and audit/system timestamps as `timestamptz`.

There is no global `/api/v1` prefix in the shipped backend.

## Auth Flow

1. `POST /auth/login`
   Request:

   ```json
   { "email": "manager@example.com", "password": "password" }
   ```

   Response includes an access token and sets `refresh_token` HttpOnly cookie plus `csrf_token` cookie.

2. Use `Authorization: Bearer <accessToken>` on protected requests.

3. `POST /auth/refresh`
   Send cookies and `X-CSRF-Token` equal to the `csrf_token` cookie value. Response rotates the refresh token and returns a new access token.

4. `POST /auth/logout`
   Send cookies and `X-CSRF-Token`; the server clears the session.

5. `GET /auth/me`
   Returns the current user.

## Roles And Access

- `OWNER`: can read across projects; cannot mutate write-offs/transfers.
- `ACCOUNTANT`: can read project finance/inventory data; cannot mutate write-offs/transfers.
- `PROJECT_MANAGER`: can mutate only the active project assigned to the manager.

Project access is enforced by URL `projectId`, server-side ownership checks, and composite foreign keys. Clients must not send `projectId`, `createdById`, calculated totals, or movement metadata in bodies.

## Endpoint Inventory

Auth:

- `POST /auth/login`
- `POST /auth/refresh`
- `POST /auth/logout`
- `GET /auth/me`

Projects:

- `GET /projects`
- `GET /projects/:projectId`

Construction:

- `GET /projects/:projectId/construction/blocks`
- `GET /projects/:projectId/construction/blocks/:blockId`
- `POST /projects/:projectId/construction/blocks`
- `PATCH /projects/:projectId/construction/blocks/:blockId`
- `GET /projects/:projectId/construction/blocks/:blockId/floors`
- `GET /projects/:projectId/construction/blocks/:blockId/floors/:floorId`
- `POST /projects/:projectId/construction/blocks/:blockId/floors`
- `PATCH /projects/:projectId/construction/blocks/:blockId/floors/:floorId`

Finances:

- `GET /projects/:projectId/finances/balance`
- `GET /projects/:projectId/finances`
- `GET /projects/:projectId/finances/:transactionId`
- `POST /projects/:projectId/finances` with `Idempotency-Key`
- `PATCH /projects/:projectId/finances/:transactionId`
- `POST /projects/:projectId/finances/:transactionId/cancel` with `Idempotency-Key`
- `GET /projects/:projectId/transaction-categories`
- `POST /projects/:projectId/transaction-categories`
- `PATCH /projects/:projectId/transaction-categories/:categoryId`
- `GET /projects/:projectId/currency-rates`
- `POST /projects/:projectId/currency-rates`

Warehouses:

- `GET /projects/:projectId/warehouses`
- `GET /projects/:projectId/warehouses/:warehouseId`
- `POST /projects/:projectId/warehouses`
- `PATCH /projects/:projectId/warehouses/:warehouseId`

Materials:

- `GET /projects/:projectId/material-categories`
- `POST /projects/:projectId/material-categories`
- `PATCH /projects/:projectId/material-categories/:categoryId`
- `GET /projects/:projectId/units`
- `GET /projects/:projectId/materials`
- `GET /projects/:projectId/materials/:materialId`
- `POST /projects/:projectId/materials`
- `PATCH /projects/:projectId/materials/:materialId`

Inventory:

- `GET /projects/:projectId/inventory`

Suppliers:

- `GET /projects/:projectId/suppliers`
- `GET /projects/:projectId/suppliers/:supplierId`
- `POST /projects/:projectId/suppliers`
- `PATCH /projects/:projectId/suppliers/:supplierId`
- `GET /projects/:projectId/suppliers/:supplierId/ledger`

Advances:

- `POST /projects/:projectId/suppliers/:supplierId/advances` with `Idempotency-Key`

Debt payments:

- `POST /projects/:projectId/suppliers/:supplierId/debt-payments` with `Idempotency-Key`

Purchases:

- `POST /projects/:projectId/purchases` with `Idempotency-Key`
- `GET /projects/:projectId/purchases`
- `GET /projects/:projectId/purchases/:id`
- `PATCH /projects/:projectId/purchases/:id`
- `POST /projects/:projectId/purchases/:id/cancel` with `Idempotency-Key`

Write-offs:

- `POST /projects/:projectId/inventory/write-offs` with `Idempotency-Key`
- `GET /projects/:projectId/inventory/write-offs`
- `GET /projects/:projectId/inventory/write-offs/:id`
- `POST /projects/:projectId/inventory/write-offs/:id/cancel` with `Idempotency-Key`

Transfers:

- `POST /projects/:projectId/inventory/transfers` with `Idempotency-Key`
- `GET /projects/:projectId/inventory/transfers`
- `GET /projects/:projectId/inventory/transfers/:id`
- `POST /projects/:projectId/inventory/transfers/:id/cancel` with `Idempotency-Key`

## Request Examples

Create purchase:

```http
POST /projects/PROJECT_ID/purchases
Authorization: Bearer ACCESS_TOKEN
Idempotency-Key: CLIENT_UUID
Content-Type: application/json
```

```json
{
  "supplierId": "SUPPLIER_ID",
  "warehouseId": "WAREHOUSE_ID",
  "currency": "UZS",
  "items": [
    {
      "materialId": "MATERIAL_ID",
      "quantity": "10.000000",
      "unitPrice": "100.00000000"
    }
  ],
  "occurredAt": "2026-09-14",
  "comment": "Invoice #42"
}
```

Create write-off:

```json
{
  "warehouseId": "WAREHOUSE_ID",
  "materialId": "MATERIAL_ID",
  "quantity": "2.000000",
  "blockId": "BLOCK_ID",
  "floorId": "FLOOR_ID",
  "occurredAt": "2026-09-14",
  "comment": "Used on slab"
}
```

Create transfer:

```json
{
  "sourceWarehouseId": "SOURCE_WAREHOUSE_ID",
  "destinationWarehouseId": "DESTINATION_WAREHOUSE_ID",
  "materialId": "MATERIAL_ID",
  "quantity": "4.000000",
  "occurredAt": "2026-09-14",
  "comment": "Move to site store"
}
```

Cancel operation:

```json
{ "reason": "Incorrect posting" }
```

## Response Notes

Decimals are serialized as strings. Do not parse them as JavaScript `number` for accounting arithmetic.

Example write-off response:

```json
{
  "id": "WRITE_OFF_ID",
  "projectId": "PROJECT_ID",
  "warehouseId": "WAREHOUSE_ID",
  "materialId": "MATERIAL_ID",
  "quantity": "2.000000",
  "unitCostUzs": "100.00000000",
  "totalCostUzs": "200.00000000",
  "occurredAt": "2026-09-14T00:00:00.000Z",
  "cancelledAt": null
}
```

Paginated list endpoints return:

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "pageSize": 20
}
```

## Idempotency

Mutating financial and inventory operation endpoints require `Idempotency-Key`.

- Same key plus same payload: returns the already-created operation.
- Same key plus different payload: `409 IDEMPOTENCY_KEY_REUSED`.
- Concurrent duplicate requests with the same key create one business effect.

## Stable Error Codes

Common codes the frontend should handle:

- `VALIDATION_ERROR`
- `UNAUTHENTICATED`
- `FORBIDDEN`
- `NOT_FOUND`
- `INSUFFICIENT_STOCK`
- `IDEMPOTENCY_KEY_REUSED`
- `CANCELLATION_HAS_DEPENDENCIES`
- `PURCHASE_HAS_DEPENDENT_MOVEMENTS`
- `CROSS_PROJECT_TRANSFER_FORBIDDEN`
- `CONCURRENT_MODIFICATION`
- `DATABASE_ERROR`

The server maps raw Prisma and SQL errors to stable response bodies; do not depend on database error text.

## Phase 8 Inventory Rules

Write-offs use the current warehouse/material weighted average at posting time and snapshot `unitCostUzs` plus `totalCostUzs`. Later purchases do not change historical write-off cost.

Transfers create two immutable movements, `TRANSFER_OUT` and `TRANSFER_IN`, linked to one `WarehouseTransfer`. The destination receives the exact value removed from the source.

Full depletion explicitly sets quantity and carrying value to zero. Partial depletion preserves the remaining average cost.

## Not Implemented Yet

- Attachment uploads.
- Complete audit history UI API, beyond the backend audit rows written by operations.
- Analytics.
- XLSX reports.
- Final production hardening and deployment runbook.
