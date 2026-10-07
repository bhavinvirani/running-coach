import { useSettings } from "@/api/me";
import { usePause } from "@/api/pause";
import { usePlan } from "@/api/plan";
import { screenState } from "@/api/screen-state";
import { today } from "@/lib/dates";

/**
 * Everything a plan week reads: the plan, from the same cache as the Plan tab, so a week opened from its
 * card shows at once, and the units to show it in, from /api/me, which the authenticated loader caches,
 * and today in the runner's time zone, from which days take Add. With a plan, the open pause too, from
 * whose start no day takes Add; the week shows without waiting for it.
 */
export function usePlanWeekScreen() {
  const plan = usePlan();
  const settings = useSettings();
  // Without a plan there is nothing to pause, nor a week to add to.
  const pause = usePause(plan.data?.plan != null);

  return {
    ...screenState(plan),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
    /**
     * The open pause's start, null without one, and also when the pause could not be read: the API still
     * refuses a workout dated in a pause. Undefined while it is read, when no day offers Add yet, so Add
     * never shows on a day it then leaves.
     */
    pauseStart: pause.isPending ? undefined : (pause.data?.pause?.startDate ?? null),
  };
}
