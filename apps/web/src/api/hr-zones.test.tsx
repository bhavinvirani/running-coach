import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, stubFetch } from "@/test/fake-api";
import { activityFixture, activityResponseFixture } from "@/test/fixtures";
import { hrZonesFixture, hrZonesResponseFixture } from "@/test/fixtures-hr-zones";
import { testQueryClient } from "@/test/render";
import { hrZonesKey, useHrZones, useResetHrZones, useSaveHrZones } from "./hr-zones";
import { detailKey } from "./query-keys";

const RUN_ID = activityFixture().id;
const custom = hrZonesFixture({ maxHr: 200, lowBpm: [100, 120, 140, 160, 180] });

function wrapper() {
  const queryClient = testQueryClient();
  // A run screen opened before cached its detail, with Garmin's seconds in zone.
  queryClient.setQueryData(detailKey("activities", RUN_ID), activityResponseFixture());
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const runIsStale = (queryClient: ReturnType<typeof testQueryClient>) =>
  queryClient.getQueryState(detailKey("activities", RUN_ID))?.isInvalidated;

describe("useHrZones", () => {
  it("reads the zones in use under the hr-zones detail key", async () => {
    stubFetch(({ method, path }) =>
      method === "GET" && path === "/api/hr-zones" ? json(hrZonesResponseFixture()) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useHrZones(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(hrZonesKey).toEqual(["hr-zones", "detail"]);
    expect(queryClient.getQueryData(hrZonesKey)).toEqual(hrZonesResponseFixture());
  });
});

describe("useSaveHrZones", () => {
  it("PUTs the zones, stores the answer without a second GET and reads every run again", async () => {
    const calls = stubFetch(({ method, path }) =>
      method === "PUT" && path === "/api/hr-zones"
        ? json(hrZonesResponseFixture("custom", custom))
        : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSaveHrZones(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync(custom));

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["PUT /api/hr-zones"]);
    expect(calls[0]?.body).toEqual(custom);
    expect(queryClient.getQueryData(hrZonesKey)).toEqual(hrZonesResponseFixture("custom", custom));
    expect(runIsStale(queryClient)).toBe(true);
  });
});

describe("useResetHrZones", () => {
  it("DELETEs the runner's zones, stores Garmin's from the answer and reads every run again", async () => {
    const calls = stubFetch(({ method, path }) =>
      method === "DELETE" && path === "/api/hr-zones" ? json(hrZonesResponseFixture()) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(hrZonesKey, hrZonesResponseFixture("custom", custom));
    const { result } = renderHook(() => useResetHrZones(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(["DELETE /api/hr-zones"]);
    expect(queryClient.getQueryData(hrZonesKey)).toEqual(hrZonesResponseFixture());
    expect(runIsStale(queryClient)).toBe(true);
  });
});
