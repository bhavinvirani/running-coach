import type { CoachDetail } from "@running-coach/shared";
import { useMe, useUpdateSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";

/** Everything the Coach detail screen reads and does: how much the coach writes, and changing it. */
export function useCoachDetailScreen() {
  const me = useMe();
  const update = useUpdateSettings();

  return {
    ...screenState(me),
    /** The level in flight, shown at once so a tap never looks ignored. */
    pending: update.isPending ? update.variables.coachDetail : undefined,
    updateError: update.error,
    choose: (coachDetail: CoachDetail) => update.mutate({ coachDetail }),
  };
}
