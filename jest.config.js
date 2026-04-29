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
    'client/**/*.js',
    'engine/**/*.js',
    'storage/**/*.js',
    'utils/**/*.js',
    '!**/test.js',
    '!**/*.test.js'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov', 'json-summary', 'json'],
  verbose: true,
  testTimeout: 30000
};
