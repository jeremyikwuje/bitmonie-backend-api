import type { Config } from 'jest';

const base: Partial<Config> = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  rootDir: '.',
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
  // Stubs ESM-only deps (e.g. otplib) before any import resolves them.
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  clearMocks: true,
};

const config: Config = {
  ...base,
  projects: [
    {
      ...base,
      displayName: 'unit',
      testMatch: ['<rootDir>/test/unit/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.spec.ts'],
    },
    {
      ...base,
      displayName: 'e2e',
      testMatch: ['<rootDir>/test/e2e/**/*.e2e-spec.ts'],
    },
  ],
  collectCoverageFrom: ['src/**/*.{ts,js}', '!src/**/*.module.ts', '!src/main.ts'],
  coverageDirectory: 'coverage',
};

export default config;
