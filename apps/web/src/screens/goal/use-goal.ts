import type { GoalInput } from "@running-coach/shared";
import { useNavigate } from "react-router";
import { useSettings } from "@/api/me";
import { usePlan, useSaveGoal } from "@/api/plan";
import { screenState } from "@/api/screen-state";

/**
 * Everything the goal form reads and does: the current goal to start from, the units its conflict
 * sentences use, and Save goal, which opens the new plan once saved and keeps the form, with the reason,
 * when the goal cannot be planned.
 */
export function useGoalScreen() {
  const plan = usePlan();
  const settings = useSettings();
  const save = useSaveGoal();
  const navigate = useNavigate();

  return {
    ...screenState(plan),
    units: settings.data?.units,
    saving: save.isPending,
    saveError: save.error,
    conflict: save.data?.ok === false ? save.data.conflict : null,
    saveGoal: (goal: GoalInput) =>
      save.mutate(goal, {
        onSuccess: (response) => {
          if (response.ok) void navigate("/plan");
        },
      }),
  };
}
