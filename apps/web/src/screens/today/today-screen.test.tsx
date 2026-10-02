import type { Activity, MeResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { MISSING } from "@/lib/format";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { activityFixture, meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { TodayScreen } from "./today-screen";

/** What one POST /api/sync answers: "stored" stores the synced run like the real API, or any response. */
type SyncAnswer = "stored" | Response | Promise<Response>;

type FakeTodayApi = {
  me?: MeResponse;
  latest?: Activity | null;
  /** The run a successful sync stores as the latest. */
  synced?: Activity;
  /**
   * Called with 1 for the first sync, 2 for the next. `store` stores the synced run without answering,
   * for a sync that fails after some chunks were committed.
   */
  sync?: (attempt: number, store: () => void) => SyncAnswer;
};

/** /api/me, GET /api/activities/latest and POST /api/sync, in memory. */
function fakeTodayApi({
  me = meFixture(),
  latest = activityFixture(),
  synced = activityFixture(),
  sync = () => "stored",
}: FakeTodayApi = {}) {
  let current = latest;
  let syncs = 0;
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/activities/latest") return json({ activity: current });
    if (method === "POST" && path === "/api/sync") {
      syncs += 1;
      const answer = sync(syncs, () => {
        current = synced;
      });
      if (answer !== "stored") return answer;
      current = synced;
      return json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 1 });
    }
    return notFound();
  });
}

function renderToday() {
  return renderScreen(<TodayScreen />, { path: "/" });
}

/** A Stat or the hero: the label and its figure are siblings, so their parent reads "Time52:18". */
function figure(label: string) {
  return screen.getByText(label, { selector: "span" }).parentElement;
}

/** An 18 km run the day after the fixture run, so a test can tell the two apart. */
const newerRun = activityFixture({
  id: "7a1e2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  startUtc: "2026-09-28T05:30:00Z",
  startLocal: "2026-09-28T06:30:00",
  distanceM: 18_000,
  durationS: 5_580,
});

const noNewRuns = "No new runs on Garmin.";

