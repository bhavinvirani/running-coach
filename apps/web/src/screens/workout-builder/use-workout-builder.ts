import type { CustomSessionInput } from "@running-coach/shared";
import { useLocation, useNavigate } from "react-router";
import { useSettings } from "@/api/me";
import { usePlan } from "@/api/plan";
import { screenState } from "@/api/screen-state";
import { useCreateSession, useSession, useUpdateSession } from "@/api/sessions";
import { today } from "@/lib/dates";

/**
 * The builder for a new workout: the plan, whose paces label the zones (none without an active plan, and
 * the API answers plan_missing), the units and today from /api/me, and Save workout, which opens the new
 * session in the builder's place, so Back from it skips the builder.
 */
export function useNewWorkoutScreen() {
  const plan = usePlan();
  const settings = useSettings();
  const create = useCreateSession();
  const navigate = useNavigate();

  return {
    ...screenState(plan),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
    saving: create.isPending,
    saveError: create.error,
    save: (input: CustomSessionInput) =>
      create.mutate(input, {
        onSuccess: ({ session }) =>
          void navigate(`/plan/sessions/${session.id}`, { replace: true }),
      }),
  };
}

/**
 * The builder for one of the runner's workouts: the session with its paces, the units and today, and Save
 * workout, which goes back to the session screen it was opened from (or opens it when the builder was
 * opened from a link).
 */
export function useEditWorkoutScreen(id: string) {
  const session = useSession(id);
  const settings = useSettings();
  const update = useUpdateSession(id);
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== "default";

  return {
    ...screenState(session),
    units: settings.data?.units,
    today: settings.data === undefined ? undefined : today(settings.data.timezone),
    saving: update.isPending,
    saveError: update.error,
    save: (input: CustomSessionInput) =>
      update.mutate(input, {
        onSuccess: () => {
          if (canGoBack) void navigate(-1);
          else void navigate(`/plan/sessions/${id}`, { replace: true });
        },
      }),
  };
}
