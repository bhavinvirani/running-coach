# Tailwind tokens and lint (verified 2026-10-01 on Tailwind 4.3.3, eslint-plugin-better-tailwindcss 4.7.0)

## Only token utilities exist

In the web globals.css, before shadcn's `@theme inline` block:

```css
@import "tailwindcss";
@theme {
  --color-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --color-white: #fff;   /* shadcn uses bg-black/50, bg-white, text-white */
  --color-black: #000;
  /* project tokens follow: --color-bg, --color-fg, --color-accent, --text-body, --radius-md, ... */
}
```

Effect: the compiler refuses `bg-red-500`, `text-sm` and `hover:bg-red-500` (no CSS generated) and the linter reports them as unknown. Spacing stays a multiplier of `--spacing` (4px), so `p-13` is valid; add a step allowlist only if an audit finds off-scale spacing.

## ESLint (flat config)

```js
settings: { "better-tailwindcss": { entryPoint: "apps/web/src/globals.css" } },
rules: {
  "better-tailwindcss/no-unknown-classes": "error",
  "better-tailwindcss/no-conflicting-classes": "error",
  "better-tailwindcss/no-duplicate-classes": "error",
  "better-tailwindcss/no-restricted-classes": ["error", { restrict: [
    { pattern: "-\\[[^\\]]+\\](/\\S+)?$", message: "Arbitrary values are banned; use a design token." },
  ]}],
}
```

Verified: `text-[15px]`, `p-[13px]`, `bg-[#1a1a1a]` are reported; `data-[state=open]:bg-accent` and `w-(--sidebar-width)` pass. Exempt `components/ui/**` (shadcn copies use 127 arbitrary values) with a `files` override that turns off `no-restricted-classes`.
