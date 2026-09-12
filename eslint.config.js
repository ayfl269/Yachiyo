import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: [
      "src/**/*.ts",
      "tests/**/*.ts",
      "packages/*/src/**/*.ts",
      // React front-end sources (this change touched several .tsx files;
      // without this they had zero lint coverage).
      "frontend/src/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_",
        },
      ],
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // React Hooks rules for the front-end. Registers the `react-hooks`
    // plugin so the existing `// eslint-disable-next-line
    // react-hooks/exhaustive-deps` directives in frontend/src resolve
    // (without it ESLint 9 errors with "Definition for rule ... was not found").
    files: ["frontend/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // dist/ build output should not be linted
    ignores: [
      "packages/*/dist/**",
      "packages/*/node_modules/**",
      "dist/**",
      "node_modules/**",
      "frontend/dist/**",
      "frontend/node_modules/**",
    ],
  },
];
