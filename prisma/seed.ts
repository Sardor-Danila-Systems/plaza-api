/**
 * Development-only account/data provisioning. There is no self-registration
 * (docs/backend-architecture.md §9) — this script is the "controlled
 * seed/admin/CLI workflow" Phase 2 §20 requires instead. Refuses to run
 * against a production-configured environment. Safe to re-run (upserts by
 * email/code).
 *
 * Usage: npm run seed
 * Override the default dev passwords: SEED_OWNER_PASSWORD=... SEED_ACCOUNTANT_PASSWORD=...
 * SEED_MANAGER_PASSWORD=... npm run seed
 */
import 'dotenv/config';
import * as argon2 from 'argon2';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  Role,
  TransactionCategoryKind,
} from '../src/generated/prisma/client.js';

const DEV_DEFAULT_PASSWORD = 'ChangeMe123!DevOnly';

/** The standard expense categories every project starts with
 * (docs/backend-architecture.md §2: "Units and categories are project-owned
 * rows, seeded with useful defaults"). EXPENSE-kind: SALARY-type
 * transactions may optionally use the "Salaries" category too, the same way
 * any EXPENSE-type transaction can. Projects/managers can add more via
 * `POST P/transaction-categories`; this list is a starting point, not a
 * closed set. */
const STANDARD_EXPENSE_CATEGORIES = [
  'Materials',
  'Salaries',
  'Equipment',
  'Rent',
  'Delivery',
  'Transport',
  'Utilities',
  'Other',
];

/** Standard units of measure every project starts with
 * (docs/backend-data-model.md: "seeded project rows such as kg, bag, m²").
 * Not a closed set — this phase gives Unit no manager-writable creation
 * endpoint (§22), so seed data is the only source; extend this list here,
 * not via an ad-hoc migration, if a new standard unit is needed later. */
const STANDARD_UNITS: Array<{ symbol: string; name: string }> = [
  { symbol: 'шт', name: 'Piece' },
  { symbol: 'кг', name: 'Kilogram' },
  { symbol: 'м', name: 'Meter' },
  { symbol: 'м²', name: 'Square meter' },
  { symbol: 'м³', name: 'Cubic meter' },
  { symbol: 'л', name: 'Liter' },
  { symbol: 'т', name: 'Ton' },
  { symbol: 'бухта', name: 'Coil' },
  { symbol: 'лист', name: 'Sheet' },
  { symbol: 'рейс', name: 'Trip' },
];

function requireNonProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to run the development seed against NODE_ENV=production. ' +
        'Production accounts are provisioned through a separate audited ' +
        'operator workflow (see docs/backend-architecture.md §2), not this script.',
    );
  }
}

async function main(): Promise<void> {
  requireNonProduction();

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set to run the seed script.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  try {
    // Three example projects (docs/backend-architecture.md's product
    // overview names all three). Only Avenue Plaza gets an assigned manager
    // below — Margilon and Palma exist so OWNER/ACCOUNTANT list/read
    // behavior and PROJECT_MANAGER project-isolation have more than one
    // project to actually demonstrate isolation against.
    const [avenuePlaza, margilonPlaza, palmaPlaza] = await Promise.all([
      prisma.project.upsert({
        where: { code: 'avenue-plaza' },
        create: { name: 'Avenue Plaza', code: 'avenue-plaza' },
        update: {},
      }),
      prisma.project.upsert({
        where: { code: 'margilon-plaza' },
        create: { name: 'Margilon Plaza', code: 'margilon-plaza' },
        update: {},
      }),
      prisma.project.upsert({
        where: { code: 'palma-plaza' },
        create: { name: 'Palma Plaza', code: 'palma-plaza' },
        update: {},
      }),
    ]);
    const project = avenuePlaza;

    for (const seededProject of [avenuePlaza, margilonPlaza, palmaPlaza]) {
      for (const name of STANDARD_EXPENSE_CATEGORIES) {
        await prisma.transactionCategory.upsert({
          where: {
            projectId_kind_name: {
              projectId: seededProject.id,
              kind: TransactionCategoryKind.EXPENSE,
              name,
            },
          },
          create: {
            projectId: seededProject.id,
            kind: TransactionCategoryKind.EXPENSE,
            name,
          },
          update: {},
        });
      }
      console.log(
        `Seeded ${STANDARD_EXPENSE_CATEGORIES.length} standard expense categories for ${seededProject.name}`,
      );

      for (const unit of STANDARD_UNITS) {
        await prisma.unit.upsert({
          where: {
            projectId_symbol: { projectId: seededProject.id, symbol: unit.symbol },
          },
          create: { projectId: seededProject.id, symbol: unit.symbol, name: unit.name },
          update: { name: unit.name },
        });
      }
      console.log(
        `Seeded ${STANDARD_UNITS.length} standard units for ${seededProject.name}`,
      );
    }

    const accounts: Array<{
      email: string;
      displayName: string;
      role: Role;
      passwordEnvVar: string;
      projectId: string | null;
    }> = [
      {
        email: 'owner@euro-plaza.example',
        displayName: 'Seed Owner',
        role: Role.OWNER,
        passwordEnvVar: 'SEED_OWNER_PASSWORD',
        projectId: null,
      },
      {
        email: 'accountant@euro-plaza.example',
        displayName: 'Seed Accountant',
        role: Role.ACCOUNTANT,
        passwordEnvVar: 'SEED_ACCOUNTANT_PASSWORD',
        projectId: null,
      },
      {
        email: 'manager@euro-plaza.example',
        displayName: 'Seed Project Manager',
        role: Role.PROJECT_MANAGER,
        passwordEnvVar: 'SEED_MANAGER_PASSWORD',
        projectId: project.id,
      },
    ];

    for (const account of accounts) {
      const password =
        process.env[account.passwordEnvVar] ?? DEV_DEFAULT_PASSWORD;
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
      });

      await prisma.user.upsert({
        where: { email: account.email },
        create: {
          email: account.email,
          displayName: account.displayName,
          role: account.role,
          passwordHash,
          projectId: account.projectId,
        },
        update: {
          displayName: account.displayName,
          role: account.role,
          passwordHash,
          projectId: account.projectId,
        },
      });

      const usingDefault = process.env[account.passwordEnvVar] === undefined;
      console.log(
        `Seeded ${account.role} ${account.email}${
          usingDefault
            ? ` (dev default password — set ${account.passwordEnvVar} to override)`
            : ''
        }`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

await main();
