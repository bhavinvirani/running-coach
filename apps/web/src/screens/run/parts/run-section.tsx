import type { ReactNode } from "react";

/** One part of the run below the stats, under a hairline, named for screen readers by its heading. */
export function RunSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3 border-t border-line pt-4">
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** One sentence where a part of the run has nothing to show, saying why. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-body text-ink-2">{children}</p>;
}
