module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["**/test/**/*.ts", "**/test/**/*.js"],
  moduleFileExtensions: ["ts", "js", "json"],
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.json",
    },
  },
  // Optional: ignore the dist directory and node_modules
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
};
