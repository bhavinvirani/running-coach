// shadcn new-york-v4 button, restyled to tokens: primary (accent), secondary (surface-2), ghost.
// Removed: destructive, outline and link variants, xs/sm/icon sizes (below 44 px or icon-only),
// outline-none (the global accent focus ring from globals.css shows instead), transition-all.
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-body font-semibold whitespace-nowrap select-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-5",
  {
    variants: {
      variant: {
        primary: "bg-accent text-on-accent hover:bg-accent/90 active:bg-accent/80",
        secondary: "bg-surface-2 text-ink hover:bg-surface-2/80 active:bg-surface-2/60",
        ghost: "text-ink hover:bg-surface-1 active:bg-surface-2",
      },
      size: {
        default: "min-h-11 px-4",
        lg: "min-h-12 px-6",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "primary",
  size = "default",
  asChild = false,
  type = "button",
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
