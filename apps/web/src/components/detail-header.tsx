import type { ReactNode } from "react";
import { BackLink } from "./back-link";

type DetailHeaderProps = {
  title: string;
  /** Where Back goes when the screen was opened from a link or bookmark (BackLink). */
  backTo: string;
};

/** A detail screen's header: Back top left, the title centered. */
export function DetailHeader({ title, backTo }: DetailHeaderProps) {
  return (
    <header className="relative flex min-h-11 items-center justify-center">
      <BackLink to={backTo} />
      <h1 className="text-title text-ink">{title}</h1>
    </header>
  );
}

type DetailLayoutProps = DetailHeaderProps & {
  children: ReactNode;
  /** True while the screen draws its skeleton. */
  busy?: boolean;
};

/** A detail screen: its header, then its content, spaced like the tab screens. */
export function DetailLayout({ title, backTo, busy, children }: DetailLayoutProps) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <DetailHeader title={title} backTo={backTo} />
      {children}
    </div>
  );
}
