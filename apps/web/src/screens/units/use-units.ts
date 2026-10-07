import type { Units } from "@running-coach/shared";
import { useMe, useUpdateSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";

/** Everything the Units screen reads and does: the runner's unit, and changing it. */
export function useUnitsScreen() {
  const me = useMe();
  const update = useUpdateSettings();

  return {
    ...screenState(me),
    /** The unit in flight, shown at once so a tap never looks ignored. */
    pending: update.isPending ? update.variables.units : undefined,
    updateError: update.error,
    choose: (units: Units) => update.mutate({ units }),
  };
}
