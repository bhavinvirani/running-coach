import { useSettings } from "@/api/me";
import { usePlan } from "@/api/plan";
import { screenState } from "@/api/screen-state";

/**
 * Everything a plan week reads: the plan, from the same cache as the Plan tab, so a week opened from its
 * card shows at once, and the units to show it in, from /api/me, which the authenticated loader caches.
 */
export function usePlanWeekScreen() {
  const plan = usePlan();
  const settings = useSettings();

  return {
    ...screenState(plan),
    units: settings.data?.units,
  };
}
