// shadcn new-york-v4 radio-group, restyled to tokens: a 20 px ink-3 ring (non-text) that turns ink with an
// ink dot when checked, like SegmentedField, since accent stays for the primary action (web-ui.md).
// Removed: the root's grid gap (ChoiceList's rows carry their own padding), border-input and text-primary,
// shadow-xs, transition, outline-none and the ring utilities (the global accent focus ring from globals.css
// shows instead), the destructive aria-invalid styles (an error is a sentence with role="alert", not a red
// ring) and dark:bg-input/30 (dark only).
import { CircleIcon } from "lucide-react";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";
import type * as React from "react";
import { cn } from "@/lib/cn";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "aspect-square size-5 shrink-0 rounded-full border-2 border-ink-3 disabled:cursor-not-allowed disabled:opacity-50 aria-checked:border-ink",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="relative flex items-center justify-center"
      >
        <CircleIcon className="absolute top-1/2 left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 fill-ink text-ink" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
