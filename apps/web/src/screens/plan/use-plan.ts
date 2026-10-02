import { useSettings } from "@/api/me";
import { usePlan } from "@/api/plan";
import { screenState } from "@/api/screen-state";
import { today } from "@/lib/dates";

/**
 * Everything Plan reads: the goal and its plan, the units to show them in, and today in the runner's time
 * zone, which picks the week whose card is selected. Units and zone come from /api/me, which the
 * authenticated loader caches before any tab renders.
 */
export function usePlanScreen() {
  const plan = usePlan();
  const settings = useSettings();

  return {
    ...screenState(plan),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
  };
}
