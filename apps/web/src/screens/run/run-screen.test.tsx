import type { Activity, ActivityDetail, MeResponse } from "@running-coach/shared";
import { ErrorCode, RACE_EVENT_TYPE } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { MISSING } from "@/lib/format";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { activityDetailFixture, activityFixture, meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { RunScreen } from "./run-screen";

/** What one POST .../detail answers: "stored" stores and returns the detail like the real API, or any response. */
type FetchAnswer = "stored" | Response | Promise<Response>;

type FakeRunApi = {
  me?: MeResponse;
  run?: Activity;
  /** The detail GET answers with: null until a fetch from Garmin stored one. */
  stored?: ActivityDetail | null;
  /** The detail Garmin holds, which a successful fetch stores. */
  garmin?: ActivityDetail;
  /** Called with 1 for the first fetch, 2 for the next. */
  fetchDetail?: (attempt: number) => FetchAnswer;
};

const run = activityFixture();
const runPath = `/api/activities/${run.id}`;

/** /api/me, GET /api/activities/:id and POST /api/activities/:id/detail, in memory. */
function fakeRunApi({
  me = meFixture(),
  run: activity = run,
  stored = null,
  garmin = activityDetailFixture(),
  fetchDetail = () => "stored",
}: FakeRunApi = {}) {
  let detail = stored;
  let fetches = 0;
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "GET" && path === `/api/activities/${activity.id}`) {
      return json({ activity, detail });
    }
    if (method === "POST" && path === `/api/activities/${activity.id}/detail`) {
      fetches += 1;
      const answer = fetchDetail(fetches);
      if (answer !== "stored") return answer;
      detail = garmin;
      return json({ activity, detail });
    }
    return notFound();
  });
}

function renderRun({ id = run.id, history }: { id?: string; history?: string[] } = {}) {
  return renderScreen(<RunScreen />, { route: "/runs/:id", path: `/runs/${id}`, history });
}

function detailFetches(calls: { method: string; path: string }[]) {
  return calls.filter((call) => call.method === "POST" && call.path === `${runPath}/detail`);
}

/** A Stat: the label and its figure are siblings, so their parent reads "Time52:18". */
function figure(label: string) {
  return screen.getByText(label, { selector: "span" }).parentElement;
}

function section(name: string) {
  return screen.getByRole("region", { name });
}

/** Waits for the detail below the stats; the route section is its first part. */
function detailLoaded() {
  return screen.findByRole("region", { name: "Route" });
}

/** The split pace bars, one list item per lap. */
const splitRows = () =>
  within(within(section("Splits")).getByRole("list", { name: "Splits" })).getAllByRole("listitem");

/** Switches the Splits card to its table view and returns the table. */
async function splitsTable() {
  await userEvent.click(within(section("Splits")).getByRole("button", { name: "Show table" }));
  return within(section("Splits")).getByRole("table", { name: "Splits" });
}

/** The line above the stats: start time and flags, "07:12·Indoor" (the dots are spaced by a gap). */
const startLine = () => within(section("Summary")).getByText("07:12").parentElement;
const miles = meFixture({ settings: { ...meFixture().settings, units: "mi" } });

