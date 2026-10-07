import type { HrZones } from "@running-coach/shared";
import { useHrZones, useResetHrZones, useSaveHrZones } from "@/api/hr-zones";
import { screenState } from "@/api/screen-state";

/** Everything the Heart-rate zones screen reads and does: the zones in use, saving and resetting them. */
export function useHrZonesScreen() {
  const zones = useHrZones();
  const save = useSaveHrZones();
  const reset = useResetHrZones();

  return {
    ...screenState(zones),
    saving: save.isPending,
    saveError: save.error,
    /** `onSaved` runs once the zones are stored, so the form can say so. */
    save: (body: HrZones, onSaved: () => void) => {
      reset.reset();
      save.mutate(body, { onSuccess: onSaved });
    },
    resetting: reset.isPending,
    resetError: reset.error,
    /** `onReset` runs once Garmin's zones are back, so the form can move focus off the vanished button. */
    resetToGarmin: (onReset: () => void) => {
      save.reset();
      reset.mutate(undefined, { onSuccess: onReset });
    },
  };
}
