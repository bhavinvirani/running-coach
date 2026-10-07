// shadcn new-york-v4 checkbox, restyled to tokens: a 20 px ink-3 box (non-text) with the sm radius that turns
// ink with an ink check when checked, like RadioGroupItem, since accent stays for the primary action
// (web-ui.md). The caller's label row gives the 44 px hit target. Removed: border-input, the primary fill and
// text-primary-foreground, shadow-xs, transition-shadow, outline-none and the ring utilities (the global
// accent focus ring from globals.css shows instead), the destructive aria-invalid styles (an error is a
// sentence with role="alert", not a red box) and dark:bg-input/30 (dark only).
import { CheckIcon } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/cn";

function Checkbox({ className, ...props }: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer size-5 shrink-0 rounded-sm border-2 border-ink-3 text-ink disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-ink",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3.5" strokeWidth={3} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