describe("TodayScreen", () => {
  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderToday();
    expect(screen.getByRole("heading", { name: "Today" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading the latest run" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a failed first load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1
        ? problem(500, ErrorCode.internal)
        : json({ activity: activityFixture() });
    });
    renderToday();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "Latest run" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the latest run and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json({ activity: activityFixture() });
    });
    const { queryClient } = renderToday();
    expect(await screen.findByRole("region", { name: "Latest run" })).toBeInTheDocument();

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("activities", "latest") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(figure("Distance")).toHaveTextContent("10.0km");

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(figure("Distance")).toHaveTextContent("10.0km");
  });

  it("asks for a sync with one sentence and one Sync now button when no run is stored yet", async () => {
    fakeTodayApi({ latest: null });
    renderToday();

    expect(
      await screen.findByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "Latest run" })).not.toBeInTheDocument();
  });

  it("brings in the first run with Sync now from the empty state", async () => {
    const calls = fakeTodayApi({ latest: null, synced: activityFixture() });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    const run = await screen.findByRole("region", { name: "Latest run" });
    expect(within(run).getByText("Sun 27 Sep, 07:12")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      expect.objectContaining({ path: "/api/sync", body: undefined }),
    ]);
  });

  it("shows the run's local start, distance as the hero, time, pace and avg HR in km", async () => {
    fakeTodayApi();
    renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    // startLocal as the watch showed it; the device's zone plays no part.
    expect(within(run).getByText("Sun 27 Sep, 07:12")).toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
    expect(within(run).getByText("10.0")).toHaveClass("text-figure-lg");
    expect(figure("Time")).toHaveTextContent(/^Time52:18$/);
    // 3138 s over 10.04 km.
    expect(figure("Pace")).toHaveTextContent(/^Pace5:13\/km$/);
    expect(figure("Avg HR")).toHaveTextContent(/^Avg HR148bpm$/);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
  });

  it("converts distance and pace to mi when the runner uses miles", async () => {
    fakeTodayApi({ me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }) });
    renderToday();

    await screen.findByRole("region", { name: "Latest run" });
    // 10.04 km is 6.24 mi; 3138 s over it is 503 s, 8:23 a mile.
    expect(figure("Distance")).toHaveTextContent(/^Distance6\.2mi$/);
    expect(figure("Pace")).toHaveTextContent(/^Pace8:23\/mi$/);
    expect(figure("Time")).toHaveTextContent(/^Time52:18$/);
  });

  it("shows the dash for avg HR when the run has no HR (missing HR)", async () => {
    fakeTodayApi({ latest: activityFixture({ avgHr: null, maxHr: null }) });
    renderToday();

    await screen.findByRole("region", { name: "Latest run" });
    expect(figure("Avg HR")).toHaveTextContent(new RegExp(`^Avg HR${MISSING}$`));
    expect(figure("Pace")).toHaveTextContent(/^Pace5:13\/km$/);
  });

  it("renders an indoor run without distance, with dashes for distance and pace (indoor run)", async () => {
    fakeTodayApi({
      latest: activityFixture({
        type: "treadmill_running",
        isIndoor: true,
        distanceM: 0,
        durationS: 1_800,
        avgHr: 139,
      }),
    });
    renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    expect(within(run).getByText(/Indoor/)).toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent(new RegExp(`^Distance${MISSING}$`));
    expect(figure("Pace")).toHaveTextContent(new RegExp(`^Pace${MISSING}$`));
    expect(figure("Time")).toHaveTextContent(/^Time30:00$/);
    expect(figure("Avg HR")).toHaveTextContent(/^Avg HR139bpm$/);
  });

  it("refetches the latest run after Sync now and shows the newer one", async () => {
    const calls = fakeTodayApi({ synced: newerRun });
    renderToday();
    expect(await screen.findByText("Sun 27 Sep, 07:12")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByText("Mon 28 Sep, 06:30")).toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent(/^Distance18\.0km$/);
    expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
    const latestReads = calls.filter((call) => call.path === "/api/activities/latest");
    expect(latestReads).toHaveLength(2);
    // The sync wrote a run, so it needs no word of its own.
    expect(screen.queryByText(noNewRuns)).not.toBeInTheDocument();
  });

  it("reads Syncing…, disabled and busy while Sync now runs, and keeps the run on screen (pending)", async () => {
    fakeTodayApi({ sync: () => never() });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    const button = screen.getByRole("button", { name: "Syncing…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent("10.0km");
  });

  it.each([
    {
      corner: "expired Garmin login",
      answer: () => problem(409, ErrorCode.garminAuthExpired),
      message: "Garmin login expired. Reconnect in Settings.",
    },
    {
      corner: "Garmin 429",
      answer: () => problem(429, ErrorCode.garminRateLimited, { retryAfterSeconds: 3600 }),
      message: errorMessages.garmin_rate_limited,
    },
    {
      corner: "Garmin outage",
      answer: () => problem(502, ErrorCode.garminUnavailable),
      message: errorMessages.garmin_unavailable,
    },
  ])(
    "explains a failed sync under the button, keeps the run, and syncs again on Retry ($corner)",
    async ({ answer, message }) => {
      const calls = fakeTodayApi({
        synced: newerRun,
        sync: (attempt) => (attempt === 1 ? answer() : "stored"),
      });
      renderToday();

      await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

      expect(await screen.findByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("alert")).toHaveClass("text-ink");
      expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      expect(await screen.findByText("Mon 28 Sep, 06:30")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(2);
    },
  );

  it("explains a failed sync from the empty state and keeps the sentence (Garmin not connected)", async () => {
    fakeTodayApi({ latest: null, sync: () => problem(409, ErrorCode.garminNotConnected) });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_not_connected);
    expect(
      screen.getByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sync now" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows the runs a sync stored before it failed next to its error (partial sync)", async () => {
    const calls = fakeTodayApi({
      synced: newerRun,
      sync: (_attempt, store) => {
        store();
        return problem(429, ErrorCode.garminRateLimited, { retryAfterSeconds: 3600 });
      },
    });
    renderToday();
    expect(await screen.findByText("Sun 27 Sep, 07:12")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    // Both at once: the sync settles only after the reload, so the old run never sits beside the alert.
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_rate_limited);
    expect(screen.getByText("Mon 28 Sep, 06:30")).toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent(/^Distance18\.0km$/);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(2);
  });

  it("still reads Syncing…, disabled, after leaving Today mid-sync and coming back (navigation)", async () => {
    const calls = fakeTodayApi({ sync: () => never() });
    const { router } = renderToday();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    await act(() => router.navigate("/settings"));
    expect(screen.getByText("Route not under test")).toBeInTheDocument();
    await act(() => router.navigate("/"));

    const button = await screen.findByRole("button", { name: "Syncing…" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(1);
  });

  it("shows the error of a sync that failed while Today was away, and Retry syncs again (navigation)", async () => {
    let answerFirst!: (response: Response) => void;
    const calls = fakeTodayApi({
      synced: newerRun,
      sync: (attempt) =>
        attempt === 1 ? new Promise<Response>((resolve) => (answerFirst = resolve)) : "stored",
    });
    const { router, queryClient } = renderToday();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    await act(() => router.navigate("/settings"));
    answerFirst(problem(502, ErrorCode.garminUnavailable));
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    await act(() => router.navigate("/"));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_unavailable);
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Mon 28 Sep, 06:30")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(2);
  });

  it("says there are no new runs after a sync that wrote none, until the next sync starts (nothing new)", async () => {
    fakeTodayApi({
      sync: (attempt) =>
        attempt === 1
          ? json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0 })
          : never(),
    });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    const line = await screen.findByText(noNewRuns);
    expect(line).toHaveClass("text-caption", "text-ink-2");
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("button", { name: "Syncing…" })).toBeDisabled();
    expect(screen.queryByText(noNewRuns)).not.toBeInTheDocument();
  });

  it("says there are no new runs from the empty state too, under the sentence (nothing new)", async () => {
    fakeTodayApi({
      latest: null,
      sync: () => json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0 }),
    });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(await screen.findByText(noNewRuns)).toBeInTheDocument();
    expect(
      screen.getByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});
