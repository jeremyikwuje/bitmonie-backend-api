// Global Jest setup — mocks ESM-only / native dependencies that otherwise
// break ts-jest when transitively imported. Runs before every test file via
// `setupFiles` in jest.config.ts.

// otplib is ESM-only and breaks the Jest CommonJS resolver when AuthService
// (or anything that imports AuthService) is loaded. Stubbing it here keeps
// every spec from having to repeat the same `jest.mock('otplib', ...)` block
// at the top. Tests that exercise real TOTP behaviour can still override
// this mock per-suite.
jest.mock('otplib', () => ({
  generateSecret: jest.fn().mockReturnValue('BASE32TESTSECRET'),
  generate:       jest.fn().mockResolvedValue('000000'),
  verify:         jest.fn().mockResolvedValue({ valid: true, delta: 0 }),
  generateURI:    jest.fn().mockReturnValue('otpauth://totp/Bitmonie:test%40example.com?secret=BASE32TESTSECRET&issuer=Bitmonie'),
}));
