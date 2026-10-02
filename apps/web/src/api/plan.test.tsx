import type { GoalInput, PlanResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, stubFetch } from "@/test/fake-api";
import { goalFixture, planFixture, planResponseFixture } from "@/test/fixtures";
import { testQueryClient } from "@/test/render";
import { planKey, usePlan, useSaveGoal } from "./plan";

const goal: GoalInput = {
  kind: "race",
  distanceKey: "10k",
  raceDate: "2026-10-25",
  targetTimeS: null,
  daysPerWeek: 4,
  longRunDay: "sun",
  recentTime: null,
};

function wrapper() {
  const queryClient = testQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

describe("usePlan", () => {
  it("reads GET /api/plan under the plan's detail key", async () => {
    stubFetch(({ path }) => (path === "/api/plan" ? json(planResponseFixture()) : notFound()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => usePlan(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(planKey).toEqual(["plan", "detail"]);
    expect(queryClient.getQueryData<PlanResponse>(planKey)?.plan?.weeks).toHaveLength(3);
  });
});

describe("useSaveGoal", () => {
  it("puts a saved goal and its plan in the plan's cache", async () => {
    const calls = stubFetch(({ method }) =>
      method === "PUT" ? json({ ok: true, goal: goalFixture(), plan: planFixture() }) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSaveGoal(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync(goal));

    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/goal", body: goal });
    expect(queryClient.getQueryData(planKey)).toEqual({ goal: goalFixture(), plan: planFixture() });
  });

  it("answers a conflict as data, not an error, and leaves the cached plan alone (conflict)", async () => {
    stubFetch(() => json({ ok: false, conflict: { code: "no_recent_time" } }));
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(planKey, planResponseFixture());
    const { result } = renderHook(() => useSaveGoal(), { wrapper: Wrapper });

    const response = await act(() => result.current.mutateAsync(goal));

    expect(response).toEqual({ ok: false, conflict: { code: "no_recent_time" } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.error).toBeNull();
    expect(queryClient.getQueryData(planKey)).toEqual(planResponseFixture());
  });
});
