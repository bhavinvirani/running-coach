import { ErrorCode, type CalendarResponse } from "@running-coach/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { json, notFound, problem, stubFetch } from "@/test/fake-api";
import { calendarFixture, garminPushStatusFixture } from "@/test/fixtures";
import { holdPolls } from "@/test/held-polls";
import { testQueryClient } from "@/test/render";
import {
  GARMIN_PUSH_POLL_MS,
  calendarKey,
  useCalendar,
  useSendToGarmin,
  useUnscheduleGarmin,
} from "./calendar";
import { planKey } from "./plan";
import { sessionKey } from "./sessions";

const polls = holdPolls();

const FROM = "2026-10-08";
const TO = "2026-10-14";

function wrapper() {
  const queryClient = testQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, Wrapper };
}

/** GET /api/calendar answers `api.calendar`; a push sets pushing until the test ends it. */
function fakeCalendarApi(initial: CalendarResponse = calendarFixture(FROM)) {
  const api = { calendar: initial };
  const calls = stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/calendar") return json(api.calendar);
    if (method === "POST" && path === "/api/calendar/push") {
      api.calendar = { ...api.calendar, garmin: { ...api.calendar.garmin, pushing: true } };
      return json({ garmin: api.calendar.garmin });
    }
    return notFound();
  });
  return { api, calls };
}

describe("useCalendar", () => {
  it("reads the days from and to under the calendar's list key", async () => {
    const { calls } = fakeCalendarApi();
    const { queryClient, Wrapper } = wrapper();
    const { result } = renderHook(() => useCalendar(FROM, TO), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(calendarKey(FROM, TO)).toEqual(["calendar", "list", FROM, TO]);
    expect(calls[0]?.query.get("from")).toBe(FROM);
    expect(calls[0]?.query.get("to")).toBe(TO);
    expect(queryClient.getQueryData(calendarKey(FROM, TO))).toEqual(calendarFixture(FROM));
  });

  it("reads again every 3 s while a push runs and stops when it ends", async () => {
    const { api } = fakeCalendarApi(
      calendarFixture(FROM, { garmin: garminPushStatusFixture({ pushing: true }) }),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useCalendar(FROM, TO), { wrapper: Wrapper });

    await waitFor(() => expect(polls.delays()).toEqual([GARMIN_PUSH_POLL_MS]));
    api.calendar = calendarFixture(FROM);
    act(() => polls.fire());

    await waitFor(() => expect(result.current.data?.garmin.pushing).toBe(false));
    await waitFor(() => expect(polls.delays()).toEqual([]));
  });
});

describe("useSendToGarmin", () => {
  it("queues a push and reads the calendar again, which then polls while it runs", async () => {
    const { calls } = fakeCalendarApi();
    const { Wrapper } = wrapper();
    const { result } = renderHook(
      () => ({ calendar: useCalendar(FROM, TO), send: useSendToGarmin() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.calendar.isSuccess).toBe(true));

    await act(() => result.current.send.mutateAsync());

    expect(calls.filter((call) => call.method === "POST")).toEqual([
      expect.objectContaining({ path: "/api/calendar/push", body: undefined }),
    ]);
    await waitFor(() => expect(result.current.calendar.data?.garmin.pushing).toBe(true));
    await waitFor(() => expect(polls.delays()).toEqual([GARMIN_PUSH_POLL_MS]));
  });

  it("marks the plan and every session stale, since their Garmin state changes too", async () => {
    fakeCalendarApi();
    const { queryClient, Wrapper } = wrapper();
    queryClient.setQueryData(planKey, { goal: null, plan: null });
    queryClient.setQueryData(sessionKey("some-session"), null);
    const { result } = renderHook(() => useSendToGarmin(), { wrapper: Wrapper });

    await act(() => result.current.mutateAsync());

    expect(queryClient.getQueryState(planKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(sessionKey("some-session"))?.isInvalidated).toBe(true);
  });
});

describe("useUnscheduleGarmin", () => {
  it("sends the one schedule id and reads the calendar again", async () => {
    let unscheduled = false;
    const calls = stubFetch(({ method, path }) => {
      if (method === "GET" && path === "/api/calendar") {
        const others = unscheduled ? [] : [{ scheduleId: 9001, date: FROM, title: "Club tempo" }];
        return json(calendarFixture(FROM, { garmin: garminPushStatusFixture({ others }) }));
      }
      if (method === "POST" && path === "/api/calendar/unschedule") {
        unscheduled = true;
        return json({ garmin: garminPushStatusFixture() });
      }
      return notFound();
    });
    const { Wrapper } = wrapper();
    const { result } = renderHook(
      () => ({ calendar: useCalendar(FROM, TO), unschedule: useUnscheduleGarmin() }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(result.current.calendar.data?.garmin.others).toHaveLength(1));

    await act(() => result.current.unschedule.mutateAsync(9001));

    expect(calls.find((call) => call.method === "POST")?.body).toEqual({ scheduleIds: [9001] });
    await waitFor(() => expect(result.current.calendar.data?.garmin.others).toEqual([]));
  });

  it("fails with Garmin's error and keeps the workout listed (Garmin outage)", async () => {
    stubFetch(({ method }) =>
      method === "POST" ? problem(502, ErrorCode.garminUnavailable) : notFound(),
    );
    const { Wrapper } = wrapper();
    const { result } = renderHook(() => useUnscheduleGarmin(), { wrapper: Wrapper });

    await act(async () => {
      await result.current.mutateAsync(9001).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.error).toMatchObject({ code: "garmin_unavailable" }));
    expect(result.current.variables).toBe(9001);
  });
});
