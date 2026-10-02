---
name: ui-component
description: Use when adding or restyling a shared component in apps/web/src/components, including shadcn copies, cva variants and token classes.
---
# UI component

Copy `apps/web/src/components/stat.tsx` (big figure, small label) for a new component, or `apps/web/src/components/ui/button.tsx` for a restyled shadcn copy. `tailwind-tokens.md` in this folder explains the token-only Tailwind setup and why `bg-red-500` or `p-[13px]` fail lint.

1. shadcn primitive: `pnpm dlx shadcn@latest add <name>` into `src/components/ui/`, then in the same commit replace every default color, radius, shadow and size with a token class and delete the variants the app does not use; structural arbitrary values the copy needs (`w-(--sidebar-width)`, `data-[state=open]:`) may stay because lint exempts `components/ui/` alone. A default-styled shadcn component is never imported.
2. Own component: typed props, no fetching, no number formatting (callers use `src/lib/format.ts`), one job, a `*.test.tsx` for rendering and interaction.
3. Classes: token utilities only; variants with `cva`; no inline `style` with values.
4. Tabular figures are inherited from `body`; never override `font-variant-numeric`.
5. Every interactive element: visible `accent` focus ring, hit target at least 44 px, a text label (an icon alone is not a label).
