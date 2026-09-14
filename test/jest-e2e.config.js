/**
 * Same ESM rationale as jest.config.js. e2e tests boot a real Nest
 * application against a real PostgreSQL database (see README "Tests") —
 * Prisma is never mocked here, per docs/backend-architecture.md §12.
 *
 * @type {import('jest').Config}
 */
export default {
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        module: { type: 'es6' },
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
      },
    ],
  },
  setupFiles: ['reflect-metadata'],
  testTimeout: 30000,
};