describe("RunScreen", () => {
  beforeEach(() => {
    // jsdom has no layout; give Recharts' ResponsiveContainer a phone-width box to measure.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      DOMRect.fromRect({ width: 358, height: 192 }),
    );
  });

  it("shows a skeleton in the final layout with Back while loading", () => {
    stubFetch(never);
    renderRun();
    expect(screen.getByRole("status", { name: "Loading the run" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("explains a failed first load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ method, path }) => {
      if (path === "/api/me") return json(meFixture());
      if (method === "GET") {
        attempts += 1;
        return attempts === 1
          ? problem(500, ErrorCode.internal)
          : json({ activity: run, detail: activityDetailFixture() });
      }
      return notFound();
    });
    renderRun();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("heading", { name: "Run" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Sun 27 Sep" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says a run that is not stored no longer exists (404)", async () => {
    stubFetch(({ path }) => (path === "/api/me" ? json(meFixture()) : notFound()));
    renderRun({ id: "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a" });
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.not_found);
  });

  it("says the same for a malformed address without asking the API", async () => {
    const calls = fakeRunApi();
    renderRun({ id: "not-a-run" });
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.not_found);
    expect(calls.filter((call) => call.path.startsWith("/api/activities"))).toEqual([]);
  });

  it("keeps the run and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing
        ? problem(503, ErrorCode.internal)
        : json({ activity: run, detail: activityDetailFixture() });
    });
    const { queryClient } = renderRun();
    await detailLoaded();

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("activities", run.id) }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(figure("Distance")).toHaveTextContent("10.0km");
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("shows the run's day as the title, its start time and every stat in km", async () => {
    const calls = fakeRunApi({ stored: activityDetailFixture() });
    renderRun();

    expect(await screen.findByRole("heading", { name: "Sun 27 Sep" })).toHaveClass("text-title");
    const summary = section("Summary");
    expect(startLine()).toHaveTextContent(/^07:12$/);
    expect(startLine()).toHaveClass("text-caption", "text-ink-2");
    expect(figure("Distance")).toHaveTextContent(/^Distance10\.0km$/);
    expect(figure("Time")).toHaveTextContent(/^Time52:18$/);
    expect(figure("Avg pace")).toHaveTextContent(/^Avg pace5:13\/km$/);
    expect(figure("Elevation gain")).toHaveTextContent(/^Elevation gain64m$/);
    expect(figure("Avg HR")).toHaveTextContent(/^Avg HR148bpm$/);
    expect(figure("Cadence")).toHaveTextContent(/^Cadence172spm$/);
    expect(figure("Calories")).toHaveTextContent(/^Calories690kcal$/);
    expect(within(summary).getByText("10.0")).toHaveClass("text-figure");
    // The detail was stored on an earlier open: nothing is fetched from Garmin.
    await detailLoaded();
    expect(detailFetches(calls)).toHaveLength(0);
  });

  it("shows every part of the detail on its own card: route sketch, split bars, zones, cadence and elevation", async () => {
    fakeRunApi({ stored: activityDetailFixture() });
    renderRun();
    await detailLoaded();

    for (const name of ["Route", "Splits", "Heart rate zones", "Cadence", "Elevation"]) {
      const card = within(section(name)).getByRole("heading", { name }).nextElementSibling;
      expect(card).toHaveClass("rounded-md", "bg-surface-1", "p-4");
    }
    const sketch = within(section("Route")).getByRole("img", { name: "Route sketch" });
    // The card is the sketch's background.
    expect(sketch).not.toHaveClass("bg-surface-1");
    expect(within(section("Route")).getByText("Route only: no map token.")).toBeInTheDocument();
    expect(
      within(section("Heart rate zones")).getByRole("button", { name: "Show table" }),
    ).toBeInTheDocument();
    expect(
      within(section("Heart rate zones")).getByRole("img", { name: "Heart rate zones chart" }),
    ).toBeInTheDocument();
    expect(within(section("Cadence")).getByRole("img", { name: "Cadence chart" })).toBeVisible();
    expect(
      within(section("Elevation")).getByRole("img", { name: "Elevation chart" }),
    ).toBeVisible();
  });

  it("shows the splits as pace bars by default and the lap table with avg HR on Show table", async () => {
    fakeRunApi({ stored: activityDetailFixture() });
    renderRun();
    await detailLoaded();

    const bars = splitRows();
    expect(bars).toHaveLength(11);
    expect(within(bars[0] as HTMLElement).getByRole("img", { name: "5:18 /km" })).toBeVisible();
    // Lap 2 at 5:15 is 3 s faster than lap 1.
    expect(within(bars[1] as HTMLElement).getByText("+0:03")).toHaveClass("text-good");
    // The 40 m that end the run, at 19 s, labelled by their distance.
    expect(bars[10]).toHaveTextContent(/^0\.047:55 \/km/);
    expect(within(section("Splits")).queryByRole("table")).not.toBeInTheDocument();

    const splits = await splitsTable();
    expect(within(splits).getAllByRole("row")).toHaveLength(12);
    expect(within(splits).getByRole("row", { name: "1 1.0 km 5:18 138" })).toBeInTheDocument();
    expect(within(splits).getByRole("row", { name: "11 0.04 km 7:55 158" })).toBeInTheDocument();

    await userEvent.click(within(section("Splits")).getByRole("button", { name: "Show chart" }));
    expect(splitRows()).toHaveLength(11);
  });

  it("lists the first 12 splits of a long run and all of them on Show all", async () => {
    const laps = Array.from({ length: 21 }, (_, lap) => ({
      index: lap + 1,
      distanceM: 1000,
      durationS: 300 + (lap % 4),
      avgHr: 150,
      avgCadence: 172,
    }));
    fakeRunApi({ stored: activityDetailFixture({ laps }) });
    renderRun();
    await detailLoaded();

    expect(splitRows()).toHaveLength(12);
    await userEvent.click(
      within(section("Splits")).getByRole("button", { name: "Show all 21 laps" }),
    );
    expect(splitRows()).toHaveLength(21);
    const splits = await splitsTable();
    expect(within(splits).getAllByRole("row")).toHaveLength(22);
  });

  it("fetches the detail from Garmin once when the run has none, with a skeleton below the stats meanwhile", async () => {
    let answer!: (response: Response) => void;
    const calls = fakeRunApi({
      fetchDetail: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    const { queryClient } = renderRun();

    expect(
      await screen.findByRole("status", { name: "Loading laps, route and zones" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Getting laps, route and zones from Garmin.")).toBeInTheDocument();
    expect(figure("Distance")).toHaveTextContent("10.0km");
    expect(detailFetches(calls)).toHaveLength(1);

    answer(json({ activity: run, detail: activityDetailFixture() }));
    await detailLoaded();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    // A reload of the run (Sync now elsewhere) re-renders the screen; the fetch is never repeated.
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("activities", run.id) }));
    expect(section("Route")).toBeInTheDocument();
    expect(detailFetches(calls)).toHaveLength(1);
  });

  it("keeps the fetched detail when a reload that started before the fetch stored it still has none (overlapping requests)", async () => {
    // Garmin's answer comes back, but every GET still reads the run without detail.
    const calls = fakeRunApi({
      fetchDetail: () => json({ activity: run, detail: activityDetailFixture() }),
    });
    const { queryClient } = renderRun();
    await detailLoaded();

    await act(() => queryClient.refetchQueries({ queryKey: detailKey("activities", run.id) }));

    expect(section("Splits")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(detailFetches(calls)).toHaveLength(1);
  });

  it("asks Garmin once per open under StrictMode, whose effects run twice on mount", async () => {
    const calls = fakeRunApi({
      fetchDetail: (attempt) =>
        attempt === 1 ? problem(502, ErrorCode.garminUnavailable) : "stored",
    });
    const { router } = renderScreen(
      <StrictMode>
        <RunScreen />
      </StrictMode>,
      { route: "/runs/:id", path: `/runs/${run.id}` },
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    // Opened again: the cached run still has no detail when the screen mounts, so both effect runs see it.
    await act(() => router.navigate("/progress"));
    await act(() => router.navigate(`/runs/${run.id}`));

    await detailLoaded();
    expect(detailFetches(calls)).toHaveLength(2);
  });

  it("does not fetch again by itself after a failed fetch, even when the run reloads", async () => {
    const calls = fakeRunApi({
      fetchDetail: (attempt) =>
        attempt === 1 ? problem(502, ErrorCode.garminUnavailable) : "stored",
    });
    const { queryClient } = renderRun();
    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.garmin_unavailable);

    await act(() => queryClient.refetchQueries({ queryKey: detailKey("activities", run.id) }));

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(detailFetches(calls)).toHaveLength(1);
  });

  it.each([
    {
      corner: "Garmin outage",
      answer: () => problem(502, ErrorCode.garminUnavailable),
      message: errorMessages.garmin_unavailable,
    },
    {
      corner: "Garmin 429",
      answer: () => problem(429, ErrorCode.garminRateLimited, { retryAfterSeconds: 3600 }),
      message: "Garmin is limiting requests. Wait an hour, then try again.",
    },
    {
      corner: "token expiry",
      answer: () => problem(409, ErrorCode.garminAuthExpired),
      message: "Garmin login expired. Reconnect in Settings.",
    },
    {
      corner: "Garmin not connected",
      answer: () => problem(409, ErrorCode.garminNotConnected),
      message: errorMessages.garmin_not_connected,
    },
    {
      corner: "our rate limit",
      answer: () => problem(429, ErrorCode.rateLimited, { retryAfterSeconds: 60 }),
      message: errorMessages.rate_limited,
    },
  ])(
    "explains a failed fetch below the stats, keeps them, and fetches again only on Retry ($corner)",
    async ({ answer, message }) => {
      const calls = fakeRunApi({
        fetchDetail: (attempt) => (attempt === 1 ? answer() : "stored"),
      });
      renderRun();

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(alert).toHaveClass("text-body", "text-ink");
      expect(figure("Distance")).toHaveTextContent("10.0km");
      expect(screen.queryByRole("region", { name: "Route" })).not.toBeInTheDocument();
      expect(detailFetches(calls)).toHaveLength(1);

      await userEvent.click(screen.getByRole("button", { name: "Retry" }));

      await detailLoaded();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(detailFetches(calls)).toHaveLength(2);
    },
  );

  it("says a run deleted on Garmin Connect is gone, keeps the stats and offers no Retry (deleted on Garmin)", async () => {
    const calls = fakeRunApi({ fetchDetail: () => problem(404, ErrorCode.notFound) });
    renderRun();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.not_found);
    expect(figure("Distance")).toHaveTextContent("10.0km");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(detailFetches(calls)).toHaveLength(1);
  });

  it("shows no map for an indoor run and says why, without a skeleton map while fetching (indoor run)", async () => {
    let answer!: (response: Response) => void;
    const treadmill = activityFixture({
      type: "treadmill_running",
      isIndoor: true,
      distanceM: 6_000,
      durationS: 1_980,
      elevationGainM: null,
    });
    const base = activityDetailFixture();
    const indoorDetail = activityDetailFixture({
      route: null,
      streams: { ...base.streams, elevationM: null },
    });
    fakeRunApi({
      run: treadmill,
      fetchDetail: () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    renderRun();

    const loading = await screen.findByRole("status", { name: "Loading laps, route and zones" });
    expect(loading.querySelector(".h-60")).toBeNull();
    expect(startLine()).toHaveTextContent(/^07:12·Indoor$/);
    answer(json({ activity: treadmill, detail: indoorDetail }));

    const route = await detailLoaded();
    expect(within(route).getByText("Indoor run: no GPS route.")).toHaveClass("text-ink-2");
    expect(within(route).queryByRole("img")).not.toBeInTheDocument();
    expect(within(section("Elevation")).getByText("No elevation recorded.")).toBeInTheDocument();
    expect(figure("Elevation gain")).toHaveTextContent(new RegExp(`^Elevation gain${MISSING}$`));
    expect(figure("Avg pace")).toHaveTextContent(/^Avg pace5:30\/km$/);
  });

  it("says no route was recorded for an outdoor run without one (GPS off)", async () => {
    fakeRunApi({ stored: activityDetailFixture({ route: null }) });
    renderRun();

    const route = await detailLoaded();
    expect(within(route).getByText("No GPS route recorded.")).toBeInTheDocument();
    expect(within(route).queryByRole("img")).not.toBeInTheDocument();
  });

  it("hides the zones chart with a note and shows dashes for HR (missing HR)", async () => {
    const base = activityDetailFixture();
    fakeRunApi({
      run: activityFixture({ avgHr: null, maxHr: null }),
      stored: activityDetailFixture({
        hrZones: null,
        streams: { ...base.streams, hr: null },
        laps: base.laps.map((lap) => ({ ...lap, avgHr: null })),
      }),
    });
    renderRun();
    await detailLoaded();

    const zones = section("Heart rate zones");
    expect(within(zones).getByText("No heart rate recorded, so no zones.")).toBeInTheDocument();
    expect(within(zones).queryByRole("img")).not.toBeInTheDocument();
    expect(figure("Avg HR")).toHaveTextContent(new RegExp(`^Avg HR${MISSING}$`));
    const splits = await splitsTable();
    expect(
      within(splits).getByRole("row", { name: `1 1.0 km 5:18 ${MISSING}` }),
    ).toBeInTheDocument();
  });

  it("converts distance, pace, elevation and splits when the runner uses miles (unit conversion)", async () => {
    fakeRunApi({ me: miles, stored: activityDetailFixture() });
    renderRun();
    await detailLoaded();

    // 10.04 km is 6.24 mi at 8:23 a mile; 64 m is 210 ft.
    expect(figure("Distance")).toHaveTextContent(/^Distance6\.2mi$/);
    expect(figure("Avg pace")).toHaveTextContent(/^Avg pace8:23\/mi$/);
    expect(figure("Elevation gain")).toHaveTextContent(/^Elevation gain210ft$/);
    // The km laps keep their numbers in miles (every one is 0.62 mi); 318 s a km is 8:32 a mile.
    const [first] = splitRows();
    expect(first).toHaveTextContent(/^18:32 \/mi$/);
    expect(within(first as HTMLElement).getByRole("img", { name: "8:32 /mi" })).toBeVisible();
    const splits = await splitsTable();
    expect(within(splits).getByRole("columnheader", { name: "Pace /mi" })).toBeInTheDocument();
    expect(within(splits).getByRole("row", { name: "1 0.62 mi 8:32 138" })).toBeInTheDocument();
    expect(within(section("Elevation")).getByText("Feet above sea level")).toBeInTheDocument();
  });

  it("names a sub-2:00/km lap as a GPS glitch in place of its bar and in the table (GPS glitches)", async () => {
    const base = activityDetailFixture();
    fakeRunApi({
      stored: activityDetailFixture({
        laps: [
          ...base.laps,
          { index: 12, distanceM: 1000, durationS: 110, avgHr: 160, avgCadence: 180 },
        ],
      }),
    });
    renderRun();
    await detailLoaded();

    const bar = splitRows()[11] as HTMLElement;
    expect(within(bar).queryByRole("img")).not.toBeInTheDocument();
    expect(within(bar).getByText("GPS glitch")).toHaveClass("text-body", "text-ink-2");
    expect(
      within(section("Splits")).getByText("1 lap left out as a GPS glitch."),
    ).toBeInTheDocument();

    const glitch = within(await splitsTable()).getByRole("row", { name: /^12 / });
    // Body size like every table cell (web-ui rule), ink-2 like the lap numbers.
    expect(within(glitch).getByText("GPS glitch")).toHaveClass("text-ink-2");
    expect(within(glitch).getByText("GPS glitch")).not.toHaveClass("text-caption");
  });

  it("shows dashes for calories, cadence and elevation gain Garmin did not record, and says so below", async () => {
    const base = activityDetailFixture();
    fakeRunApi({
      run: activityFixture({ calories: null, cadence: null, elevationGainM: null }),
      stored: activityDetailFixture({ streams: { ...base.streams, cadence: null } }),
    });
    renderRun();
    await detailLoaded();

    expect(figure("Calories")).toHaveTextContent(new RegExp(`^Calories${MISSING}$`));
    expect(figure("Cadence")).toHaveTextContent(new RegExp(`^Cadence${MISSING}$`));
    expect(figure("Elevation gain")).toHaveTextContent(new RegExp(`^Elevation gain${MISSING}$`));
    expect(within(section("Cadence")).getByText("No cadence recorded.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/NaN|Infinity|undefined/);
  });

  it("says a manual entry has no laps and draws nothing from empty samples", async () => {
    fakeRunApi({
      run: activityFixture({ isManual: true }),
      stored: {
        laps: [],
        streams: { elapsedS: [], distanceM: [], hr: [], cadence: [], elevationM: [], speedMps: [] },
        route: null,
        hrZones: null,
      },
    });
    renderRun();
    await detailLoaded();

    expect(within(section("Splits")).queryByRole("list")).not.toBeInTheDocument();
    expect(within(section("Splits")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(section("Splits")).getByText("No laps recorded for this run.")).toBeVisible();
    expect(within(section("Cadence")).getByText("No cadence recorded.")).toBeVisible();
    expect(startLine()).toHaveTextContent(/^07:12·Manual$/);
  });

  it("shows a Race chip after the start time for a run marked as a race in Garmin Connect", async () => {
    fakeRunApi({
      run: activityFixture({ eventType: RACE_EVENT_TYPE, isIndoor: true }),
      stored: activityDetailFixture(),
    });
    renderRun();
    await detailLoaded();

    expect(startLine()).toHaveTextContent(/^07:12Race·Indoor$/);
    const chip = within(startLine() as HTMLElement).getByText("Race");
    expect(chip.querySelector(".bg-type-race")).not.toBeNull();
  });

  it.each(["training", "uncategorized", null])(
    "shows no chip for a run that is no race (%s)",
    async (eventType) => {
      fakeRunApi({ run: activityFixture({ eventType }), stored: activityDetailFixture() });
      renderRun();
      await detailLoaded();

      expect(startLine()).toHaveTextContent(/^07:12$/);
      expect(screen.queryByText("Race")).not.toBeInTheDocument();
    },
  );

  it("goes back to Progress from a run opened by its address", async () => {
    fakeRunApi({ stored: activityDetailFixture() });
    const { router } = renderRun();
    await screen.findByRole("heading", { name: "Sun 27 Sep" });

    const back = screen.getByRole("link", { name: "Back" });
    expect(back).toHaveAttribute("href", "/progress");
    expect(back).toHaveClass("min-h-11");
    await userEvent.click(back);

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/progress");
  });

  it("goes back to the screen the run was opened from", async () => {
    fakeRunApi({ stored: activityDetailFixture() });
    const { router } = renderRun({ history: ["/"] });
    await screen.findByRole("heading", { name: "Sun 27 Sep" });

    await userEvent.click(screen.getByRole("link", { name: "Back" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(router.state.historyAction).toBe("POP");
  });
});
