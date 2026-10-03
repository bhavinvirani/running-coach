import { sessionTarget } from "@running-coach/engine";
import {
  distanceInUnits,
  type PlanPaces,
  type SessionSteps,
  type Units,
} from "@running-coach/shared";
import { DotLine } from "@/components/dot-line";
import { describeSteps } from "@/lib/describe-steps";
import { formatDistance, formatDuration } from "@/lib/format";
import { builderCopy } from "../builder-copy";

type WorkoutSummaryProps = {
  /** Null while a step is unfinished: the last whole summary would be wrong, so none shows. */
  steps: SessionSteps | null;
  paces: PlanPaces;
  units: Units;
};

/**
 * The workout as one line, as the plan shows it, with its total distance and time from the engine's
 * sessionTarget at the plan's paces: the same numbers the API will store.
 */
export function WorkoutSummary({ steps, paces, units }: WorkoutSummaryProps) {
  if (steps === null) return null;
  const target = sessionTarget(steps, paces);

  return (
    <section
      aria-label={builderCopy.summary}
      className="flex flex-col gap-1 rounded-md bg-surface-1 p-4"
    >
      <DotLine className="text-body font-semibold text-ink">
        {formatDistance(distanceInUnits(target.distanceM, units), units)}
        {formatDuration(target.durationS)}
      </DotLine>
      <p className="text-body text-ink-2">{describeSteps(steps, paces, units)}</p>
    </section>
  );
}
