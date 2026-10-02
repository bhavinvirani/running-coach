import { cn } from "@/lib/cn";

type StatProps = {
  /** Sentence case: "Avg pace". */
  label: string;
  /** Already formatted by src/lib/format.ts: "5:13". */
  value: string;
  /** Shown small after the value: "/km", "bpm". */
  unit?: string;
  className?: string;
};

/** One number that matters: small label above, big tabular figure, optional small unit. */
export function Stat({ label, value, unit, className }: StatProps) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-caption text-ink-2">{label}</span>
      <span className="text-figure text-ink">
        {value}
        {unit ? <span className="ml-1 text-caption text-ink-2">{unit}</span> : null}
      </span>
    </div>
  );
}
