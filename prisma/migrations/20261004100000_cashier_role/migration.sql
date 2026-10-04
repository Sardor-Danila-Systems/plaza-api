-- A project-scoped employee who runs the cash ledger and nothing else.
--
-- Its own migration on purpose: PostgreSQL will not let a newly added enum
-- value be used (here: compared against in the CHECK constraint below) in
-- the same transaction that added it, so the constraint change lives in
-- the next migration.
ALTER TYPE "Role" ADD VALUE 'CASHIER';
