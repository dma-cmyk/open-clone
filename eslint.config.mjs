import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import nextPlugin from "@next/eslint-plugin-next";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.next/**",
      "**/.next-e2e/**",
      "**/out/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/.turbo/**",
      "**/coverage/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.es2022,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  // web は React/Next 固有ルールを使う（コード側の eslint-disable 参照先）。
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
      "@next/next": nextPlugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "@next/next/no-img-element": "warn",
    },
  },
);