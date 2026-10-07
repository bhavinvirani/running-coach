import type {
  Activity,
  CalendarResponse,
  EndPauseResponse,
  LatestReviewResponse,
  MeResponse,
  PauseReason,
  PersonalBestsResponse,
  PlanSession,
  TrainingPause,
} from "@running-coach/shared";
import { ErrorCode, RACE_EVENT_TYPE } from "@running-coach/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Outlet } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { personalBestsKey } from "@/api/personal-bests";
import { detailKey } from "@/api/query-keys";
import { useForgetSyncOutcomeOnReconnect } from "@/api/sync";
import { errorMessages } from "@/lib/errors";
import { MISSING } from "@/lib/format";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import {
  activityFixture,
  calendarFixture,
  customSessionFixture,
  garminPushStatusFixture,
  meFixture,
  personalBestFixture,
  personalBestsFixture,
  planSessionId,
} from "@/test/fixtures";
import {
  coachEasySessionFixture,
  coachRestSessionFixture,
  doneSessionFixture,
  easedSessionFixture,
  endPauseResponseFixture,
  pauseSkippedSessionFixture,
  pausedSessionFixture,
  trainingPauseFixture,
} from "@/test/fixtures-adaptation";
import {
  REVIEW_ID,
  fallbackReviewFixture,
  latestReviewReadyFixture,
  reviewResponseFixture,
  weeklyReviewCardFixture,
} from "@/test/fixtures-weekly-review";
import { renderScreen } from "@/test/render";
import { TodayScreen } from "./today-screen";

/** What one POST /api/sync answers: "stored" stores the synced run like the real API, or any response. */
type SyncAnswer = "stored" | Response | Promise<Response>;

type FakeTodayApi = {
  /** GET /api/me: the runner, or an answer that can change mid-test (the API marks the login, a reconnect). */
  me?: MeResponse | (() => Response | Promise<Response>);
  latest?: Activity | null;
  /** The run a successful sync stores as the latest. */
  synced?: Activity;
  /**
   * Called with 1 for the first sync, 2 for the next. `store` stores the synced run without answering,
   * for a sync that fails after some chunks were committed.
   */
  sync?: (attempt: number, store: () => void) => SyncAnswer;
  /** GET /api/personal-bests: none found unless a test says otherwise. */
  bests?: PersonalBestsResponse | (() => Response | Promise<Response>);
  /** The bests once a sync has stored its run and the best-efforts job has checked it. */
  bestsAfterSync?: PersonalBestsResponse;
  /** /api/me once a sync has answered: the API marks the login expired when Garmin refuses it. */
  meAfterSync?: MeResponse;
  /** GET /api/reviews/latest: no review to show unless a test says otherwise, or an answer per read. */
  review?: LatestReviewResponse | (() => Response | Promise<Response>);
};

/** No weekly review to show: what GET /api/reviews/latest answers in the tests about anything else. */
const NO_REVIEW: LatestReviewResponse = { state: "none" };

/** GET /api/calendar of a runner without a plan: no paces, so Today shows no next 7 days. */
function noPlanCalendar({ query }: FakeRequest): Response {
  return json(calendarFixture(query.get("from") ?? "2026-09-27", { paces: null }));
}

/**
 * /api/me, GET /api/activities/latest, GET /api/personal-bests, POST /api/sync, a calendar without a
 * plan and the weekly review, in memory.
 */
function fakeTodayApi({
  me = meFixture(),
  latest = activityFixture(),
  synced = activityFixture(),
  sync = () => "stored",
  bests = personalBestsFixture(),
  bestsAfterSync,
  meAfterSync,
  review = NO_REVIEW,
}: FakeTodayApi = {}) {
  let currentMe = me;
  let current = latest;
  let currentBests = bests;
  let syncs = 0;
  const store = () => {
    current = synced;
    currentBests = bestsAfterSync ?? currentBests;
  };
  return stubFetch((request) => {
    const { method, path } = request;
    if (method === "GET" && path === "/api/calendar") return noPlanCalendar(request);
    if (method === "GET" && path === "/api/reviews/latest") {
      return typeof review === "function" ? review() : json(review);
    }
    if (method === "PUT" && path === `/api/reviews/${REVIEW_ID}/feedback`) {
      const { feedback } = request.body as { feedback: "up" | "down" | null };
      return json(reviewResponseFixture(weeklyReviewCardFixture({ feedback })));
    }
    if (method === "GET" && path === "/api/me") {
      return typeof currentMe === "function" ? currentMe() : json(currentMe);
    }
    if (method === "GET" && path === "/api/activities/latest") return json({ activity: current });
    if (method === "GET" && path === "/api/personal-bests") {
      return typeof currentBests === "function" ? currentBests() : json(currentBests);
    }
    if (method === "POST" && path === "/api/sync") {
      syncs += 1;
      currentMe = meAfterSync ?? currentMe;
      const answer = sync(syncs, store);
      if (answer !== "stored") return answer;
      store();
      return json({
        lastSyncAt: "2026-09-28T07:40:00Z",
        activitiesWritten: 1,
        activitiesRemoved: 0,
      });
    }
    return notFound();
  });
}

/** What the tab shell runs around Today, but the sync on open: forgetting a sync's outcome on a reconnect. */
function Shell() {
  useForgetSyncOutcomeOnReconnect();
  return <Outlet />;
}

