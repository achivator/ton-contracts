import type { Config } from 'jest';

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/dist/'],
    // MiniappIntegration.spec.ts requires the miniapp voucher lib (plain CJS
    // that requires @ton/core + @ton/crypto on its own). Pin those to this
    // package so the lib and the sandbox share a single copy of the
    // Cell/Address classes — otherwise instanceof checks and BOC parsing
    // across two different @ton/core versions break.
    moduleNameMapper: {
        '^@ton/core$': '<rootDir>/node_modules/@ton/core',
        '^@ton/crypto$': '<rootDir>/node_modules/@ton/crypto',
    },
};

export default config;
