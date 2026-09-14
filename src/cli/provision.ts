/**
 * Operator provisioning CLI — the only way to create a project or assign/
 * reassign its manager (ADR 0014: deliberately not an HTTP endpoint, since
 * no role in this system is a legitimate "project administrator").
 *
 * Boots the real Nest application context (same PrismaService, same
 * validated config, same Prisma models the HTTP server uses) so this tool
 * can never drift from the running application's behavior — it just never
 * gets wired to a controller.
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
          `Unknown command "${command ?? ''}". Expected create-project | assign-manager | set-role | rename-project.`,
        );
    }
  } finally {
    await app.close();
  }
}

await main();
