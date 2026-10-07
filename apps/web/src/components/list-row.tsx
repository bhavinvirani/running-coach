import { ChevronRight, type LucideIcon } from "lucide-react";
import { Link } from "react-router";

type ListRowProps = {
  to: string;
  /** The one leading icon, decorative: the label names the row. */
  icon: LucideIcon;
  /** Sentence case: "Heart-rate zones". */
  label: string;
  /** What the row's screen holds now, already in words: "Kilometers", "Login expired". */
  value?: string;
};

/**
 * One row of a Settings card that opens a screen: icon, label, the current value on the right and a
 * chevron, on a surface-1 card (CardSection). Named label then value, so a screen reader hears
 * "Units, Kilometers". The wrapper takes the card's hairline, so the tap feedback can reach past the
 * text without the hairline reaching past the others.
 */
export function ListRow({ to, icon: Icon, label, value }: ListRowProps) {
  return (
    <div>
      <Link
        to={to}
        aria-label={value ? `${label}, ${value}` : label}
        className="-mx-2 flex min-h-12 items-center gap-3 rounded-sm px-2 py-3 active:bg-surface-2"
      >
        <Icon aria-hidden="true" className="size-5 shrink-0 text-ink" strokeWidth={1.75} />
        <span className="min-w-0 flex-1 truncate text-body text-ink">{label}</span>
        {value ? <span className="shrink-0 text-right text-body text-ink-2">{value}</span> : null}
        <ChevronRight
          aria-hidden="true"
          className="size-5 shrink-0 text-ink-3"
          strokeWidth={1.75}
        />
      </Link>
    </div>
  );
}
