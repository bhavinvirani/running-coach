import type { ActivityWeeksResponse, ImportProgress, MeResponse } from "@running-coach/shared";
import { ErrorCode, RACE_EVENT_TYPE } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey, listKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { MISSING } from "@/lib/format";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { activityFixture, importProgressFixture, meFixture, weekFixture } from "@/test/fixtures";
import { holdPolls } from "@/test/held-polls";
import { renderScreen } from "@/test/render";
import { ProgressScreen } from "./progress-screen";

const polls = holdPolls();

/** Sun 27 Sep: 10.04 km in 52:18. */
const sundayRun = activityFixture();
/** Wed 23 Sep: 8 km in 42:00 without a heart rate. */
const wednesdayRun = activityFixture({
  id: "2c3d4e5f-6071-4b8c-9d0e-1f2a3b4c5d6e",
  startUtc: "2026-09-23T17:30:00Z",
  startLocal: "2026-09-23T18:30:00",
  distanceM: 8_000,
  durationS: 2_520,
  avgHr: null,
  maxHr: null,
});
/** Tue 22 Sep: a treadmill run without a footpod, so no distance and no pace. */
const treadmillRun = activityFixture({
  id: "3d4e5f60-7182-4c9d-8e0f-2a3b4c5d6e7f",
  type: "treadmill_running",
  startUtc: "2026-09-22T06:00:00Z",
  startLocal: "2026-09-22T07:00:00",
  distanceM: 0,
  durationS: 1_800,
  isIndoor: true,
});
/** Sat 1 Aug: a half marathon entered by hand. */
const manualRun = activityFixture({
  id: "4e5f6071-8293-4dae-9f10-3b4c5d6e7f80",
  startUtc: "2026-08-01T07:00:00Z",
  startLocal: "2026-08-01T08:00:00",
  distanceM: 21_100,
  durationS: 6_330,
  isManual: true,
});
/** Thu 1 Jan 2026: a run in the week that starts in 2025. */
const newYearRun = activityFixture({
  id: "5f607182-93a4-4ebf-8021-4c5d6e7f8091",
  startUtc: "2026-01-01T10:00:00Z",
  startLocal: "2026-01-01T10:00:00",
  distanceM: 5_000,
  durationS: 1_500,
});

/** 18.04 km in 2:04:18 over three runs. */
const latestWeek = weekFixture("2026-09-21", [sundayRun, wednesdayRun, treadmillRun]);
const summerWeek = weekFixture("2026-07-27", [manualRun]);
const newYearWeek = weekFixture("2025-12-29", [newYearRun]);

const firstPage: ActivityWeeksResponse = { weeks: [latestWeek], nextBefore: "2026-09-21" };
const secondPage: ActivityWeeksResponse = {
  weeks: [summerWeek, newYearWeek],
  nextBefore: null,
};
const noRuns: ActivityWeeksResponse = { weeks: [], nextBefore: null };

/** GET /api/activities pages, by their `before`; "latest" is the first page, which has none. */
type Pages = Record<string, ActivityWeeksResponse | (() => Response | Promise<Response>)>;

type FakeProgressApi = {
  me?: MeResponse;
  pages?: Pages;
  progress?: ImportProgress;
  /** Called with 1 for the first POST /api/import; "running" starts the import like the real API. */
  start?: (attempt: number) => "running" | Response | Promise<Response>;
};

/** /api/me, GET /api/activities by page and GET or POST /api/import, in memory. */
function fakeProgressApi({
  me = meFixture(),
  pages = { latest: firstPage, "2026-09-21": secondPage },
  progress = importProgressFixture({
    status: "done",
    runsStored: 4,
    finishedAt: "2026-10-01T06:52:00Z",
  }),
  start = () => "running",
}: FakeProgressApi = {}) {
  /** `importFails` makes GET /api/import answer a 502 until a test turns it off. */
  const api = { pages, progress, importFails: false };
  let starts = 0;
  const calls = stubFetch(({ method, path, query }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/activities") {
      const page = api.pages[query.get("before") ?? "latest"];
      if (page === undefined) return notFound();
      return typeof page === "function" ? page() : json(page);
    }
    if (method === "GET" && path === "/api/import") {
      return api.importFails ? problem(502, ErrorCode.internal) : json(api.progress);
    }
    if (method === "POST" && path === "/api/import") {
      starts += 1;
      const answer = start(starts);
      if (answer !== "running") return answer;
      api.progress = importProgressFixture({
        status: "running",
        runsStored: api.progress.runsStored,
        startedAt: "2026-10-02T06:40:00Z",
      });
      return json(api.progress);
    }
    return notFound();
  });
  return { api, calls };
}

