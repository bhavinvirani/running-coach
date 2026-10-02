import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type RunSectionProps = {
  title: string;
  children: ReactNode;
  /** Spacing from what comes before it: "mt-2" for the first section under the stats. */
  className?: string;
};

/**
 * One part of the run below the stats: its heading, then its content on a surface-1 card, named for
 * screen readers by the heading.
 */
export function RunSection({ title, children, className }: RunSectionProps) {
  return (
    <section aria-label={title} className={cn("flex flex-col gap-2", className)}>
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      <div className="flex flex-col gap-3 rounded-md bg-surface-1 p-4">{children}</div>
    </section>
  );
}

/** One sentence where a part of the run has nothing to show, saying why. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-body text-ink-2">{children}</p>;
}
