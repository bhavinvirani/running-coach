import type { PlanChange, Units } from "@running-coach/shared";
import { adjustmentCopy, planChangeLine } from "@/lib/session-adjustment";

type PlanChangeTextProps = {
  change: PlanChange;
  units: Units;
};

/**
 * What the coach changed in the plan, from the engine's log rather than the coach's words: "Thu 8
 * Intervals 11.6 km → Easy 10.6 km", then a caption when the engine pulled the coach's proposal inside the
 * plan's caps. On the run's coach card and the weekly review card, inside their own block.
 */
export function PlanChangeText({ change, units }: PlanChangeTextProps) {
  return (
    <>
      <p className="text-body text-ink">{planChangeLine(change, units)}</p>
      {change.clamped ? <p className="text-caption text-ink-2">{adjustmentCopy.clamped}</p> : null}
    </>
  );
}
