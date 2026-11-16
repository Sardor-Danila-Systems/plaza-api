-- Бухгалтер (FINANCE) and кладовщик (WAREHOUSE). A separate migration from
-- the constraint change that uses them: PostgreSQL does not allow a new enum
-- value to be used in the same transaction that added it.
ALTER TYPE "Role" ADD VALUE 'FINANCE';
ALTER TYPE "Role" ADD VALUE 'WAREHOUSE';
