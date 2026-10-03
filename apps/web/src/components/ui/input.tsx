// shadcn new-york-v4 input, restyled to tokens: surface-0 field on a surface-1 card, line border, sm radius,
// body text, at least 44 px high, no shadow. Removed: the file-input styles (no file fields), the
// destructive aria-invalid ring (an error is a sentence with role="alert", not a red border), md:text-sm,
// outline-none and the ring (the global accent focus ring from globals.css shows instead), transitions, and
// the placeholder color (no field has a placeholder, and ink-3 is for non-text).
import type * as React from "react";
import { cn } from "@/lib/cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-11 w-full min-w-0 rounded-sm border border-line bg-surface-0 px-3 text-body text-ink selection:bg-accent selection:text-on-accent disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
