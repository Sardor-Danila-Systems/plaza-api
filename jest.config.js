/**
 * Jest runs in real ESM mode (`--experimental-vm-modules`, see the "test"
 * script in package.json), not the more common "transform TS to CommonJS"
 * setup. This is required, not a stylistic choice: Prisma ORM v7's generated
 * client (src/generated/prisma/client.ts) uses `import.meta.url`, which does
 * not exist under CommonJS — a `require()`-based Jest config cannot load it
 * at all. See docs/phase-0-review.md's Phase 1 addendum for the verification
 * behind this choice.
 *
 * @type {import('jest').Config}
 */
export default {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/src/**/*.spec.ts'],
  // Nest's decorators (and class-transformer/class-validator's) rely on
  // `reflect-metadata` being loaded before any decorated class is imported.
  // Nest's own CLI bootstrap does this implicitly; Jest needs it explicit.
  setupFiles: ['reflect-metadata'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    // Source uses NodeNext-style explicit ".js" extensions on relative
    // imports (required at runtime); Jest's resolver needs the ".ts" source
    // file, so this strips the extension before resolution.
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
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/generated/**',
  ],
};
