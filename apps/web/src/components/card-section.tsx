import type { ReactNode } from "react";

/**
 * A group of rows on a detail screen: its heading above a surface-1 card, rows divided by hairlines. The
 * goal form's fields, the workout builder's steps, and a session's steps and Garmin state.
 */
export function CardSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <h2 className="text-body font-semibold text-ink">{title}</h2>
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {children}
      </div>
    </section>
  );
}
