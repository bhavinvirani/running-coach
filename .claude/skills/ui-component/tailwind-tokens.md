# Tailwind tokens and lint (verified 2026-10-01 on Tailwind 4.3.3, eslint-plugin-better-tailwindcss 4.7.0)

## Only token utilities exist

`apps/web/src/styles/tokens.css` imports Tailwind and resets every default theme namespace before defining the project's tokens:

```css
@import "tailwindcss";
@theme {
  --color-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --font-*: initial;
  --shadow-*: initial;
  --spacing: 4px;
  --color-white: #ffffff; /* shadcn copies reference these two */
  --color-black: #000000;
  /* project tokens follow: --color-surface-0, --color-ink, --color-accent, --text-body, --radius-md, ... */
}
```

`apps/web/src/styles/globals.css` is the Tailwind and ESLint entry point: it imports the font and `./tokens.css`, then adds base styles and the `pt-safe`/`pb-safe` and `scrollbar-none` (a sideways tile row without a scrollbar) utilities. There is no shadcn `@theme inline` block, and `components.json` sets `cssVariables: false`, so `shadcn add` cannot write its default palette into `globals.css`.

Effect: the compiler refuses `bg-red-500`, `text-sm` and `hover:bg-red-500` (no CSS generated) and the linter reports them as unknown. Spacing stays a multiplier of `--spacing` (4px), so `p-13` is valid; add a step allowlist only if an audit finds off-scale spacing.

## ESLint (root `eslint.config.js`, files `apps/web/src/**`)

```js
settings: { "better-tailwindcss": {
  // Absolute, so the rules find Tailwind from apps/web whether ESLint runs from the root or the package.
  cwd: path.join(import.meta.dirname, "apps/web"),
  entryPoint: path.join(import.meta.dirname, "apps/web/src/styles/globals.css"),
} },
rules: {
  "better-tailwindcss/no-unknown-classes": "error",
  "better-tailwindcss/no-conflicting-classes": "error",
  "better-tailwindcss/no-duplicate-classes": "error",
  "better-tailwindcss/no-restricted-classes": ["error", { restrict: [
    { pattern: "-\\[[^\\]]+\\](/\\S+)?$", message: "Arbitrary values are banned; use a design token." },
  ]}],
  // plus no-restricted-syntax: hex color literals and the JSX `style` prop
}
```

Without `cwd` the plugin, run from the root, cannot find Tailwind and turns its rules off; a relative `entryPoint` breaks when ESLint runs from `apps/web`.

Verified: `text-sm`, `text-[15px]`, `p-[13px]`, `bg-[#1a1a1a]` are reported; `data-[state=open]:bg-accent` and `w-(--sidebar-width)` pass. `apps/web/src/components/ui/**/*.tsx` (shadcn copies) is exempt from `no-restricted-classes` through a `files` override.
