import { runTypeName } from "@/lib/run-type";

type RunTypeChipProps = {
  /** Garmin's event type as stored on the run: "race", "training", ...; null when Garmin sent none. */
  eventType: string | null;
};

/**
 * The run's type as a dot in its type color beside its name, so a race reads at a glance on the run
 * screen, in Progress and on Today. The type-* colors appear only beside a type's name (web-ui rule),
 * which this is. Nothing for a run without a type the app shows.
 */
export function RunTypeChip({ eventType }: RunTypeChipProps) {
  const name = runTypeName(eventType);
  if (name === null) return null;

  return (
    <span className="inline-flex items-center gap-2 text-body text-ink">
      <span aria-hidden="true" className="size-3 rounded-sm bg-type-race" />
      {name}
    </span>
  );
}
