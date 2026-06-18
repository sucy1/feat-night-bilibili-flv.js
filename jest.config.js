/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: [
        '**/tests/**/*.test.js'
    ],
    transform: {
        '^.+\\.(js|jsx)$': 'babel-jest'
    },
    transformIgnorePatterns: [
        'node_modules/(?!(webworkify-webpack)/)'
    ],
    setupFiles: [
        '<rootDir>/tests/setup.js'
    ],
    testTimeout: 10000
};
