import {
  planResponseSchema,
  saveGoalResponseSchema,
  type GoalInput,
  type PlanResponse,
} from "@running-coach/shared";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { detailKey } from "./query-keys";

export const planKey = detailKey("plan");

/** GET /api/plan: the runner's goal and its active plan, both null until a goal is saved. */
export function planQueryOptions() {
  return queryOptions({
    queryKey: planKey,
    queryFn: ({ signal }) => apiFetch("/api/plan", { schema: planResponseSchema, signal }),
  });
}

export function usePlan() {
  return useQuery(planQueryOptions());
}

/**
 * PUT /api/goal. A saved goal answers with its new plan, which goes straight into the plan's cache: no
 * second GET. A conflict (a marathon on 3 days, a race before the plan could start) is the mutation's data,
 * not its error: the request was valid, and the goal stays unsaved until the runner changes it.
 */
export function useSaveGoal() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (goal: GoalInput) =>
      apiFetch("/api/goal", { method: "PUT", body: goal, schema: saveGoalResponseSchema }),
    // A GET /api/plan already in flight answers with the plan from before the save; landing after
    // onSuccess, it would put that plan back over the new one.
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: planKey });
    },
    onSuccess: (response) => {
      if (!response.ok) return;
      queryClient.setQueryData<PlanResponse>(planKey, { goal: response.goal, plan: response.plan });
    },
  });
}