function renderToday() {
  return renderScreen(<TodayScreen />, { path: "/", layout: <Shell /> });
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

const expiredMe = meFixture({ garmin: { status: "expired", lastSyncAt: "2026-09-27T06:12:00Z" } });

const notConnectedMe = meFixture({ garmin: { status: "not_connected", lastSyncAt: null } });

/** The header beside the Today title, which holds Sync now or Reconnect Garmin on a loaded screen. */
function header() {
  return screen.getByRole("heading", { name: "Today" }).closest("header");
}

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
    stubFetch((request) => {
      const { path } = request;
      if (path === "/api/calendar") return noPlanCalendar(request);
      if (path === "/api/reviews/latest") return json(NO_REVIEW);
      if (path === "/api/me") return json(meFixture());
      if (path === "/api/personal-bests") return json(personalBestsFixture());
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
    stubFetch((request) => {
      const { path } = request;
      if (path === "/api/calendar") return noPlanCalendar(request);
      if (path === "/api/reviews/latest") return json(NO_REVIEW);
      if (path === "/api/me") return json(meFixture());
      if (path === "/api/personal-bests") return json(personalBestsFixture());
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

  it("opens the latest run from its card", async () => {
    fakeTodayApi();
    const { router } = renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    const link = within(run).getByRole("link");
    expect(link).toHaveAttribute("href", `/runs/${activityFixture().id}`);
    expect(link).toHaveAccessibleName("Open the latest run, Sun 27 Sep, 07:12, 10.0 km, 52:18");

    await userEvent.click(within(run).getByText("10.0"));

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/runs/${activityFixture().id}`);
  });

  it("marks a race with a Race chip beside its start and names it in the card's label", async () => {
    fakeTodayApi({ latest: activityFixture({ eventType: RACE_EVENT_TYPE }) });
    renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    const chip = within(run).getByText("Race");
    expect(chip.querySelector(".bg-type-race")).not.toBeNull();
    expect(chip.closest("p")).toHaveTextContent(/^Sun 27 Sep, 07:12Race$/);
    expect(within(run).getByRole("link")).toHaveAccessibleName(
      "Open the latest run, Sun 27 Sep, 07:12, Race, 10.0 km, 52:18",
    );
  });

  it("shows no chip for a run that is no race", async () => {
    fakeTodayApi({ latest: activityFixture({ eventType: "training" }) });
    renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    expect(within(run).queryByText("Race")).not.toBeInTheDocument();
    expect(within(run).getByRole("link")).toHaveAccessibleName(
      "Open the latest run, Sun 27 Sep, 07:12, 10.0 km, 52:18",
    );
  });

  it("marks the latest run with a PB chip naming the distances it holds as bests", async () => {
    fakeTodayApi({
      bests: personalBestsFixture({
        bests: [
          personalBestFixture({ distanceKey: "10k", timeS: 3281.4 }),
          personalBestFixture({ distanceKey: "5k", timeS: 1625.87 }),
        ],
      }),
    });
    renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    const chip = await within(run).findByText("PB 5K, 10K");
    expect(chip.querySelector(".bg-pb")).toHaveAttribute("aria-hidden", "true");
    expect(chip.closest("p")).toHaveTextContent(/^Sun 27 Sep, 07:12PB 5K, 10K$/);
    expect(within(run).getByRole("link")).toHaveAccessibleName(
      "Open the latest run, Sun 27 Sep, 07:12, PB 5K, 10K, 10.0 km, 52:18",
    );
  });

  it("puts the PB chip after the Race chip on a race that set a best", async () => {
    fakeTodayApi({
      latest: activityFixture({ eventType: RACE_EVENT_TYPE }),
      bests: personalBestsFixture({ bests: [personalBestFixture({ distanceKey: "5k" })] }),
    });
    renderToday();

    const chip = await screen.findByText("PB 5K");
    expect(chip.closest("p")).toHaveTextContent(/^Sun 27 Sep, 07:12RacePB 5K$/);
  });

  it("shows no PB chip when the latest run holds no best", async () => {
    fakeTodayApi({
      bests: personalBestsFixture({
        bests: [personalBestFixture({ activityId: newerRun.id, distanceKey: "5k" })],
      }),
    });
    const { queryClient } = renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    await vi.waitFor(() =>
      expect(queryClient.getQueryState(personalBestsKey)?.status).toBe("success"),
    );
    expect(within(run).queryByText(/PB/)).not.toBeInTheDocument();
    expect(within(run).getByRole("link")).toHaveAccessibleName(
      "Open the latest run, Sun 27 Sep, 07:12, 10.0 km, 52:18",
    );
  });

  it.each([
    { state: "still loading", bests: () => never() },
    { state: "failed", bests: () => problem(500, ErrorCode.internal) },
  ])(
    "shows the latest run without a PB chip or an alert while the bests are $state",
    async ({ bests }) => {
      fakeTodayApi({ bests });
      renderToday();

      const run = await screen.findByRole("region", { name: "Latest run" });
      expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
      expect(within(run).queryByText(/PB/)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    },
  );

  it.each([
    { state: "being checked", checking: true, errorCode: null },
    {
      state: "stopped on an expired Garmin login",
      checking: false,
      errorCode: ErrorCode.garminAuthExpired,
    },
    { state: "waiting for the next sync", checking: false, errorCode: null },
    {
      state: "held back by Garmin's 429",
      checking: true,
      errorCode: ErrorCode.garminRateLimited,
    },
  ] as const)(
    "stays quiet about runs whose best efforts are $state: only the PB chip",
    async ({ checking, errorCode }) => {
      fakeTodayApi({
        bests: personalBestsFixture({
          bests: [personalBestFixture({ distanceKey: "5k" })],
          pendingRuns: 340,
          checking,
          errorCode,
        }),
      });
      renderToday();

      const run = await screen.findByRole("region", { name: "Latest run" });
      expect(await within(run).findByText("PB 5K")).toBeInTheDocument();
      expect(
        screen.queryByText(/best efforts|Garmin login expired|Garmin is limiting/),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("flags the new run with a PB chip after Sync now once its best efforts are in (flag after sync)", async () => {
    const calls = fakeTodayApi({
      synced: newerRun,
      bestsAfterSync: personalBestsFixture({
        bests: [
          personalBestFixture({
            distanceKey: "half",
            timeS: 6972.6,
            activityId: newerRun.id,
            startUtc: newerRun.startUtc,
            startLocal: newerRun.startLocal,
          }),
        ],
      }),
    });
    renderToday();
    expect(await screen.findByText("Sun 27 Sep, 07:12")).toBeInTheDocument();
    expect(screen.queryByText(/PB/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    expect(await screen.findByText("PB Half")).toBeInTheDocument();
    expect(screen.getByText("Mon 28 Sep, 06:30")).toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/personal-bests")).toHaveLength(2);
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
      // The API marks the login expired on the second rejection in a row; /api/me says ok until then.
      corner: "expired Garmin login, first rejection with /api/me still ok",
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
    fakeTodayApi({
      latest: null,
      sync: () => problem(409, ErrorCode.garminNotConnected),
      meAfterSync: notConnectedMe,
    });
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
          ? json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0, activitiesRemoved: 0 })
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

  it("says how many runs the sync removed because Garmin no longer lists them, and shows the run before them (deleted activity)", async () => {
    const olderRun = activityFixture({
      id: "0b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8",
      startUtc: "2026-09-24T16:30:00Z",
      startLocal: "2026-09-24T18:30:00",
    });
    fakeTodayApi({
      latest: newerRun,
      synced: olderRun,
      sync: (attempt, store) => {
        store();
        return attempt === 1
          ? json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0, activitiesRemoved: 1 })
          : never();
      },
    });
    renderToday();
    expect(await screen.findByText("Mon 28 Sep, 06:30")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Sync now" }));

    const line = await screen.findByRole("status");
    expect(line).toHaveTextContent(/^Removed 1 run Garmin no longer lists\.$/);
    expect(line).toHaveClass("text-caption", "text-ink-2");
    expect(await screen.findByText("Thu 24 Sep, 18:30")).toBeInTheDocument();
    expect(screen.queryByText("Mon 28 Sep, 06:30")).not.toBeInTheDocument();
    expect(screen.queryByText(noNewRuns)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says there are no new runs from the empty state too, under the sentence (nothing new)", async () => {
    fakeTodayApi({
      latest: null,
      sync: () =>
        json({ lastSyncAt: "2026-09-28T07:40:00Z", activitiesWritten: 0, activitiesRemoved: 0 }),
    });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(await screen.findByText(noNewRuns)).toBeInTheDocument();
    expect(
      screen.getByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("puts Reconnect Garmin in the header and the expired line above the run in place of Sync now (expired login)", async () => {
    fakeTodayApi({ me: expiredMe });
    renderToday();

    const run = await screen.findByRole("region", { name: "Latest run" });
    const line = screen.getByRole("alert");
    expect(line.textContent).toBe(errorMessages.garmin_auth_expired);
    expect(line).toHaveClass("text-body", "text-ink");
    expect(line.compareDocumentPosition(run) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const reconnect = screen.getByRole("link", { name: "Reconnect Garmin" });
    expect(reconnect).toHaveAttribute("href", "/settings/garmin");
    expect(reconnect).toHaveAttribute("data-variant", "secondary");
    expect(header()).toContainElement(reconnect);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
  });

  it("asks to reconnect from the empty state with the expired line and Reconnect Garmin, not Sync now (expired login)", async () => {
    fakeTodayApi({ me: expiredMe, latest: null });
    renderToday();

    expect((await screen.findByRole("alert")).textContent).toBe(errorMessages.garmin_auth_expired);
    const reconnect = screen.getByRole("link", { name: "Reconnect Garmin" });
    expect(reconnect).toHaveAttribute("href", "/settings/garmin");
    // The sentence carries the one action, so the header leaves it out.
    expect(header()).not.toContainElement(reconnect);
    expect(
      screen.queryByText("Sync now to bring in your latest run from Garmin."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("opens the Garmin screen in Settings from Reconnect Garmin (expired login)", async () => {
    fakeTodayApi({ me: expiredMe });
    const { router } = renderToday();

    await userEvent.click(await screen.findByRole("link", { name: "Reconnect Garmin" }));

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/garmin");
  });

  it("turns Sync now into Reconnect Garmin once a sync finds the login expired, with the line once and no Retry (expired login)", async () => {
    const calls = fakeTodayApi({
      sync: () => problem(409, ErrorCode.garminAuthExpired),
      meAfterSync: expiredMe,
    });
    renderToday();

    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));

    expect(await screen.findByRole("link", { name: "Reconnect Garmin" })).toBeInTheDocument();
    expect(screen.getAllByText(errorMessages.garmin_auth_expired)).toHaveLength(1);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
    expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(1);
  });

  it.each([
    {
      corner: "expired login, reconnected",
      start: meFixture(),
      code: ErrorCode.garminAuthExpired,
      // The second rejection in a row: the API marks the login expired.
      afterSync: expiredMe,
    },
    {
      corner: "not connected, first connect",
      start: notConnectedMe,
      code: ErrorCode.garminNotConnected,
      afterSync: notConnectedMe,
    },
  ])(
    "forgets an earlier sync's login error and shows Sync now once /api/me moves to ok ($corner)",
    async ({ start, code, afterSync }) => {
      let me = start;
      const calls = fakeTodayApi({
        me: () => json(me),
        sync: () => {
          me = afterSync;
          return problem(409, code);
        },
      });
      const { queryClient } = renderToday();
      await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages[code]);

      // Connected from the laptop; /api/me is read again back in the foreground, or by Settings.
      me = meFixture();
      await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

      await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
      expect(screen.queryByText(errorMessages[code])).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Reconnect Garmin" })).not.toBeInTheDocument();
      expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
      expect(calls.filter((call) => call.path === "/api/sync")).toHaveLength(1);
    },
  );

  it("shows Sync now and no stale alert back on Today when the reconnect was read while Today was left for Settings (expired login, reconnected)", async () => {
    let me = meFixture();
    fakeTodayApi({
      me: () => json(me),
      sync: () => {
        me = expiredMe;
        return problem(409, ErrorCode.garminAuthExpired);
      },
    });
    const { router, queryClient } = renderToday();
    await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
    await userEvent.click(await screen.findByRole("link", { name: "Reconnect Garmin" }));
    expect(await screen.findByText("Route not under test")).toBeInTheDocument();

    // Reconnected from the laptop; Settings, or the foreground, reads /api/me again while Today is away.
    me = meFixture();
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));
    await act(() => router.navigate("/"));

    expect(await screen.findByRole("button", { name: "Sync now" })).toBeEnabled();
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.queryByText(errorMessages.garmin_auth_expired)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Reconnect Garmin" })).not.toBeInTheDocument();
  });

  it.each([
    {
      corner: "Garmin outage",
      answer: () => problem(502, ErrorCode.garminUnavailable),
      message: errorMessages.garmin_unavailable,
    },
    {
      corner: "expired login, first rejection with /api/me still ok",
      answer: () => problem(409, ErrorCode.garminAuthExpired),
      message: errorMessages.garmin_auth_expired,
    },
  ])(
    "keeps an earlier sync's error and Retry after /api/me is read again still ok, which is no reconnect ($corner)",
    async ({ answer, message }) => {
      fakeTodayApi({ sync: answer });
      const { queryClient } = renderToday();
      await userEvent.click(await screen.findByRole("button", { name: "Sync now" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(message);

      await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    },
  );

  it("keeps the Sync now sentence and button when Garmin is not connected (not connected)", async () => {
    fakeTodayApi({
      me: notConnectedMe,
      latest: null,
    });
    renderToday();

    expect(
      await screen.findByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync now" })).toBeEnabled();
    expect(screen.queryByRole("link", { name: "Reconnect Garmin" })).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

/** Thu 8 Oct 2026 in London, BST: the plan's first week, its intervals today. */
const WEEK_FROM = "2026-10-08";

/** The calendar from Thu 8 Oct with `change` applied to each session; the intervals already on Garmin. */
function weekCalendar(
  overrides: Partial<CalendarResponse> & { extra?: PlanSession[] } = {},
  change: (session: PlanSession) => PlanSession = (session) => session,
): CalendarResponse {
  const calendar = calendarFixture(WEEK_FROM, overrides);
  return {
    ...calendar,
    days: calendar.days.map((day) => ({
      ...day,
      sessions: day.sessions.map((session) =>
        change(session.date === WEEK_FROM ? { ...session, onGarmin: true } : session),
      ),
    })),
  };
}

type FakeWeekApi = {
  /** GET /api/me: the runner, or one per read (the login found expired after the first). */
  me?: MeResponse | (() => MeResponse);
  /** GET /api/calendar: the week, or an answer per request. */
  calendar?: CalendarResponse | ((request: FakeRequest) => Response | Promise<Response>);
  /** POST /api/calendar/unschedule; by default it takes the workout off and answers the new status. */
  unschedule?: () => Response | Promise<Response>;
  /** GET /api/pause: the open pause (none by default), or an answer per request. */
  pause?: TrainingPause | null | (() => Response | Promise<Response>);
  /** POST /api/pause: a problem, else a pause from today for the reason sent. */
  startPause?: () => Response | Promise<Response>;
  /** POST /api/pause/end: a problem, else the pause closed with this re-entry (endPauseResponseFixture's). */
  endPause?: EndPauseResponse | (() => Response | Promise<Response>);
  /**
   * POST /api/sync: what it does to the week's sessions, as the API matches the runs it brings in, also
   * when it fails partway (`failure`).
   */
  sync?: { change: (session: PlanSession) => PlanSession; failure?: Response };
  /** GET /api/reviews/latest: no review to show unless a test says otherwise. */
  review?: LatestReviewResponse;
};

/** The week with `change` applied to each of its sessions, like the API's next read after a change. */
function changeSessions(
  calendar: CalendarResponse,
  change: (session: PlanSession) => PlanSession,
): CalendarResponse {
  return {
    ...calendar,
    days: calendar.days.map((day) => ({ ...day, sessions: day.sessions.map(change) })),
  };
}

/**
 * Today with its latest run and no bests, and the calendar of the week from Thu 8 Oct. Send to Garmin
 * starts a push the calendar then reports; Unschedule takes the workout off the stored list. Pause training
 * opens a pause today, which pauses the week's sessions that are not done; I'm back skips those and closes
 * it.
 */
function fakeWeekApi({
  me = meFixture(),
  calendar = weekCalendar(),
  unschedule,
  pause = null,
  startPause,
  endPause = endPauseResponseFixture(),
  sync,
  review = NO_REVIEW,
}: FakeWeekApi = {}) {
  let current = calendar;
  let openPause = pause;
  return stubFetch((request) => {
    const { method, path } = request;
    if (method === "GET" && path === "/api/me") return json(typeof me === "function" ? me() : me);
    if (method === "GET" && path === "/api/reviews/latest") return json(review);
    if (method === "GET" && path === "/api/activities/latest") {
      return json({ activity: activityFixture() });
    }
    if (method === "GET" && path === "/api/personal-bests") return json(personalBestsFixture());
    if (method === "GET" && path === "/api/calendar") {
      return typeof current === "function" ? current(request) : json(current);
    }
    if (method === "GET" && path === "/api/pause") {
      return typeof openPause === "function" ? openPause() : json({ pause: openPause });
    }
    if (typeof current === "function" || typeof openPause === "function") return notFound();
    if (method === "POST" && path === "/api/pause") {
      if (startPause) return startPause();
      const { reason } = request.body as { reason: PauseReason };
      openPause = openPause ?? trainingPauseFixture({ reason, startDate: WEEK_FROM });
      current = changeSessions(current, (session) =>
        session.status === "done" ? session : { ...session, paused: true, onGarmin: false },
      );
      return json({ pause: openPause });
    }
    if (method === "POST" && path === "/api/pause/end") {
      if (typeof endPause === "function") return endPause();
      openPause = null;
      current = changeSessions(current, (session) =>
        session.paused ? skippedByPause(session) : session,
      );
      return json(endPause);
    }
    if (method === "POST" && path === "/api/sync" && sync) {
      current = changeSessions(current, sync.change);
      return (
        sync.failure ??
        json({ lastSyncAt: "2026-10-08T06:30:00Z", activitiesWritten: 1, activitiesRemoved: 0 })
      );
    }
    if (method === "POST" && path === "/api/calendar/push") {
      current = { ...current, garmin: { ...current.garmin, pushing: true, error: null } };
      return json({ garmin: current.garmin });
    }
    if (method === "POST" && path === "/api/calendar/unschedule") {
      if (unschedule) return unschedule();
      current = { ...current, garmin: { ...current.garmin, others: [] } };
      return json({ garmin: current.garmin });
    }
    return notFound();
  });
}

/** A session left in the pause on I'm back, as the API skips it: off the watch, with the pause's change. */
function skippedByPause(session: PlanSession): PlanSession {
  const { type, title, status, target } = session;
  return {
    ...session,
    paused: false,
    onGarmin: false,
    status: "skipped",
    adjustment: {
      source: "pause",
      kind: "rest",
      activityId: null,
      original: { type, title, status, target },
      at: "2026-10-08T06:10:00Z",
    },
  };
}

/** The week's region once the calendar has loaded: its day list or its alert is on screen. */
async function loadedWeek() {
  const week = await screen.findByRole("region", { name: "Next 7 days" });
  await waitFor(() => expect(week).toHaveAttribute("aria-busy", "false"));
  return week;
}

async function weekRows() {
  return within(await loadedWeek()).getAllByRole("listitem");
}

describe("TodayScreen next 7 days", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lists today and the six days after it, each session opening its screen with distance, time and Garmin state", async () => {
    const calls = fakeWeekApi();
    renderToday();

    const rows = await weekRows();
    expect(rows.map((row) => row.querySelector("time")?.textContent)).toEqual([
      "Today",
      "Tomorrow",
      "Sat 10",
      "Sun 11",
      "Mon 12",
      "Tue 13",
      "Wed 14",
    ]);
    expect(
      within(rows[0]!).getByRole("link", { name: "Intervals, 11.6 km, 1:04:00, On Garmin" }),
    ).toHaveAttribute("href", `/plan/sessions/${planSessionId("2026-10-08")}`);
    expect(
      within(rows[1]!).getByRole("link", { name: "Easy, 5.0 km, 30:00, Waiting to send" }),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Rest")).toBeInTheDocument();
    expect(
      within(rows[3]!).getByRole("link", { name: "Long run, 14.0 km, 1:24:30, Waiting to send" }),
    ).toBeInTheDocument();
    // Strength has no steps a watch workout can hold: no Garmin state at all.
    expect(within(rows[6]!).getByRole("link", { name: "Strength, 30:00" })).toBeInTheDocument();
    const calendarCall = calls.find((call) => call.path === "/api/calendar");
    expect(calendarCall?.query.get("from")).toBe("2026-10-08");
    expect(calendarCall?.query.get("to")).toBe("2026-10-14");
  });

  it("offers Add on every day, opening the workout builder on that date", async () => {
    fakeWeekApi();
    const { router } = renderToday();

    const rows = await weekRows();
    for (const row of rows) {
      expect(within(row).getByRole("link", { name: /^Add a workout on / })).toBeInTheDocument();
    }
    const add = within(rows[2]!).getByRole("link", { name: "Add a workout on Sat 10 Oct" });
    expect(add).toHaveAttribute("href", "/plan/sessions/new?date=2026-10-10");

    await userEvent.click(add);
    expect(router.state.location.pathname).toBe("/plan/sessions/new");
    expect(router.state.location.search).toBe("?date=2026-10-10");
  });

  it("names a custom workout by its title and reads a skipped session as Skipped, without distance", async () => {
    fakeWeekApi({
      calendar: weekCalendar({ extra: [customSessionFixture()] }, (session) =>
        session.date === "2026-10-09" && session.source === "plan"
          ? { ...session, status: "skipped" }
          : session,
      ),
    });
    renderToday();

    const rows = await weekRows();
    expect(
      within(rows[1]!)
        .getAllByRole("link", { name: /, / })
        .map((link) => link.getAttribute("aria-label")),
    ).toEqual(["Easy, Skipped", "Hill reps, Tempo, 7.1 km, 41:04, Waiting to send"]);
    expect(within(rows[1]!).getByText("Easy").parentElement).toHaveClass("text-ink-2");
  });

  it("names the type of a titled custom workout beside its type colour, untitled ones by the type alone (type name)", async () => {
    const titled = customSessionFixture();
    const untitled = customSessionFixture({
      id: "c0ffee00-0000-4000-8000-000000000002",
      date: "2026-10-10",
      type: "long",
      title: null,
    });
    fakeWeekApi({ calendar: weekCalendar({ extra: [titled, untitled] }) });
    renderToday();

    const rows = await weekRows();
    const link = within(rows[1]!).getByRole("link", { name: /^Hill reps,/ });
    expect(link).toHaveAccessibleName("Hill reps, Tempo, 7.1 km, 41:04, Waiting to send");
    expect(within(link).getByText("Hill reps").querySelector("span")).toHaveClass("bg-type-tempo");
    expect(within(link).getByText("Tempo")).toHaveClass("text-caption");
    expect(
      within(rows[2]!).getByRole("link", { name: "Long run, 7.1 km, 41:04, Waiting to send" }),
    ).toBeInTheDocument();
    expect(within(rows[2]!).getAllByText(/Long run/)).toHaveLength(1);
  });

  it("puts each session's Garmin state on a line of its own under distance and time (caption line)", async () => {
    fakeWeekApi();
    renderToday();

    const rows = await weekRows();
    const link = within(rows[3]!).getByRole("link", { name: /^Long run,/ });
    const lines = Array.from(link.children).map((line) => line.textContent);
    expect(lines).toEqual(["Long run", "14.0 km·1:24:30", "Waiting to send"]);
    expect(within(link).getByText("Waiting to send")).toHaveClass("text-caption", "text-ink-2");
  });

  it("leaves the next 7 days out for a runner without an active plan (no plan)", async () => {
    fakeWeekApi({ calendar: weekCalendar({ paces: null }) });
    renderToday();

    expect(await screen.findByRole("region", { name: "Latest run" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("region", { name: "Next 7 days" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to Garmin" })).not.toBeInTheDocument();
  });

  it("shows the week's skeleton in its final layout while the calendar loads", async () => {
    fakeWeekApi({ calendar: () => never() });
    renderToday();

    expect(await screen.findByRole("region", { name: "Latest run" })).toBeInTheDocument();
    const week = screen.getByRole("region", { name: "Next 7 days" });
    expect(
      within(week).getByRole("status", { name: "Loading the next 7 days" }),
    ).toBeInTheDocument();
    expect(within(week).queryByRole("link")).not.toBeInTheDocument();
  });

  it("explains a failed calendar load beside the latest run and loads it again on Retry", async () => {
    let attempts = 0;
    fakeWeekApi({
      calendar: () => {
        attempts += 1;
        return attempts === 1 ? problem(500, ErrorCode.internal) : json(weekCalendar());
      },
    });
    renderToday();

    const week = await loadedWeek();
    expect(within(week).getByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("region", { name: "Latest run" })).toBeInTheDocument();
    await userEvent.click(within(week).getByRole("button", { name: "Retry" }));

    expect(await weekRows()).toHaveLength(7);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Send to Garmin, which queues a push and then says it is sending", async () => {
    const calls = fakeWeekApi();
    renderToday();
    const week = await loadedWeek();

    await userEvent.click(within(week).getByRole("button", { name: "Send to Garmin" }));

    expect(await within(week).findByRole("status")).toHaveTextContent(
      "Sending workouts to Garmin.",
    );
    expect(within(week).queryByRole("button", { name: "Send to Garmin" })).not.toBeInTheDocument();
    expect(
      await within(week).findByRole("link", { name: "Easy, 5.0 km, 30:00, Sending" }),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      expect.objectContaining({ path: "/api/calendar/push", body: undefined }),
    ]);
  });

  it("says why the last push stopped, marks the sessions Not sent and retries with Send to Garmin (Garmin outage)", async () => {
    fakeWeekApi({
      calendar: weekCalendar({
        garmin: garminPushStatusFixture({ error: ErrorCode.garminUnavailable }),
      }),
    });
    renderToday();
    const week = await loadedWeek();

    expect(within(week).getByRole("alert")).toHaveTextContent(errorMessages.garmin_unavailable);
    expect(
      within(week).getByRole("link", { name: "Easy, 5.0 km, 30:00, Not sent" }),
    ).toBeInTheDocument();
    await userEvent.click(within(week).getByRole("button", { name: "Send to Garmin" }));

    expect(await within(week).findByRole("status")).toHaveTextContent(
      "Sending workouts to Garmin.",
    );
    expect(within(week).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("points to Settings in one sentence when Garmin is not connected, with sessions Not on Garmin", async () => {
    fakeWeekApi({
      me: notConnectedMe,
      calendar: weekCalendar(
        { garmin: garminPushStatusFixture({ connection: "not_connected", pushedAt: null }) },
        (session) => ({ ...session, onGarmin: false }),
      ),
    });
    renderToday();
    const week = await loadedWeek();

    expect(within(week).getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/settings/garmin",
    );
    expect(
      within(week).getByRole("link", { name: "Intervals, 11.6 km, 1:04:00, Not on Garmin" }),
    ).toBeInTheDocument();
    // Not feeling 100% is the week's one button: the push line offers no Send to Garmin.
    expect(
      within(week)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Not feeling 100%"]);
  });

  it("adds no push line while the login is expired, Reconnect Garmin already says it (token expiry)", async () => {
    fakeWeekApi({
      me: expiredMe,
      calendar: weekCalendar({ garmin: garminPushStatusFixture({ connection: "expired" }) }),
    });
    renderToday();
    const week = await loadedWeek();

    expect(header()).toContainElement(screen.getByRole("link", { name: "Reconnect Garmin" }));
    expect(
      within(week)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Not feeling 100%"]);
    expect(within(week).queryByRole("alert")).not.toBeInTheDocument();
    expect(
      within(week).getByRole("link", { name: "Easy, 5.0 km, 30:00, Not on Garmin" }),
    ).toBeInTheDocument();
  });

  it("reads /api/me again when the calendar finds the login expired first, so the header says Reconnect Garmin (token expiry)", async () => {
    let meReads = 0;
    const calls = fakeWeekApi({
      me: () => {
        meReads += 1;
        return meReads === 1 ? meFixture() : expiredMe;
      },
      calendar: weekCalendar({ garmin: garminPushStatusFixture({ connection: "expired" }) }),
    });
    renderToday();
    const week = await loadedWeek();

    expect(await screen.findByRole("link", { name: "Reconnect Garmin" })).toBeInTheDocument();
    expect(header()).toContainElement(screen.getByRole("link", { name: "Reconnect Garmin" }));
    expect(screen.getByText(errorMessages.garmin_auth_expired)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sync now" })).not.toBeInTheDocument();
    expect(
      within(week).getByRole("link", { name: "Easy, 5.0 km, 30:00, Not on Garmin" }),
    ).toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/me")).toHaveLength(2);
  });

  it("lists the Garmin workouts the app did not create and unschedules one", async () => {
    const calls = fakeWeekApi({
      calendar: weekCalendar({
        garmin: garminPushStatusFixture({
          others: [{ scheduleId: 9001, date: "2026-10-09", title: "Club tempo" }],
        }),
      }),
    });
    renderToday();

    const others = await screen.findByRole("region", { name: "Also on your Garmin calendar" });
    expect(within(others).getByText("Club tempo")).toBeInTheDocument();
    expect(within(others).getByText("Fri 9 Oct")).toBeInTheDocument();
    await userEvent.click(
      within(others).getByRole("button", { name: "Unschedule Club tempo on Fri 9 Oct" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Also on your Garmin calendar" }),
      ).not.toBeInTheDocument(),
    );
    expect(calls.find((call) => call.path === "/api/calendar/unschedule")?.body).toEqual({
      scheduleIds: [9001],
    });
  });

  it("keeps a workout that failed to unschedule with the reason beside it (Garmin 429)", async () => {
    fakeWeekApi({
      calendar: weekCalendar({
        garmin: garminPushStatusFixture({
          others: [
            { scheduleId: 9001, date: "2026-10-09", title: "Club tempo" },
            { scheduleId: 9002, date: "2026-10-11", title: null },
          ],
        }),
      }),
      unschedule: () => problem(429, ErrorCode.garminRateLimited),
    });
    renderToday();

    const others = await screen.findByRole("region", { name: "Also on your Garmin calendar" });
    await userEvent.click(
      within(others).getByRole("button", { name: "Unschedule Untitled workout on Sun 11 Oct" }),
    );

    const [first, second] = within(others).getAllByRole("listitem");
    expect(await within(second!).findByRole("alert")).toHaveTextContent(
      errorMessages.garmin_rate_limited,
    );
    expect(within(first!).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(second!).getByRole("button", { name: /^Unschedule/ })).toBeEnabled();
  });

  it("unschedules one workout at a time and keeps each failure beside its workout (double tap)", async () => {
    let answer: (response: Response) => void = () => {};
    const calls = fakeWeekApi({
      calendar: weekCalendar({
        garmin: garminPushStatusFixture({
          others: [
            { scheduleId: 9001, date: "2026-10-09", title: "Club tempo" },
            { scheduleId: 9002, date: "2026-10-11", title: null },
          ],
        }),
      }),
      unschedule: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    renderToday();

    const others = await screen.findByRole("region", { name: "Also on your Garmin calendar" });
    const [first, second] = within(others).getAllByRole("listitem");
    await userEvent.click(within(first!).getByRole("button", { name: /^Unschedule/ }));

    expect(within(first!).getByRole("button", { name: /^Unschedule/ })).toHaveTextContent(
      "Unscheduling…",
    );
    expect(within(first!).getByRole("button", { name: /^Unschedule/ })).toBeDisabled();
    expect(within(second!).getByRole("button", { name: /^Unschedule/ })).toBeDisabled();
    await userEvent.click(within(second!).getByRole("button", { name: /^Unschedule/ }));
    expect(calls.filter((call) => call.path === "/api/calendar/unschedule")).toHaveLength(1);

    answer(problem(429, ErrorCode.garminRateLimited));
    expect(await within(first!).findByRole("alert")).toHaveTextContent(
      errorMessages.garmin_rate_limited,
    );
    await userEvent.click(within(second!).getByRole("button", { name: /^Unschedule/ }));
    expect(within(first!).getByRole("button", { name: /^Unschedule/ })).toBeDisabled();
    answer(problem(502, ErrorCode.garminUnavailable));

    expect(await within(second!).findByRole("alert")).toHaveTextContent(
      errorMessages.garmin_unavailable,
    );
    expect(within(first!).getByRole("alert")).toHaveTextContent(errorMessages.garmin_rate_limited);
    expect(within(first!).getByRole("button", { name: /^Unschedule/ })).toBeEnabled();
    expect(
      calls.filter((call) => call.path === "/api/calendar/unschedule").map((call) => call.body),
    ).toEqual([{ scheduleIds: [9001] }, { scheduleIds: [9002] }]);
  });

  it("starts the week on the runner's date, not the device's UTC one (time zones)", async () => {
    // 23:30 UTC on Wed 7 Oct is 00:30 on Thu 8 Oct in London.
    vi.setSystemTime(new Date("2026-10-07T23:30:00Z"));
    const calls = fakeWeekApi();
    renderToday();

    const rows = await weekRows();
    expect(rows[0]?.querySelector("time")).toHaveAttribute("datetime", "2026-10-08");
    expect(calls.find((call) => call.path === "/api/calendar")?.query.get("from")).toBe(
      "2026-10-08",
    );
  });

  it("shows distances in mi when the runner uses miles (unit conversion)", async () => {
    fakeWeekApi({ me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }) });
    renderToday();

    const rows = await weekRows();
    expect(
      within(rows[0]!).getByRole("link", { name: "Intervals, 7.2 mi, 1:04:00, On Garmin" }),
    ).toBeInTheDocument();
  });
});

const PAUSE_QUESTION =
  "Pause your training? Sessions from today come off your watch until you are back.";
const SICK_ADVICE =
  "Rest while you are ill. Run again once you have had no fever for a day and an easy walk feels normal. See a doctor if it lasts more than a week, or straight away for chest pain or trouble breathing.";
const INJURED_ADVICE =
  "Stop running on it. Pain that changes how you walk or run, swelling, or pain that lasts more than a few days needs a doctor or physio. Come back once you can walk without pain.";
const BREAK_ADVICE = "Take the time you need. When you come back, the plan restarts gently.";
const NOT_MEDICAL_ADVICE = "This is not medical advice.";

/** The week from Thu 8 Oct with every session paused and off the watch, as the API reads it mid-pause. */
function pausedWeek(): CalendarResponse {
  return weekCalendar({}, (session) => ({ ...session, paused: true, onGarmin: false }));
}

const findPausedCard = (day = "Thu 8 Oct") =>
  screen.findByRole("region", { name: `Training paused since ${day}` });

async function openPausePanel() {
  const week = await loadedWeek();
  await userEvent.click(within(week).getByRole("button", { name: "Not feeling 100%" }));
  return within(week).getByRole("group", { name: PAUSE_QUESTION });
}

describe("TodayScreen pause", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("offers Not feeling 100% beside the Next 7 days heading with an active plan", async () => {
    fakeWeekApi();
    renderToday();

    const week = await loadedWeek();
    const entry = within(week).getByRole("button", { name: "Not feeling 100%" });
    expect(
      within(week).getByRole("heading", { name: "Next 7 days" }).parentElement,
    ).toContainElement(entry);
    expect(entry).toHaveAttribute("data-variant", "secondary");
  });

  it("leaves Not feeling 100% out and never asks for a pause without an active plan (no plan)", async () => {
    const calls = fakeWeekApi({ calendar: weekCalendar({ paces: null }) });
    renderToday();

    expect(await screen.findByRole("region", { name: "Latest run" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Not feeling 100%" })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === "/api/pause")).toBe(false);
  });

  it("keeps the week's skeleton until the pause is read too, so the paused card never pushes it down (pause loading)", async () => {
    const calls = fakeWeekApi({ pause: () => never() });
    renderToday();

    await vi.waitFor(() => expect(calls.some((call) => call.path === "/api/pause")).toBe(true));
    const week = screen.getByRole("region", { name: "Next 7 days" });
    expect(
      within(week).getByRole("status", { name: "Loading the next 7 days" }),
    ).toBeInTheDocument();
    expect(within(week).queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not feeling 100%" })).not.toBeInTheDocument();
  });

  it("explains a failed pause read beside the week and reads it again on Retry (pause load error)", async () => {
    let attempts = 0;
    fakeWeekApi({
      pause: () => {
        attempts += 1;
        return attempts === 1 ? problem(500, ErrorCode.internal) : json({ pause: null });
      },
    });
    renderToday();

    const week = await loadedWeek();
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(within(week).getAllByRole("listitem")).toHaveLength(7);
    expect(
      within(week).queryByRole("button", { name: "Not feeling 100%" }),
    ).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await within(week).findByRole("button", { name: "Not feeling 100%" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the choice in place with focus on its question, and Keep training closes it with focus back (pause panel focus)", async () => {
    const calls = fakeWeekApi();
    renderToday();

    const panel = await openPausePanel();
    expect(within(panel).getByText(PAUSE_QUESTION)).toHaveFocus();
    expect(
      within(panel)
        .getAllByRole("radio")
        .map((radio) => radio.closest("label")?.textContent),
    ).toEqual(["Sick", "Pain or injury", "Need a break"]);
    expect(within(panel).getByRole("button", { name: "Pause training" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Not feeling 100%" })).not.toBeInTheDocument();

    await userEvent.click(within(panel).getByRole("button", { name: "Keep training" }));

    expect(screen.queryByRole("group", { name: PAUSE_QUESTION })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not feeling 100%" })).toHaveFocus();
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it.each([
    { reason: "Sick", advice: SICK_ADVICE, medical: true },
    { reason: "Pain or injury", advice: INJURED_ADVICE, medical: true },
    { reason: "Need a break", advice: BREAK_ADVICE, medical: false },
  ])(
    "shows the advice for $reason under the reasons, and the not-medical-advice line only for illness or injury (pause panel $reason)",
    async ({ reason, advice, medical }) => {
      fakeWeekApi();
      renderToday();

      const panel = await openPausePanel();
      expect(within(panel).queryByText(advice)).not.toBeInTheDocument();
      await userEvent.click(within(panel).getByRole("radio", { name: reason }));

      expect(within(panel).getByText(advice)).toHaveClass("text-body", "text-ink");
      if (medical) {
        expect(within(panel).getByText(NOT_MEDICAL_ADVICE)).toHaveClass(
          "text-caption",
          "text-ink-2",
        );
      } else {
        expect(within(panel).queryByText(NOT_MEDICAL_ADVICE)).not.toBeInTheDocument();
      }
      expect(within(panel).getByRole("button", { name: "Pause training" })).toBeEnabled();
    },
  );

  it("starts the next opening with no reason chosen (pause panel reopened)", async () => {
    fakeWeekApi();
    renderToday();

    let panel = await openPausePanel();
    await userEvent.click(within(panel).getByRole("radio", { name: "Sick" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Keep training" }));
    panel = await openPausePanel();

    expect(within(panel).getByRole("radio", { name: "Sick" })).not.toBeChecked();
    expect(within(panel).queryByText(SICK_ADVICE)).not.toBeInTheDocument();
  });

  it("pauses training for the reason chosen, then shows the paused card above the week with I'm back and every session Paused (pause)", async () => {
    const calls = fakeWeekApi();
    renderToday();

    const panel = await openPausePanel();
    await userEvent.click(within(panel).getByRole("radio", { name: "Pain or injury" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Pause training" }));

    const card = await findPausedCard();
    const title = within(card).getByRole("heading", { name: "Training paused since Thu 8 Oct" });
    await waitFor(() => expect(title).toHaveFocus());
    expect(within(card).getByText(INJURED_ADVICE)).toBeInTheDocument();
    expect(within(card).getByText(NOT_MEDICAL_ADVICE)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "I'm back" })).toBeEnabled();
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path === "/api/pause")
        .map((c) => c.body),
    ).toEqual([{ reason: "injured" }]);

    const week = screen.getByRole("region", { name: "Next 7 days" });
    expect(card.compareDocumentPosition(week) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows = within(week).getAllByRole("listitem");
    expect(
      within(rows[0]!).getByRole("link", { name: "Intervals, 11.6 km, 1:04:00, Paused" }),
    ).toBeInTheDocument();
    expect(
      within(rows[6]!).getByRole("link", { name: "Strength, 30:00, Paused" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: PAUSE_QUESTION })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not feeling 100%" })).not.toBeInTheDocument();
  });

  it("shows an open pause as the paused card on load, without taking focus (paused card)", async () => {
    fakeWeekApi({
      pause: trainingPauseFixture({ reason: "break", startDate: "2026-10-06" }),
      calendar: pausedWeek(),
    });
    renderToday();

    const card = await findPausedCard("Tue 6 Oct");
    expect(within(card).getByText(BREAK_ADVICE)).toBeInTheDocument();
    expect(within(card).queryByText(NOT_MEDICAL_ADVICE)).not.toBeInTheDocument();
    expect(within(card).getByRole("heading")).not.toHaveFocus();
    expect(screen.queryByRole("button", { name: "Not feeling 100%" })).not.toBeInTheDocument();
  });

  it("keeps the sick advice and its not-medical-advice line on the paused card (paused card sick)", async () => {
    fakeWeekApi({ pause: trainingPauseFixture({ reason: "sick" }), calendar: pausedWeek() });
    renderToday();

    const card = await findPausedCard();
    expect(within(card).getByText(SICK_ADVICE)).toBeInTheDocument();
    expect(within(card).getByText(NOT_MEDICAL_ADVICE)).toBeInTheDocument();
  });

  it("says why Pause training failed with Retry, which sends the same reason again (pause error)", async () => {
    let attempts = 0;
    const calls = fakeWeekApi({
      startPause: () => {
        attempts += 1;
        return attempts === 1
          ? problem(500, ErrorCode.internal)
          : json({ pause: trainingPauseFixture({ reason: "sick" }) });
      },
    });
    renderToday();

    const panel = await openPausePanel();
    await userEvent.click(within(panel).getByRole("radio", { name: "Sick" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Pause training" }));

    expect(await within(panel).findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.queryByRole("region", { name: /^Training paused/ })).not.toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Retry" }));

    expect(await findPausedCard()).toBeInTheDocument();
    expect(
      calls
        .filter((call) => call.method === "POST" && call.path === "/api/pause")
        .map((c) => c.body),
    ).toEqual([{ reason: "sick" }, { reason: "sick" }]);
  });

  it("opens the panel again without the last failure's alert (pause error reopened)", async () => {
    fakeWeekApi({ startPause: () => problem(500, ErrorCode.internal) });
    renderToday();

    let panel = await openPausePanel();
    await userEvent.click(within(panel).getByRole("radio", { name: "Sick" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Pause training" }));
    expect(await within(panel).findByRole("alert")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "Keep training" }));
    panel = await openPausePanel();

    expect(within(panel).queryByRole("alert")).not.toBeInTheDocument();
  });

  it.each([
    {
      case: "0.7 walk-run",
      reEntry: { daysOff: 9, factor: 0.7, walkRun: true },
      line: "9 days off: the next sessions are eased to 70% and build back up by at most 10% a week. The next 7 days are walk-run.",
    },
    {
      case: "0.5",
      reEntry: { daysOff: 15, factor: 0.5, walkRun: false },
      line: "15 days off: the next sessions are eased to 50% and build back up by at most 10% a week.",
    },
    {
      case: "1 walk-run",
      reEntry: { daysOff: 3, factor: 1, walkRun: true },
      line: "The next 7 days are walk-run, then the plan carries on.",
    },
    {
      case: "1",
      reEntry: { daysOff: 2, factor: 1, walkRun: false, sessionsChanged: 0 },
      line: "Your plan carries on as planned.",
    },
  ])(
    "skips the paused sessions on I'm back and says how the plan restarts (I'm back $case)",
    async ({ reEntry, line }) => {
      const calls = fakeWeekApi({
        pause: trainingPauseFixture(),
        calendar: pausedWeek(),
        endPause: endPauseResponseFixture(reEntry),
      });
      renderToday();

      const card = await findPausedCard();
      await userEvent.click(within(card).getByRole("button", { name: "I'm back" }));

      const outcome = await screen.findByRole("status");
      expect(outcome.textContent).toBe(line);
      await waitFor(() => expect(outcome).toHaveFocus());
      expect(screen.queryByRole("region", { name: /^Training paused/ })).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Not feeling 100%" })).toBeInTheDocument();
      const rows = await weekRows();
      expect(
        within(rows[0]!).getByRole("link", { name: "Intervals, Skipped during your pause" }),
      ).toBeInTheDocument();
      expect(calls.filter((call) => call.path === "/api/pause/end")).toHaveLength(1);
    },
  );

  it("offers no Add while a pause is open, since the API refuses a workout dated in it, and offers it again after I'm back (no add in pause)", async () => {
    fakeWeekApi({ pause: trainingPauseFixture(), calendar: pausedWeek() });
    renderToday();

    const card = await findPausedCard();
    const rows = await weekRows();
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(
        within(row).queryByRole("link", { name: /^Add a workout on / }),
      ).not.toBeInTheDocument();
    }
    await userEvent.click(within(card).getByRole("button", { name: "I'm back" }));

    expect(await screen.findByRole("status")).toBeInTheDocument();
    const after = await weekRows();
    for (const row of after) {
      expect(within(row).getByRole("link", { name: /^Add a workout on / })).toBeInTheDocument();
    }
  });

  it("closes the card without a line when the pause was already ended elsewhere (double I'm back)", async () => {
    fakeWeekApi({
      pause: trainingPauseFixture(),
      calendar: pausedWeek(),
      endPause: endPauseResponseFixture(null),
    });
    renderToday();

    const card = await findPausedCard();
    await userEvent.click(within(card).getByRole("button", { name: "I'm back" }));

    const entry = await screen.findByRole("button", { name: "Not feeling 100%" });
    await waitFor(() => expect(entry).toHaveFocus());
    expect(screen.queryByRole("region", { name: /^Training paused/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says why I'm back failed with Retry and keeps the pause until it goes through (I'm back error)", async () => {
    let attempts = 0;
    fakeWeekApi({
      pause: trainingPauseFixture(),
      calendar: pausedWeek(),
      endPause: () => {
        attempts += 1;
        return attempts === 1
          ? problem(500, ErrorCode.internal)
          : json(endPauseResponseFixture({ factor: 1, walkRun: false }));
      },
    });
    renderToday();

    const card = await findPausedCard();
    await userEvent.click(within(card).getByRole("button", { name: "I'm back" }));

    expect(await within(card).findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(within(card).getByRole("button", { name: "I'm back" })).toBeEnabled();
    await userEvent.click(within(card).getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Your plan carries on as planned.");
  });

  it("drops the last I'm back line once a new pause starts (pause again)", async () => {
    fakeWeekApi({ pause: trainingPauseFixture(), calendar: pausedWeek() });
    renderToday();

    await userEvent.click(within(await findPausedCard()).getByRole("button", { name: "I'm back" }));
    expect(await screen.findByRole("status")).toBeInTheDocument();
    const panel = await openPausePanel();
    await userEvent.click(within(panel).getByRole("radio", { name: "Need a break" }));
    await userEvent.click(within(panel).getByRole("button", { name: "Pause training" }));

    expect(await findPausedCard()).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("TodayScreen session status", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads a done session as Done and a paused one as Paused, in place of their Garmin state (session status)", async () => {
    fakeWeekApi({
      calendar: weekCalendar({}, (session) =>
        session.date === WEEK_FROM
          ? doneSessionFixture(WEEK_FROM, { onGarmin: true })
          : session.date === "2026-10-09"
            ? pausedSessionFixture("2026-10-09")
            : session,
      ),
    });
    renderToday();

    const rows = await weekRows();
    expect(
      within(rows[0]!).getByRole("link", { name: "Intervals, 11.6 km, 1:04:00, Done" }),
    ).toBeInTheDocument();
    expect(
      within(rows[1]!).getByRole("link", { name: "Easy, 5.0 km, 30:00, Paused" }),
    ).toBeInTheDocument();
  });

  it("says what a session the coach or a return changed was, on a line under its Garmin state (adjusted session)", async () => {
    const changed = new Map(
      [coachEasySessionFixture(), coachRestSessionFixture(), easedSessionFixture()].map(
        (session) => [session.date, session],
      ),
    );
    fakeWeekApi({
      calendar: weekCalendar({}, (session) => changed.get(session.date) ?? session),
    });
    renderToday();

    const rows = await weekRows();
    expect(within(rows[0]!).getByRole("link", { name: /^Easy,/ })).toHaveAccessibleName(
      "Easy, 10.6 km, 1:04:00, Waiting to send, Changed by the coach, was Intervals 11.6 km",
    );
    // A coach rest says it was skipped once, in its own words.
    expect(within(rows[1]!).getByRole("link", { name: /^Easy,/ })).toHaveAccessibleName(
      "Easy, Skipped by the coach",
    );
    const eased = within(rows[3]!).getByRole("link", { name: /^Long run,/ });
    expect(Array.from(eased.children).map((line) => line.textContent)).toEqual([
      "Long run",
      "9.8 km·59:09",
      "Waiting to send",
      "Eased for your return, was 14.0 km",
    ]);
    expect(within(eased).getByText("Eased for your return, was 14.0 km")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
  });

  it("gives what an eased session was in mi when the runner uses miles (unit conversion)", async () => {
    fakeWeekApi({
      me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }),
      calendar: weekCalendar({}, (session) =>
        session.date === "2026-10-11" ? easedSessionFixture("gap") : session,
      ),
    });
    renderToday();

    const rows = await weekRows();
    expect(within(rows[3]!).getByText("Eased for your return, was 8.7 mi")).toBeInTheDocument();
  });

  it("says a session left in the pause was skipped during it, in one line (pause rest)", async () => {
    fakeWeekApi({
      calendar: weekCalendar({}, (session) =>
        session.date === "2026-10-09" ? pauseSkippedSessionFixture("2026-10-09") : session,
      ),
    });
    renderToday();

    const rows = await weekRows();
    const skipped = within(rows[1]!).getByRole("link", { name: /^Easy,/ });
    expect(skipped).toHaveAccessibleName("Easy, Skipped during your pause");
    expect(Array.from(skipped.children).map((line) => line.textContent)).toEqual([
      "Easy",
      "Skipped during your pause",
    ]);
  });

  it.each([
    { case: "run matching", failure: undefined },
    { case: "partial sync", failure: problem(502, ErrorCode.garminUnavailable) },
  ])(
    "reads the week again after Sync now and shows the session its run completed as Done ($case)",
    async ({ failure }) => {
      const calls = fakeWeekApi({
        sync: {
          change: (session) =>
            session.date === WEEK_FROM
              ? doneSessionFixture(WEEK_FROM, { onGarmin: true })
              : session,
          failure,
        },
      });
      renderToday();

      const rows = await weekRows();
      expect(
        within(rows[0]!).getByRole("link", { name: "Intervals, 11.6 km, 1:04:00, On Garmin" }),
      ).toBeInTheDocument();
      const reads = () => calls.filter((call) => call.path === "/api/calendar").length;
      const before = reads();
      await userEvent.click(within(header()!).getByRole("button", { name: "Sync now" }));

      expect(
        await screen.findByRole("link", { name: "Intervals, 11.6 km, 1:04:00, Done" }),
      ).toBeInTheDocument();
      expect(reads()).toBe(before + 1);
    },
  );
});

/** A runner whose coach has a credential, a saved key: a review is there most of the week. */
const meWithKey = meFixture({
  settings: { ...meFixture().settings, hasClaudeKey: true, coachCredential: "key" },
});

const reviewRegion = () => screen.queryByRole("region", { name: "Weekly review" });
const findReviewRegion = () => screen.findByRole("region", { name: "Weekly review" });

describe("TodayScreen weekly review", () => {
  it("sits between the latest run and the next 7 days when ready, with Open weekly reviews opening the list", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
    try {
      fakeWeekApi({ review: latestReviewReadyFixture() });
      const { router } = renderToday();
      await loadedWeek();
      const review = await findReviewRegion();

      const order = screen
        .getAllByRole("region")
        .map((region) => region.getAttribute("aria-label"))
        .filter(
          (name) => name === "Latest run" || name === "Weekly review" || name === "Next 7 days",
        );
      expect(order).toEqual(["Latest run", "Weekly review", "Next 7 days"]);
      expect(within(review).getByRole("heading", { name: "Weekly review" })).toHaveClass(
        "text-body",
        "font-semibold",
      );
      expect(
        within(review).getByText(weeklyReviewCardFixture().content.headline),
      ).toBeInTheDocument();
      // Today's own Next 7 days is the coming week, so the card leaves its preview out.
      expect(within(review).queryByRole("region", { name: "Coming week" })).toBeNull();

      const past = within(review).getByRole("link", { name: "Open weekly reviews" });
      expect(past).toHaveAttribute("href", "/plan/reviews");
      await userEvent.click(past);
      expect(router.state.location.pathname).toBe("/plan/reviews");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the week's numbers, parts and the engine's change on the card", async () => {
    fakeTodayApi({ review: latestReviewReadyFixture() });
    renderToday();
    const review = await findReviewRegion();

    expect(within(review).getByText("5–11 Oct")).toBeInTheDocument();
    expect(
      within(review).getByText("Sessions", { selector: "span" }).parentElement,
    ).toHaveTextContent("Sessions4of 5");
    expect(
      within(review).getByText("Sun 18 Long run 18.0 km → Long run 16.2 km"),
    ).toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Helpful" })).toBeInTheDocument();
  });

  it("gives the card's distances in mi when the runner uses miles (unit conversion)", async () => {
    fakeTodayApi({
      me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }),
      review: latestReviewReadyFixture(),
    });
    renderToday();
    const review = await findReviewRegion();

    expect(
      within(review).getByText("Distance", { selector: "span" }).parentElement,
    ).toHaveTextContent("Distance19.5of 23.6 mi");
    expect(
      within(review).getByText("Sun 18 Long run 11.2 mi → Long run 10.1 mi"),
    ).toBeInTheDocument();
  });

  it("stores a thumb from Today's card and shows it pressed (thumbs stored)", async () => {
    const calls = fakeTodayApi({ review: latestReviewReadyFixture() });
    renderToday();
    const helpful = await within(await findReviewRegion()).findByRole("button", {
      name: "Helpful",
    });

    await userEvent.click(helpful);

    await waitFor(() => expect(helpful).toHaveAttribute("aria-pressed", "true"));
    expect(calls.filter((call) => call.method === "PUT")).toEqual([
      expect.objectContaining({
        path: `/api/reviews/${REVIEW_ID}/feedback`,
        body: { feedback: "up" },
      }),
    ]);
  });

  it("shows a fallback review's reason in place of what it means, without thumbs or Try again (fallback card)", async () => {
    const fallback = fallbackReviewFixture("timeout");
    fakeTodayApi({ review: latestReviewReadyFixture(fallback) });
    renderToday();
    const review = await findReviewRegion();

    expect(within(review).getByText(fallback.content.whatItMeans)).toBeInTheDocument();
    expect(within(review).queryByText("What it means")).not.toBeInTheDocument();
    expect(within(review).queryByRole("button", { name: "Helpful" })).not.toBeInTheDocument();
    expect(within(review).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("says the coach is writing the review in one line while it is pending (pending)", async () => {
    fakeTodayApi({ review: { state: "pending" } });
    renderToday();
    const review = await findReviewRegion();

    expect(within(review).getByRole("status")).toHaveTextContent(
      /^The coach is writing your weekly review\.$/,
    );
    expect(within(review).getByRole("status")).toHaveClass("text-body", "text-ink-2");
    expect(within(review).queryByRole("heading")).not.toBeInTheDocument();
    expect(within(review).queryByRole("link")).not.toBeInTheDocument();
  });

  it("says the coach is unavailable and will retry in one line while retrying (retrying)", async () => {
    fakeTodayApi({ review: { state: "retrying" } });
    renderToday();

    expect(within(await findReviewRegion()).getByRole("status")).toHaveTextContent(
      /^Coach unavailable, will retry your weekly review\.$/,
    );
  });

  it("says when the coach writes the review once the Claude plan's usage limit resets, in the runner's time zone (retrying, plan usage limit)", async () => {
    fakeTodayApi({
      me: meFixture({ settings: { ...meFixture().settings, timezone: "America/New_York" } }),
      review: { state: "retrying", resumesAt: "2026-10-12T13:00:00Z" },
    });
    renderToday();

    expect(within(await findReviewRegion()).getByRole("status")).toHaveTextContent(
      "Your Claude plan's usage limit is reached. The coach writes your weekly review Mon 12 Oct, 09:00.",
    );
  });

  it("shows nothing when there is no review to show (none)", async () => {
    fakeTodayApi({ review: { state: "none" } });
    renderToday();
    await screen.findByRole("region", { name: "Latest run" });

    await waitFor(() => expect(reviewRegion()).not.toBeInTheDocument());
    expect(screen.queryByText(/weekly review/i)).not.toBeInTheDocument();
  });

  it("keeps Today when the review fails to load, with the alert and Retry in its place, and loads it on Retry (failed query)", async () => {
    let failing = true;
    fakeTodayApi({
      review: () => (failing ? problem(500, ErrorCode.internal) : json(latestReviewReadyFixture())),
    });
    renderToday();

    const review = await findReviewRegion();
    expect(within(review).getByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("region", { name: "Latest run" })).toBeInTheDocument();
    expect(within(header()!).getByRole("button", { name: "Sync now" })).toBeInTheDocument();

    failing = false;
    await userEvent.click(within(review).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(weeklyReviewCardFixture().content.headline)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the card with an alert and Retry when a reload of the review fails", async () => {
    let failing = false;
    fakeTodayApi({
      review: () => (failing ? problem(503, ErrorCode.internal) : json(latestReviewReadyFixture())),
    });
    const { queryClient } = renderToday();
    await screen.findByText(weeklyReviewCardFixture().content.headline);

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: ["reviews"] }));

    const review = await findReviewRegion();
    expect(await within(review).findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(
      within(review).getByText(weeklyReviewCardFixture().content.headline),
    ).toBeInTheDocument();
  });

  it("holds the card's place while it loads for a runner whose coach has a credential", async () => {
    fakeTodayApi({ me: meWithKey, review: () => never() });
    renderToday();
    await screen.findByRole("region", { name: "Latest run" });

    expect(
      within(await findReviewRegion()).getByRole("status", { name: "Loading the weekly review" }),
    ).toBeInTheDocument();
  });

  it("holds no place while it loads for a runner without a coach credential, who never gets one", async () => {
    fakeTodayApi({ review: () => never() });
    renderToday();
    await screen.findByRole("region", { name: "Latest run" });

    expect(reviewRegion()).not.toBeInTheDocument();
  });

  it("shows a ready review in Today's empty state, before the first run", async () => {
    fakeTodayApi({ latest: null, review: latestReviewReadyFixture() });
    renderToday();

    expect(
      await screen.findByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();
    expect(
      within(await findReviewRegion()).getByText(weeklyReviewCardFixture().content.headline),
    ).toBeInTheDocument();
  });

  it.each([
    {
      case: "pending",
      me: meWithKey,
      review: (): Response => json({ state: "pending" }),
    },
    {
      case: "retrying",
      me: meWithKey,
      review: (): Response => json({ state: "retrying" }),
    },
    {
      case: "failed query, no coach credential",
      me: meFixture(),
      review: (): Response => problem(500, ErrorCode.internal),
    },
  ])(
    "shows nothing of the review in Today's empty state while it is not ready ($case)",
    async ({ me, review }) => {
      const calls = fakeTodayApi({ me, latest: null, review });
      renderToday();
      await screen.findByText("Sync now to bring in your latest run from Garmin.");
      await waitFor(() =>
        expect(calls.some((call) => call.path === "/api/reviews/latest")).toBe(true),
      );

      await waitFor(() => expect(reviewRegion()).not.toBeInTheDocument());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("explains a failed review read in Today's empty state with Retry when the coach has a credential, and loads it on Retry (empty state, failed query)", async () => {
    let failing = true;
    fakeTodayApi({
      me: meWithKey,
      latest: null,
      review: () => (failing ? problem(500, ErrorCode.internal) : json(latestReviewReadyFixture())),
    });
    renderToday();

    const review = await findReviewRegion();
    expect(within(review).getByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(
      screen.getByText("Sync now to bring in your latest run from Garmin."),
    ).toBeInTheDocument();

    failing = false;
    await userEvent.click(within(review).getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(weeklyReviewCardFixture().content.headline)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains a failed reload of a review still to come in Today's empty state with Retry when the coach has a credential (empty state, failed reload)", async () => {
    let failing = false;
    fakeTodayApi({
      me: meWithKey,
      latest: null,
      review: () => (failing ? problem(503, ErrorCode.internal) : json({ state: "pending" })),
    });
    const { queryClient } = renderToday();
    await screen.findByText("Sync now to bring in your latest run from Garmin.");
    await waitFor(() => expect(reviewRegion()).not.toBeInTheDocument());

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: ["reviews"] }));

    const review = await findReviewRegion();
    expect(await within(review).findByRole("alert")).toHaveTextContent(errorMessages.internal);
    // Still nothing about the review to come, only the failed read.
    expect(within(review).queryByRole("status")).not.toBeInTheDocument();

    failing = false;
    await userEvent.click(within(review).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(reviewRegion()).not.toBeInTheDocument());
  });

  it("reads the review again after Sync now, which queues the review of a week that has ended, and says the coach is writing it", async () => {
    let queued = false;
    const calls = fakeTodayApi({
      review: () => json(queued ? { state: "pending" } : { state: "none" }),
      sync: (_attempt, store) => {
        store();
        queued = true;
        return json({
          lastSyncAt: "2026-10-12T06:30:00Z",
          activitiesWritten: 1,
          activitiesRemoved: 0,
        });
      },
    });
    renderToday();
    await screen.findByRole("region", { name: "Latest run" });
    const reads = () => calls.filter((call) => call.path === "/api/reviews/latest").length;
    await waitFor(() => expect(reads()).toBe(1));

    await userEvent.click(within(header()!).getByRole("button", { name: "Sync now" }));

    expect(within(await findReviewRegion()).getByRole("status")).toHaveTextContent(
      "The coach is writing your weekly review.",
    );
    // Polled every few seconds from here on, so a slow run may have read it once more.
    expect(reads()).toBeGreaterThanOrEqual(2);
  });
});
