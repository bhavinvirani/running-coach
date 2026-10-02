// One flat config for the whole repo. Encodes the standards in CLAUDE.md:
// package boundaries, kebab-case files, token-only Tailwind, pure engine and shared, env read in one file.
import js from "@eslint/js";
import betterTailwindcss from "eslint-plugin-better-tailwindcss";
import boundaries from "eslint-plugin-boundaries";
import checkFile from "eslint-plugin-check-file";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import path from "node:path";
import tseslint from "typescript-eslint";

const ioModules = [
  "node:*",
  "fs",
  "fs/*",
  "path",
  "http",
  "https",
  "net",
  "child_process",
  "crypto",
  "os",
  "pg",
  "drizzle-orm",
  "drizzle-orm/*",
  "express",
  "react",
  "react-dom",
];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/",
      "**/dist/",
      "**/dev-dist/",
      "**/coverage/",
      "**/playwright-report/",
      "**/test-results/",
      "services/",
      "spikes/",
      "reference/",
      "packages/shared/src/json-schema/",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/only-throw-error": "error",
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // command-line scripts report to the terminal
    files: ["**/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },

  // Naming: kebab-case files and folders; Python is ruff's job.
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    plugins: { "check-file": checkFile },
    rules: {
      "check-file/filename-naming-convention": [
        "error",
        { "**/*.{ts,tsx}": "KEBAB_CASE" },
        { ignoreMiddleExtensions: true },
      ],
      "check-file/folder-naming-convention": [
        "error",
        { "{apps,packages}/*/{src,test,e2e}/**/": "KEBAB_CASE" },
      ],
    },
  },

  // Package and layer boundaries.
  {
    files: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
    plugins: { boundaries },
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          noWarnOnMultipleProjects: true,
          project: ["apps/*/tsconfig.json", "packages/*/tsconfig.json"],
        },
      },
      "boundaries/include": ["apps/**/*", "packages/**/*"],
      "boundaries/elements": [
        { type: "shared", pattern: "packages/shared" },
        { type: "engine", pattern: "packages/engine" },
        { type: "web", pattern: "apps/web" },
        { type: "api-route", pattern: "apps/api/src/routes" },
        { type: "api-db", pattern: "apps/api/src/db" },
        { type: "api", pattern: "apps/api" },
      ],
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          message:
            "{{from.element.types.[0]}} must not import {{to.element.types.[0]}} (CLAUDE.md boundaries)",
          policies: [
            { allow: { dependency: { relationship: { to: "internal" } } } },
            {
              from: { element: { type: "engine" } },
              allow: { to: { element: { type: "shared" } } },
            },
            {
              from: { element: { type: "web" } },
              allow: { to: { element: { types: ["shared", "engine"] } } },
            },
            {
              from: { element: { types: ["api", "api-route", "api-db"] } },
              allow: {
                to: { element: { types: ["shared", "engine", "api", "api-db", "api-route"] } },
              },
            },
            {
              from: { element: { type: "api-route" } },
              disallow: { to: { element: { type: "api-db" } } },
              message: "Routes never touch the database; call a service.",
            },
            { allow: { to: { module: { origin: ["external", "core"] } } } },
          ],
        },
      ],
    },
  },

  // shared and engine: no I/O, React or Node modules.
  {
    files: ["packages/shared/src/**/*.ts", "packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ioModules,
              message: "shared and engine are pure: no I/O, React or Node modules.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "No I/O in shared or engine." },
        { name: "process", message: "No environment access in shared or engine." },
      ],
    },
  },
  {
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='Date'][property.name='now']",
          message: "Pass the date in; the engine is deterministic.",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "Pass the date in; the engine is deterministic.",
        },
        {
          selector: "MemberExpression[object.name='Math'][property.name='random']",
          message: "Pass randomness in; the engine is deterministic.",
        },
      ],
    },
  },

  // API: environment variables are read once, in src/lib/config.ts.
  {
    files: ["apps/api/src/**/*.ts"],
    ignores: ["apps/api/src/lib/config.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read configuration from src/lib/config.ts.",
        },
      ],
    },
  },

  // Web: React rules, token-only Tailwind, no raw colors or inline styles.
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
    },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "better-tailwindcss": betterTailwindcss },
    settings: {
      // Absolute paths so the rules resolve Tailwind from apps/web whether ESLint runs from the root or the package.
      "better-tailwindcss": {
        cwd: path.join(import.meta.dirname, "apps/web"),
        entryPoint: path.join(import.meta.dirname, "apps/web/src/styles/globals.css"),
      },
    },
    rules: {
      "better-tailwindcss/no-unknown-classes": "error",
      "better-tailwindcss/no-conflicting-classes": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
      "better-tailwindcss/no-restricted-classes": [
        "error",
        {
          restrict: [
            {
              pattern: "-\\[[^\\]]+\\](/\\S+)?$",
              message: "Arbitrary values are banned; use a design token.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
          message: "Raw colors are banned; use a token from src/styles/tokens.css.",
        },
        {
          selector: "JSXAttribute[name.name='style']",
          message: "Inline styles are banned; use token classes.",
        },
      ],
    },
  },
  {
    // shadcn copies keep the structural arbitrary values they need (tailwind-tokens.md).
    files: ["apps/web/src/components/ui/**/*.tsx"],
    rules: {
      "better-tailwindcss/no-restricted-classes": "off",
      "react-refresh/only-export-components": "off",
    },
  },
);
