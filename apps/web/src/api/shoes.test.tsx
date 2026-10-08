import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, stubFetch } from "@/test/fake-api";
import { activityFixture, activityResponseFixture } from "@/test/fixtures";
import {
  DAILY_SHOE_ID,
  RACER_SHOE_ID,
  racerShoeFixture,
  shoeFixture,
  shoesResponseFixture,
} from "@/test/fixtures-shoes";
import { testQueryClient } from "@/test/render";
import { detailKey } from "./query-keys";
import {
  shoesKey,
  useActivateShoe,
  useCreateShoe,
  useDeleteShoe,
  useRetireShoe,
  useSetRunShoe,
  useShoes,
  useUpdateShoe,
} from "./shoes";

const RUN_ID = activityFixture().id;
const runKey = detailKey("activities", RUN_ID);
const input = {
  brand: "Northpace",
  model: "Glide 4",
  colour: null,
  nickname: null,
  retireDistanceM: 650_000,
  startDistanceM: 0,
};
/** The list every change answers with in these tests: the racer made active. */
const answered = shoesResponseFixture([
  racerShoeFixture({ active: true }),
  shoeFixture({ active: false }),
]);

function wrapper() {
  const queryClient = testQueryClient();
  // A run screen opened before cached the run, wearing the daily trainer, and the list.
  queryClient.setQueryData(runKey, activityResponseFixture({ shoeId: DAILY_SHOE_ID }));
  queryClient.setQueryData(shoesKey, shoesResponseFixture());
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

const isStale = (queryClient: ReturnType<typeof testQueryClient>, key: readonly unknown[]) =>
  queryClient.getQueryState(key)?.isInvalidated;
const sent = (calls: { method: string; path: string }[]) =>
  calls.map((call) => `${call.method} ${call.path}`);

describe("useShoes", () => {
  it("reads every pair under the shoes list key", async () => {
    stubFetch(({ method, path }) =>
      method === "GET" && path === "/api/shoes" ? json(shoesResponseFixture()) : notFound(),
    );
    const queryClient = testQueryClient();
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useShoes(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(shoesKey).toEqual(["shoes", "list"]);
    expect(queryClient.getQueryData(shoesKey)).toEqual(shoesResponseFixture());
  });
});

describe.each([
  {
    name: "useCreateShoe",
    request: "POST /api/shoes",
    useSend: () => {
      const create = useCreateShoe();
      return () => create.mutateAsync({ ...input, active: true });
    },
  },
  {
    name: "useUpdateShoe",
    request: `PUT /api/shoes/${RACER_SHOE_ID}`,
    useSend: () => {
      const update = useUpdateShoe(RACER_SHOE_ID);
      return () => update.mutateAsync(input);
    },
  },
  {
    name: "useActivateShoe",
    request: `POST /api/shoes/${RACER_SHOE_ID}/active`,
    useSend: () => {
      const activate = useActivateShoe(RACER_SHOE_ID);
      return () => activate.mutateAsync();
    },
  },
  {
    name: "useRetireShoe",
    request: `POST /api/shoes/${RACER_SHOE_ID}/retire`,
    useSend: () => {
      const retire = useRetireShoe(RACER_SHOE_ID);
      return () => retire.mutateAsync();
    },
  },
])("$name", ({ request, useSend }) => {
  it("sends one request and stores the answered list without a second GET, leaving runs alone", async () => {
    const calls = stubFetch(({ method }) => (method === "GET" ? notFound() : json(answered)));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(useSend, { wrapper: Wrapper });

    await act(() => result.current());

    expect(sent(calls)).toEqual([request]);
    expect(queryClient.getQueryData(shoesKey)).toEqual(answered);
    expect(isStale(queryClient, runKey)).toBe(false);
  });
});

describe("useDeleteShoe", () => {
  it("stores the answered list and reads every run again, since the pair's runs lose it", async () => {
    const calls = stubFetch(({ method }) => (method === "DELETE" ? json(answered) : notFound()));
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useDeleteShoe(DAILY_SHOE_ID), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(sent(calls)).toContain(`DELETE /api/shoes/${DAILY_SHOE_ID}`);
    expect(queryClient.getQueryData(shoesKey)).toEqual(answered);
    expect(isStale(queryClient, runKey)).toBe(true);
  });

  it("fails as not found without a request for an id that is no uuid", async () => {
    const calls = stubFetch(() => json(answered));
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useDeleteShoe("not-a-pair"), { wrapper: Wrapper });

    await expect(act(() => result.current.mutateAsync())).rejects.toMatchObject({
      status: 404,
      code: "not_found",
    });
    expect(calls).toEqual([]);
  });
});

describe("useSetRunShoe", () => {
  it("PUTs the pair, patches it into the cached run without reading it again, and reads the totals again", async () => {
    const calls = stubFetch(({ method, path }) =>
      method === "PUT" && path === `/api/activities/${RUN_ID}/shoe`
        ? json({ shoeId: RACER_SHOE_ID })
        : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSetRunShoe(RUN_ID), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync(RACER_SHOE_ID));

    expect(sent(calls)[0]).toBe(`PUT /api/activities/${RUN_ID}/shoe`);
    expect(calls[0]?.body).toEqual({ shoeId: RACER_SHOE_ID });
    expect(queryClient.getQueryData(runKey)).toEqual(
      activityResponseFixture({ shoeId: RACER_SHOE_ID }),
    );
    expect(isStale(queryClient, runKey)).toBe(false);
    expect(isStale(queryClient, shoesKey)).toBe(true);
  });

  it("sends a second change only once the first is answered, so the last choice stands (overlapping writes)", async () => {
    const held: ((response: Response) => void)[] = [];
    const calls = stubFetch(({ method }) =>
      method === "PUT" ? new Promise<Response>((resolve) => held.push(resolve)) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSetRunShoe(RUN_ID), { wrapper: Wrapper });

    act(() => result.current.mutate(RACER_SHOE_ID));
    act(() => result.current.mutate(null));
    await waitFor(() => expect(calls).toHaveLength(1));

    act(() => held[0]?.(json({ shoeId: RACER_SHOE_ID })));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.map((call) => call.body)).toEqual([{ shoeId: RACER_SHOE_ID }, { shoeId: null }]);
    act(() => held[1]?.(json({ shoeId: null })));

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(runKey)).toMatchObject({ shoeId: null });
  });

  it("sends null to take the pair off the run", async () => {
    const calls = stubFetch(({ method }) =>
      method === "PUT" ? json({ shoeId: null }) : notFound(),
    );
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useSetRunShoe(RUN_ID), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync(null));

    expect(calls[0]?.body).toEqual({ shoeId: null });
    expect(queryClient.getQueryData(runKey)).toMatchObject({ shoeId: null });
  });
});
