import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge reads any unknown `text-*` as a color, so `text-figure text-ink` would lose one of the two.
// Registering the type-scale tokens as font sizes keeps size and color independent.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["caption", "body", "title", "figure", "figure-lg"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
