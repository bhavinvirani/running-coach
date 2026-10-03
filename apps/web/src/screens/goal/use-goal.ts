import type { GoalInput, PlanConflict } from "@running-coach/shared";
import { useNavigate } from "react-router";
import { useSettings } from "@/api/me";
import { usePlan, useSaveGoal } from "@/api/plan";
import { screenState } from "@/api/screen-state";
import { today } from "@/lib/dates";

/**
 * Everything the goal form reads and does: the current goal to start from, the units its conflict
 * sentences use, today in the runner's time zone for the race date picker's range, and Save goal, which
 * opens the new plan once saved and keeps the form, with the reason, when the goal cannot be planned.
 */
export function useGoalScreen() {
  const plan = usePlan();
  const settings = useSettings();
  const save = useSaveGoal();
  const navigate = useNavigate();

  return {
    ...screenState(plan),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
    saving: save.isPending,
    saveError: save.error,
    conflict: save.data?.ok === false ? save.data.conflict : null,
    /** `onConflict` lets the form act on a conflict once, as it arrives, rather than while it shows. */
    saveGoal: (goal: GoalInput, onConflict: (conflict: PlanConflict) => void) =>
      save.mutate(goal, {
        onSuccess: (response) => {
          if (response.ok) void navigate("/plan");
          else onConflict(response.conflict);
        },
      }),
  };
}
