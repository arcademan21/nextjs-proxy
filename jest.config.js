module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.ts", "**/test/**/*.js"],
  moduleFileExtensions: ["ts", "js", "json"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
  },
  // Optional: ignore the dist directory and node_modules
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  // Coverage is collected from the library source only (type-only shims and the
  // trivial re-export entry point carry no logic worth measuring).
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/index.ts"],
  // Quality gate: CI fails if coverage regresses below these floors. Set with
  // margin under the current numbers (proxy.ts ~88% stmts / ~83% branch) so the
  // suite stays honest without being brittle.
  coverageThreshold: {
    global: {
      statements: 80,
      branches: 75,
      functions: 90,
      lines: 85,
    },
  },
};
