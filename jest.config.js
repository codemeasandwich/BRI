/**
 * @file Jest runner configuration for BRI — Node ESM, coverage collection globs,
 *       and integration test discovery under tests/.
 */
export default {
  testEnvironment: 'node',
  transform: {},
  moduleFileExtensions: ['js'],
  testMatch: ['**/tests/**/*.test.js'],
  collectCoverageFrom: [
    'src/client/**/*.js',
    'src/engine/**/*.js',
    'src/storage/**/*.js',
    'src/utils/**/*.js',
    '!**/test.js',
    '!**/*.test.js',
    // Pure barrel (import/export only) — instrumentation produces 0 executable spans; callers cover `bri.js` / `defer-database.js` directly from the package root.
    '!**/src/client/index.js'
  ],
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100
    }
  },
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json-summary', 'json'],
  verbose: true,
  testTimeout: 30000,
  globalTeardown: './tests/jest/global-teardown.js'
};
