import type { ReactNode } from "react";

/**
 * A card of related settings with its title inside, rows divided by hairlines: the Garmin and Claude
 * screens. SettingsRow is also Account's email row on Settings.
 */
export function SettingsCard({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-md border border-line bg-surface-1 px-4">
      {title ? <h2 className="pt-4 text-body font-semibold text-ink">{title}</h2> : null}
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </section>
  );
}

/** Label on the left, value on the right, one line high. */
export function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-4 py-3">
      <span className="shrink-0 text-body text-ink-2">{label}</span>
      <span className="min-w-0 truncate text-right text-body text-ink">{children}</span>
    </div>
  );
}