function renderProgress() {
  return renderScreen(<ProgressScreen />, { path: "/progress" });
}

function importRegion() {
  return screen.getByRole("region", { name: "History import" });
}

/** The week's figure: total distance with its unit, then total time, "18.0km2:04:18". */
function weekTotals(week: HTMLElement) {
  return within(week).getByText((_, element) => element?.classList.contains("text-figure") ?? false)
    .parentElement;
}

function rows(week: HTMLElement) {
  return within(week).getAllByRole("listitem");
}

const miles = meFixture({ settings: { ...meFixture().settings, units: "mi" } });

describe("ProgressScreen", () => {
  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderProgress();
    expect(screen.getByRole("heading", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading your runs" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("explains a failed first load and loads again on Retry", async () => {
    let attempts = 0;
    fakeProgressApi({
      pages: {
        latest: () => {
          attempts += 1;
          return attempts === 1 ? problem(500, ErrorCode.internal) : json(firstPage);
        },
      },
    });
    renderProgress();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the weeks and offers Retry when a background reload fails", async () => {
    let failing = false;
    fakeProgressApi({
      pages: {
        latest: () => (failing ? problem(503, ErrorCode.internal) : json(firstPage)),
      },
    });
    const { queryClient } = renderProgress();
    const week = await screen.findByRole("region", { name: "21–27 Sep" });

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: listKey("activities", "weeks") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(weekTotals(week)).toHaveTextContent("18.0km");

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
  });

  it("keeps the weeks and offers Retry when the import's progress fails to load", async () => {
    const { api, calls } = fakeProgressApi();
    api.importFails = true;
    renderProgress();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "History import" })).not.toBeInTheDocument();

    api.importFails = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("4 runs · history imported 1 Oct 2026")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/activities")).toHaveLength(1);
  });

  it("asks for the import with one sentence and one Import history button when no run is stored", async () => {
    fakeProgressApi({ pages: { latest: noRuns }, progress: importProgressFixture() });
    renderProgress();

    expect(
      await screen.findByText("Import your Garmin history to see your runs by week."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Import history" })).toBeEnabled();
    expect(screen.queryByRole("region", { name: "History import" })).not.toBeInTheDocument();
  });

  it("starts the import from the empty state and shows its progress instead of a second button", async () => {
    const { calls } = fakeProgressApi({
      pages: { latest: noRuns },
      progress: importProgressFixture(),
    });
    renderProgress();

    await userEvent.click(await screen.findByRole("button", { name: "Import history" }));

    expect(
      await within(importRegion()).findByText("Importing history · starting"),
    ).toBeInTheDocument();
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      expect.objectContaining({ path: "/api/import", body: undefined }),
    ]);
  });

  it("shows a running import's progress over the empty list, with no button (import already running)", async () => {
    fakeProgressApi({
      pages: { latest: noRuns },
      progress: importProgressFixture({ status: "running", startedAt: "2026-10-02T06:40:00Z" }),
    });
    renderProgress();

    expect(
      await within(await screen.findByRole("region", { name: "History import" })).findByText(
        "Importing history · starting",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("No runs yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each([
    {
      status: "not started",
      progress: importProgressFixture(),
      line: "Import your full Garmin history.",
      action: "Import history",
    },
    {
      status: "running",
      progress: importProgressFixture({
        status: "running",
        runsStored: 340,
        oldestDate: "2021-03-14",
        startedAt: "2026-10-02T06:40:00Z",
      }),
      line: "Importing history · 340 runs · back to Mar 2021",
      action: null,
    },
    {
      status: "running, before its first page",
      progress: importProgressFixture({
        status: "running",
        runsStored: 4,
        startedAt: "2026-10-02T06:40:00Z",
      }),
      line: "Importing history · starting",
      action: null,
    },
    {
      status: "paused after a Garmin 429",
      progress: importProgressFixture({
        status: "paused",
        runsStored: 340,
        oldestDate: "2021-03-14",
        startedAt: "2026-10-02T06:40:00Z",
        resumeAt: "2026-10-02T13:05:00Z",
        errorCode: ErrorCode.garminRateLimited,
      }),
      // 13:05 UTC is 14:05 in London in October (BST).
      line: "Garmin is limiting requests. The import continues after 14:05.",
      action: null,
    },
    {
      status: "stalled",
      progress: importProgressFixture({
        status: "stalled",
        runsStored: 340,
        oldestDate: "2021-03-14",
        startedAt: "2026-10-02T06:40:00Z",
      }),
      line: "The import stopped. Resume import to carry on where it left off.",
      action: "Resume import",
    },
    {
      status: "failed on an expired Garmin login (token expiry)",
      progress: importProgressFixture({
        status: "failed",
        runsStored: 120,
        oldestDate: "2025-01-06",
        startedAt: "2026-10-02T06:40:00Z",
        errorCode: ErrorCode.garminAuthExpired,
      }),
      line: "Garmin login expired. Reconnect in Settings.",
      action: "Resume import",
    },
    {
      status: "failed on a Garmin outage",
      progress: importProgressFixture({
        status: "failed",
        runsStored: 120,
        oldestDate: "2025-01-06",
        startedAt: "2026-10-02T06:40:00Z",
        errorCode: ErrorCode.garminUnavailable,
      }),
      line: errorMessages.garmin_unavailable,
      action: "Resume import",
    },
    {
      status: "done",
      progress: importProgressFixture({
        status: "done",
        runsStored: 1_240,
        oldestDate: "2019-04-07",
        startedAt: "2026-10-02T06:40:00Z",
        finishedAt: "2026-10-02T06:52:00Z",
      }),
      line: "1,240 runs · history imported 2 Oct 2026",
      action: "Import again",
    },
  ])(
    "says where the import stands in one line when it is $status",
    async ({ progress, line, action }) => {
      fakeProgressApi({ progress });
      renderProgress();

      const region = await screen.findByRole("region", { name: "History import" });
      expect(within(region).getByText(line)).toBeInTheDocument();
      const buttons = within(region).queryAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(action ? [action] : []);
      // The weeks stay below the line whatever the import is doing.
      expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    },
  );

  it("reads a stopped import as an error sentence and a finished one as a caption with a quiet button", async () => {
    const { api } = fakeProgressApi({
      progress: importProgressFixture({
        status: "failed",
        runsStored: 120,
        startedAt: "2026-10-02T06:40:00Z",
        errorCode: ErrorCode.garminAuthExpired,
      }),
    });
    const { queryClient } = renderProgress();

    const failed = await screen.findByRole("alert");
    expect(failed).toHaveTextContent("Garmin login expired. Reconnect in Settings.");
    expect(failed).toHaveClass("text-ink");

    api.progress = importProgressFixture({
      status: "done",
      runsStored: 1,
      finishedAt: "2026-10-02T06:52:00Z",
    });
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("import") }));

    expect(await screen.findByText("1 run · history imported 2 Oct 2026")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
    expect(screen.getByRole("button", { name: "Import again" })).toHaveAttribute(
      "data-variant",
      "ghost",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows when a paused import continues in the runner's own time zone (time zones)", async () => {
    fakeProgressApi({
      me: meFixture({ settings: { ...meFixture().settings, timezone: "Asia/Kolkata" } }),
      progress: importProgressFixture({
        status: "paused",
        runsStored: 340,
        startedAt: "2026-10-02T06:40:00Z",
        resumeAt: "2026-10-02T13:05:00Z",
        errorCode: ErrorCode.garminRateLimited,
      }),
    });
    renderProgress();

    expect(
      await screen.findByText("Garmin is limiting requests. The import continues after 18:35."),
    ).toBeInTheDocument();
  });

  it.each([
    { from: "not started", status: "not_started", action: "Import history" },
    { from: "stalled", status: "stalled", action: "Resume import" },
    { from: "failed", status: "failed", action: "Resume import" },
    { from: "done", status: "done", action: "Import again" },
  ] as const)(
    "moves the import to running with $action when it is $from, without a second GET",
    async ({ status, action }) => {
      const { calls } = fakeProgressApi({
        progress: importProgressFixture({
          status,
          runsStored: 4,
          startedAt: status === "not_started" ? null : "2026-10-01T06:40:00Z",
          finishedAt: status === "done" ? "2026-10-01T06:52:00Z" : null,
          errorCode: status === "failed" ? ErrorCode.garminUnavailable : null,
        }),
      });
      renderProgress();

      await userEvent.click(await screen.findByRole("button", { name: action }));

      expect(
        await within(importRegion()).findByText("Importing history · starting"),
      ).toBeInTheDocument();
      expect(within(importRegion()).queryByRole("button")).not.toBeInTheDocument();
      expect(
        calls.filter((call) => call.path === "/api/import").map((call) => call.method),
      ).toEqual(["GET", "POST"]);
      // Running now, so the screen polls every 3 s.
      expect(polls.delays()).toContain(3_000);
    },
  );

  it("disables the import button while the POST is in flight", async () => {
    fakeProgressApi({ progress: importProgressFixture(), start: () => never() });
    renderProgress();

    await userEvent.click(await screen.findByRole("button", { name: "Import history" }));

    const button = screen.getByRole("button", { name: "Import history" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it.each([
    {
      corner: "Garmin not connected",
      answer: () => problem(409, ErrorCode.garminNotConnected),
      message: errorMessages.garmin_not_connected,
    },
    {
      corner: "expired Garmin login",
      answer: () => problem(409, ErrorCode.garminAuthExpired),
      message: "Garmin login expired. Reconnect in Settings.",
    },
    {
      corner: "server outage",
      answer: () => problem(500, ErrorCode.internal),
      message: errorMessages.internal,
    },
  ])(
    "explains a failed start under the line and starts on the next tap ($corner)",
    async ({ answer, message }) => {
      const { calls } = fakeProgressApi({
        progress: importProgressFixture(),
        start: (attempt) => (attempt === 1 ? answer() : "running"),
      });
      renderProgress();

      await userEvent.click(await screen.findByRole("button", { name: "Import history" }));

      const alert = await within(importRegion()).findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).toHaveClass("text-ink");
      expect(
        within(importRegion()).getByText("Import your full Garmin history."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import history" })).toBeEnabled();

      await userEvent.click(screen.getByRole("button", { name: "Import history" }));

      expect(
        await within(importRegion()).findByText("Importing history · starting"),
      ).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(2);
    },
  );

  it("explains a failed start from the empty state and keeps the sentence", async () => {
    fakeProgressApi({
      pages: { latest: noRuns },
      progress: importProgressFixture(),
      start: () => problem(409, ErrorCode.garminNotConnected),
    });
    renderProgress();

    await userEvent.click(await screen.findByRole("button", { name: "Import history" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_not_connected);
    expect(
      screen.getByText("Import your Garmin history to see your runs by week."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import history" })).toBeEnabled();
  });

  it("shows each week's range, total distance as the figure and total time, then its runs, in km", async () => {
    fakeProgressApi();
    renderProgress();

    const week = await screen.findByRole("region", { name: "21–27 Sep" });
    expect(within(week).getByRole("heading", { name: "21–27 Sep" })).toBeInTheDocument();
    expect(within(week).getByText("18.0")).toHaveClass("text-figure");
    expect(weekTotals(week)).toHaveTextContent(/^18\.0km2:04:18$/);
    expect(within(week).getByText("2:04:18")).toHaveClass("text-caption", "text-ink-2");

    const [sunday, wednesday, tuesday] = rows(week);
    expect(sunday).toHaveTextContent(/^Sun 27 Sep10\.0 km52:185:13 \/km$/);
    expect(wednesday).toHaveTextContent(/^Wed 23 Sep8\.0 km42:005:15 \/km$/);
    expect(tuesday).toHaveTextContent(new RegExp(`^Tue 22 SepIndoor${MISSING}30:00${MISSING}$`));
  });

  it("converts week totals, distances and paces to mi when the runner uses miles (unit conversion)", async () => {
    fakeProgressApi({ me: miles });
    renderProgress();

    const week = await screen.findByRole("region", { name: "21–27 Sep" });
    // 18.04 km is 11.21 mi.
    expect(weekTotals(week)).toHaveTextContent(/^11\.2mi2:04:18$/);
    const [sunday, wednesday] = rows(week);
    // 10.04 km is 6.24 mi at 8:23 a mile; 8 km is 4.97 mi at 8:27.
    expect(sunday).toHaveTextContent(/^Sun 27 Sep6\.2 mi52:188:23 \/mi$/);
    expect(wednesday).toHaveTextContent(/^Wed 23 Sep5\.0 mi42:008:27 \/mi$/);
  });

  it("renders runs without HR or distance with dashes, never NaN or 0 (missing HR, indoor run)", async () => {
    const treadmillWeek = weekFixture("2026-09-14", [
      activityFixture({
        ...treadmillRun,
        id: "60718293-a4b5-4fc0-9132-5d6e7f8091a2",
        startUtc: "2026-09-15T06:00:00Z",
        startLocal: "2026-09-15T07:00:00",
        avgHr: null,
        maxHr: null,
      }),
    ]);
    fakeProgressApi({
      pages: { latest: { weeks: [latestWeek, treadmillWeek], nextBefore: null } },
    });
    renderProgress();

    const week = await screen.findByRole("region", { name: "14–20 Sep" });
    expect(weekTotals(week)).toHaveTextContent(new RegExp(`^${MISSING}30:00$`));
    expect(rows(week)[0]).toHaveTextContent(
      new RegExp(`^Tue 15 SepIndoor${MISSING}30:00${MISSING}$`),
    );
    expect(document.body).not.toHaveTextContent(/NaN|Infinity|undefined/);
    expect(rows(screen.getByRole("region", { name: "21–27 Sep" }))[1]).toHaveTextContent(
      "5:15 /km",
    );
  });

  it("opens a run from anywhere on its row, a link at least 44 px tall", async () => {
    fakeProgressApi();
    const { router } = renderProgress();

    const week = await screen.findByRole("region", { name: "21–27 Sep" });
    const sunday = within(rows(week)[0] as HTMLElement).getByRole("link");
    expect(sunday).toHaveAccessibleName("Sun 27 Sep, 10.0 km, 52:18, 5:13 /km");
    const treadmill = within(rows(week)[2] as HTMLElement).getByRole("link");
    expect(treadmill).toHaveAccessibleName("Tue 22 Sep, Indoor, 30:00");
    expect(sunday).toHaveAttribute("href", `/runs/${sundayRun.id}`);
    expect(sunday).toHaveClass("min-h-12");
    expect(sunday.querySelector("svg")).toBeNull();

    await userEvent.click(within(sunday).getByText("52:18"));

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/runs/${sundayRun.id}`);
  });

  it("marks a race with a Race chip in its row and names it in the row's label", async () => {
    const race = activityFixture({ ...sundayRun, eventType: RACE_EVENT_TYPE });
    const indoorRace = activityFixture({ ...treadmillRun, eventType: RACE_EVENT_TYPE });
    const raceWeek = weekFixture("2026-09-21", [race, wednesdayRun, indoorRace]);
    fakeProgressApi({ pages: { latest: { weeks: [raceWeek], nextBefore: null } } });
    renderProgress();

    const week = await screen.findByRole("region", { name: "21–27 Sep" });
    const [sunday, wednesday, tuesday] = rows(week) as [HTMLElement, HTMLElement, HTMLElement];
    expect(sunday).toHaveTextContent(/^Sun 27 SepRace10\.0 km52:185:13 \/km$/);
    expect(within(sunday).getByText("Race").querySelector(".bg-type-race")).not.toBeNull();
    expect(within(sunday).getByRole("link")).toHaveAccessibleName(
      "Sun 27 Sep, Race, 10.0 km, 52:18, 5:13 /km",
    );
    expect(tuesday).toHaveTextContent(
      new RegExp(`^Tue 22 SepRace·Indoor${MISSING}30:00${MISSING}$`),
    );
    expect(within(tuesday).getByRole("link")).toHaveAccessibleName(
      "Tue 22 Sep, Race · Indoor, 30:00",
    );
    expect(within(wednesday).queryByText("Race")).not.toBeInTheDocument();
  });

  it("marks manual runs with a caption", async () => {
    fakeProgressApi({ pages: { latest: { weeks: [summerWeek], nextBefore: null } } });
    renderProgress();

    const week = await screen.findByRole("region", { name: "27 Jul – 2 Aug" });
    expect(within(week).getByText("Manual")).toHaveClass("text-caption", "text-ink-2");
    expect(rows(week)[0]).toHaveTextContent(/^Sat 1 AugManual21\.1 km1:45:305:00 \/km$/);
  });

  it("loads earlier weeks with Show earlier weeks, adding years to weeks of earlier years", async () => {
    const { calls } = fakeProgressApi();
    renderProgress();
    await screen.findByRole("region", { name: "21–27 Sep" });

    await userEvent.click(screen.getByRole("button", { name: "Show earlier weeks" }));

    expect(await screen.findByRole("region", { name: "27 Jul – 2 Aug" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "29 Dec 2025 – 4 Jan 2026" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    // The last page has no `nextBefore`, so the list ends there.
    expect(screen.queryByRole("button", { name: "Show earlier weeks" })).not.toBeInTheDocument();
    const pages = calls.filter((call) => call.path === "/api/activities");
    expect(pages.map((call) => Object.fromEntries(call.query))).toEqual([
      { weeks: "8" },
      { weeks: "8", before: "2026-09-21" },
    ]);
  });

  it("shows a skeleton week while earlier weeks load", async () => {
    fakeProgressApi({ pages: { latest: firstPage, "2026-09-21": () => never() } });
    renderProgress();

    await userEvent.click(await screen.findByRole("button", { name: "Show earlier weeks" }));

    expect(screen.getByRole("status", { name: "Loading earlier weeks" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show earlier weeks" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
  });

  it("explains failed earlier weeks inline, keeps the weeks shown, and loads them on Retry", async () => {
    let attempts = 0;
    fakeProgressApi({
      pages: {
        latest: firstPage,
        "2026-09-21": () => {
          attempts += 1;
          return attempts === 1 ? problem(502, ErrorCode.internal) : json(secondPage);
        },
      },
    });
    renderProgress();

    await userEvent.click(await screen.findByRole("button", { name: "Show earlier weeks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "27 Jul – 2 Aug" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the runs a running import stores as it polls (polling)", async () => {
    const { api, calls } = fakeProgressApi({
      pages: { latest: { weeks: [latestWeek], nextBefore: null } },
      progress: importProgressFixture({
        status: "running",
        runsStored: 3,
        oldestDate: "2026-09-22",
        startedAt: "2026-10-02T06:40:00Z",
      }),
    });
    renderProgress();
    expect(
      await screen.findByText("Importing history · 3 runs · back to Sep 2026"),
    ).toBeInTheDocument();
    expect(polls.delays()).toEqual([3_000]);

    api.pages = { latest: { weeks: [latestWeek, summerWeek], nextBefore: null } };
    api.progress = { ...api.progress, runsStored: 4, oldestDate: "2026-08-01" };
    act(() => polls.fire());

    expect(await screen.findByRole("region", { name: "27 Jul – 2 Aug" })).toBeInTheDocument();
    expect(screen.getByText("Importing history · 4 runs · back to Aug 2026")).toBeInTheDocument();
    expect(calls.filter((call) => call.path === "/api/activities")).toHaveLength(2);
  });

  it("keeps a Show earlier weeks tap still loading when a poll finds more runs, then refreshes the list (polling)", async () => {
    let releaseEarlier = () => {};
    let earlierRequests = 0;
    const { api, calls } = fakeProgressApi({
      pages: {
        latest: firstPage,
        "2026-09-21": () => {
          earlierRequests += 1;
          if (earlierRequests > 1) return json(secondPage);
          return new Promise<Response>((resolve) => {
            releaseEarlier = () => resolve(json(secondPage));
          });
        },
      },
      progress: importProgressFixture({
        status: "running",
        runsStored: 3,
        oldestDate: "2026-09-22",
        startedAt: "2026-10-02T06:40:00Z",
      }),
    });
    renderProgress();
    await userEvent.click(await screen.findByRole("button", { name: "Show earlier weeks" }));
    expect(screen.getByRole("status", { name: "Loading earlier weeks" })).toBeInTheDocument();

    api.progress = { ...api.progress, runsStored: 4 };
    act(() => polls.fire());
    expect(
      await screen.findByText("Importing history · 4 runs · back to Sep 2026"),
    ).toBeInTheDocument();
    const pages = () =>
      calls
        .filter((call) => call.path === "/api/activities")
        .map((call) => call.query.get("before") ?? "latest");
    expect(pages()).toEqual(["latest", "2026-09-21"]);

    act(() => releaseEarlier());

    expect(await screen.findByRole("region", { name: "27 Jul – 2 Aug" })).toBeInTheDocument();
    // The refresh comes after the earlier page and walks both pages again from the newest.
    await vi.waitFor(() =>
      expect(pages()).toEqual(["latest", "2026-09-21", "latest", "2026-09-21"]),
    );
    expect(
      await screen.findByRole("region", { name: "29 Dec 2025 – 4 Jan 2026" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "21–27 Sep" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show earlier weeks" })).not.toBeInTheDocument();
  });
});
