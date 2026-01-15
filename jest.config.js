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
  coverageReporters: ['text', 'text-summary', 'html'],
  verbose: true,
  testTimeout: 30000
};
