module.exports = {
  preset: '@react-native/jest-preset',
  moduleNameMapper: {
    '^@web/lib/http$': '<rootDir>/src/lib/http.ts',
    '^@web/(.*)$': '<rootDir>/../web/src/$1',
    '^@dorkar/contracts/(.*)$': '<rootDir>/../../packages/contracts/src/$1.ts',
    '^@dorkar/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^zod$': '<rootDir>/node_modules/zod',
  },
};
