/**
 * Operator provisioning CLI — the only way to create a project, create a
 * user account, or assign/reassign a project's manager (ADR 0014:
 * deliberately not an HTTP endpoint, since no role in this system is a
 * legitimate "project administrator", and there is no self-registration).
 *
 * Boots the real Nest application context (same PrismaService, same
 * validated config, same Prisma models the HTTP server uses) so this tool
 * can never drift from the running application's behavior — it just never
 * gets wired to a controller. Works identically with NODE_ENV=production —
 * unlike `prisma/seed.ts`, which deliberately refuses to run there.
 *
 * MUST be run from the compiled output (`npm run build`), not via `tsx`
 * directly — see docs/adr/0015-cli-tools-requiring-nest-di-must-run-compiled.md.
 * `npm run provision` below does this for you.
 *
 * Usage:
 *   npm run build
 *   npm run provision -- create-project --name "Avenue Plaza" --code avenue-plaza
 *   npm run provision -- assign-manager --project avenue-plaza --user manager@example.com
 *   npm run provision -- set-role --user someone@example.com --role ACCOUNTANT
 *   npm run provision -- set-role --user someone@example.com --role PROJECT_MANAGER --project avenue-plaza
 *   npm run provision -- rename-project --project avenue-plaza --name "Avenue Plaza (renamed)"
 *   CREATE_USER_PASSWORD='...' npm run provision -- create-user --role OWNER --email owner@example.com --name "Jane Doe"
 *   npm run provision -- --help
 *
 * Project/user may be identified by UUID or by code/email respectively.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { PrismaService } from '../database/prisma.service.js';
import { Role } from '../generated/prisma/client.js';
import { ProjectProvisioningService } from '../modules/projects/project-provisioning.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function printHelp(): void {
  console.log(`Operator provisioning CLI — production-safe project/user administration.
No self-registration and no HTTP admin endpoint exist (ADR 0014); this is
the only way to provision accounts, and it works with NODE_ENV=production.

Usage:
  npm run build
  npm run provision -- <command> [--flag value ...]

Commands:
  create-project --name <name> --code <code> [--timezone <IANA tz>]

  assign-manager --project <code|uuid> --user <email|uuid>

  set-role --user <email|uuid> --role <OWNER|ACCOUNTANT|PROJECT_MANAGER> [--project <code|uuid>]
      --project is required (and only allowed) when --role is PROJECT_MANAGER.

  rename-project --project <code|uuid> --name <name>

  create-user --role <OWNER|ACCOUNTANT|PROJECT_MANAGER> --email <email> --name <display name> [--project <code|uuid>]
      Creates a new account. --project is required (and only allowed) when
      --role is PROJECT_MANAGER; assigning it displaces any current active
      manager of that project, exactly like assign-manager.

      The password is read ONLY from the CREATE_USER_PASSWORD environment
      variable — never pass it as a --flag, which would leak into shell
      history and process listings. Minimum 12 characters. Never printed.

      Example:
        CREATE_USER_PASSWORD='a long random passphrase' \\
          npm run provision -- create-user \\
          --role OWNER --email owner@example.com --name "Jane Doe"

        CREATE_USER_PASSWORD='...' npm run provision -- create-user \\
          --role PROJECT_MANAGER --email pm@example.com --name "PM Name" \\
          --project avenue-plaza

  --help, help          Show this message.
`);
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) {
      throw new Error(`Expected a --flag, got "${key}"`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${key}`);
    }
    result[key.slice(2)] = value;
  }
  return result;
}

function requireArg(args: Record<string, string>, name: string): string {
  const value = args[name];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

async function resolveProjectId(
  prisma: PrismaService,
  identifier: string,
): Promise<string> {
  if (UUID_PATTERN.test(identifier)) return identifier;
  const project = await prisma.client.project.findUnique({
    where: { code: identifier },
  });
  if (!project) throw new Error(`No project with code "${identifier}"`);
  return project.id;
}

async function resolveUserId(
  prisma: PrismaService,
  identifier: string,
): Promise<string> {
  if (UUID_PATTERN.test(identifier)) return identifier;
  const user = await prisma.client.user.findUnique({
    where: { email: identifier.toLowerCase() },
  });
  if (!user) throw new Error(`No user with email "${identifier}"`);
  return user.id;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  // Checked before booting the Nest app context (no DB connection, no
  // config validation) so `--help` works even in a broken/unconfigured
  // environment — the one case this tool must never fail to explain itself.
  if (command === '--help' || command === 'help' || command === undefined) {
    printHelp();
    return;
  }

  const args = parseArgs(rest);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const provisioning = app.get(ProjectProvisioningService);

    switch (command) {
      case 'create-project': {
        const project = await provisioning.createProject({
          name: requireArg(args, 'name'),
          code: requireArg(args, 'code'),
          timezone: args.timezone,
        });
        console.log(`Created project ${project.id} (${project.code})`);
        break;
      }
      case 'assign-manager': {
        const projectId = await resolveProjectId(
          prisma,
          requireArg(args, 'project'),
        );
        const userId = await resolveUserId(prisma, requireArg(args, 'user'));
        await provisioning.assignManager(projectId, userId);
        console.log(
          `Assigned ${args.user} as PROJECT_MANAGER of ${args.project}`,
        );
        break;
      }
      case 'set-role': {
        const userId = await resolveUserId(prisma, requireArg(args, 'user'));
        const role = requireArg(args, 'role') as Role;
        if (!Object.values(Role).includes(role)) {
          throw new Error(
            `--role must be one of: ${Object.values(Role).join(', ')}`,
          );
        }
        const projectId = args.project
          ? await resolveProjectId(prisma, args.project)
          : undefined;
        await provisioning.setRole(userId, role, projectId);
        console.log(
          `Set ${args.user}'s role to ${role}${args.project ? ` (project ${args.project})` : ''}`,
        );
        break;
      }
      case 'create-user': {
        const role = requireArg(args, 'role') as Role;
        if (!Object.values(Role).includes(role)) {
          throw new Error(
            `--role must be one of: ${Object.values(Role).join(', ')}`,
          );
        }
        const email = requireArg(args, 'email');
        const displayName = requireArg(args, 'name');

        // Deliberately NOT a --flag: shell history and `ps` both expose
        // command-line arguments, but not a process's own environment
        // unless the operator's shell config already leaks it — see the
        // CREATE_USER_PASSWORD note in --help.
        const password = process.env.CREATE_USER_PASSWORD;
        if (!password) {
          throw new Error(
            'Missing CREATE_USER_PASSWORD environment variable. Set it and ' +
              're-run — the password is never accepted as a --flag. Run ' +
              '`npm run provision -- --help` for an example.',
          );
        }

        if (role !== Role.PROJECT_MANAGER && args.project) {
          throw new Error(
            `--project must not be supplied when --role is ${role}`,
          );
        }
        const projectId =
          role === Role.PROJECT_MANAGER
            ? await resolveProjectId(prisma, requireArg(args, 'project'))
            : undefined;

        const user = await provisioning.createUser({
          email,
          displayName,
          password,
          role,
          projectId,
        });
        console.log(
          `Created ${user.role} ${user.email} (${user.id})` +
            (user.projectId ? ` — project ${user.projectId}` : ''),
        );
        break;
      }
      case 'rename-project': {
        const projectId = await resolveProjectId(
          prisma,
          requireArg(args, 'project'),
        );
        const project = await provisioning.renameProject(
          projectId,
          requireArg(args, 'name'),
        );
        console.log(`Renamed project ${project.id} to "${project.name}"`);
        break;
      }
      default:
        throw new Error(
          `Unknown command "${command}". Expected create-project | assign-manager | set-role | rename-project | create-user. Run with --help for usage.`,
        );
    }
  } finally {
    await app.close();
  }
}

await main();
