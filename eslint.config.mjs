// ESLint 9 flat config. Lints the TypeScript source and tests with the
// typescript-eslint recommended ruleset. Build output, coverage reports and
// JavaScript config files are excluded.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "coverage/", "node_modules/", "*.config.js", "*.config.mjs"],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: "module" },
    },
  },
  // Type-shim declarations mirror Next.js internals that are themselves
  // untyped; `any` is the pragmatic, correct choice there.
  {
    files: ["**/*.d.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Tests use `any` to shape mocks and reach internals; not shipped code.
  {
    files: ["test/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
