import { runTypeName } from "@/lib/run-type";
import { SessionTypeChip } from "./session-type-chip";

type RunTypeChipProps = {
  /** Garmin's event type as stored on the run: "race", "training", ...; null when Garmin sent none. */
  eventType: string | null;
};

/**
 * The run's type as the plan's race chip, so a race reads at a glance on the run screen, in Progress and
 * on Today. Nothing for a run without a type the app shows.
 */
export function RunTypeChip({ eventType }: RunTypeChipProps) {
  return runTypeName(eventType) === null ? null : <SessionTypeChip type="race" />;
}
