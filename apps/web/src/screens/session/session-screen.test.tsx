import {
  ErrorCode,
  type MeResponse,
  type MoveWarning,
  type PlanSession,
  type SessionDetailResponse,
} from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sessionKey } from "@/api/sessions";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import {
  customSessionFixture,
  garminPushStatusFixture,
  meFixture,
  planSessionFixture,
  sessionDetailFixture,
} from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { SessionScreen } from "./session-screen";

const intervals = planSessionFixture("2026-10-08");

type FakeSessionApi = {
  me?: MeResponse;
  detail?: SessionDetailResponse;
  /** POST /move: the warning it answers with, or a problem. */
  move?: MoveWarning | null | Response;
  /** DELETE: a problem, else the session skipped. */
  skip?: Response;
};

/** GET /api/sessions/:id answers `detail`, which a move, a skip or a push changes like the API would. */
function fakeSessionApi({
  me = meFixture(),
  detail = sessionDetailFixture(),
  move = null,
  skip,
}: FakeSessionApi = {}) {
  let current = detail;
  const path = `/api/sessions/${current.session.id}`;
  return stubFetch(({ method, path: requested, body }) => {
    if (method === "GET" && requested === "/api/me") return json(me);
    if (method === "GET" && requested === path) return json(current);
    if (method === "POST" && requested === `${path}/move`) {
      if (move instanceof Response) return move;
      const { date } = body as { date: string };
      current = {
        ...current,
        session: { ...current.session, date, status: "moved" },
        garmin: { ...current.garmin, pushing: true },
      };
      return json({ ...current, warning: move });
    }
    if (method === "DELETE" && requested === path) {
      if (skip) return skip;
      current = { ...current, session: { ...current.session, status: "skipped" } };
      return json(current);
    }
    if (method === "POST" && requested === "/api/calendar/push") {
      current = { ...current, garmin: { ...current.garmin, pushing: true } };
      return json({ garmin: current.garmin });
    }
    return notFound();
  });
}

function renderSession(session: PlanSession = intervals, history: string[] = []) {
  return renderScreen(<SessionScreen />, {
    path: `/plan/sessions/${session.id}`,
    route: "/plan/sessions/:id",
    history,
  });
}

/** The numbered steps, top-level items only: a repeat is one item with its steps inside. */
async function stepItems() {
  const steps = await screen.findByRole("region", { name: "Steps" });
  return Array.from(steps.querySelectorAll(":scope > ol > li"));
}

describe("SessionScreen", () => {
  // Thu 8 Oct 2026, 07:00 in London: the intervals are today.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T06:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderSession();

    expect(screen.getByRole("status", { name: "Loading the session" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/plan");
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry (session gone)", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? notFound() : json(sessionDetailFixture());
    });
    renderSession();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.not_found);
    expect(screen.getByRole("heading", { name: "Session" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Thu 8 Oct" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the session and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json(sessionDetailFixture());
    });
    const { queryClient } = renderSession();
    await screen.findByRole("heading", { name: "Thu 8 Oct" });

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: sessionKey(intervals.id) }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("region", { name: "Steps" })).toBeInTheDocument();
  });

  it("shows the type, distance, time and the numbered steps with paces in km", async () => {
    fakeSessionApi();
    renderSession();

    expect(await screen.findByRole("heading", { name: "Thu 8 Oct" })).toBeInTheDocument();
    expect(screen.getByText("Intervals").querySelector("span")).toHaveClass("bg-type-intervals");
    expect(screen.getByText("Distance").parentElement).toHaveTextContent(/^Distance11\.6km$/);
    expect(screen.getByText("Time").parentElement).toHaveTextContent(/^Time1:04:00$/);
    expect((await stepItems()).map((item) => item.textContent)).toEqual([
      "1Warm-up15 minEasy, no pace alert",
      "25 xWork1 km4:45-4:52 /km interval paceRecovery3 minEasy, no pace alert",
      "3Cool-down10 minEasy, no pace alert",
    ]);
  });

  it("shows distances and paces in mi when the runner uses miles (unit conversion)", async () => {
    fakeSessionApi({ me: meFixture({ settings: { ...meFixture().settings, units: "mi" } }) });
    renderSession();

    const items = await stepItems();
    expect(screen.getByText("Distance").parentElement).toHaveTextContent(/^Distance7\.2mi$/);
    expect(items[1]).toHaveTextContent(
      /^25 xWork1000 m7:39-7:50 \/mi interval paceRecovery3 minEasy, no pace alert$/,
    );
  });

  it("says where the session stands on Garmin and sends it with Send to Garmin", async () => {
    const calls = fakeSessionApi();
    renderSession();
    const garmin = await screen.findByRole("region", { name: "Garmin" });

    expect(within(garmin).getByText("Waiting to send")).toBeInTheDocument();
    await userEvent.click(within(garmin).getByRole("button", { name: "Send to Garmin" }));

    expect(await within(garmin).findByRole("status")).toHaveTextContent(
      "Sending workouts to Garmin.",
    );
    expect(within(garmin).getByText("Sending")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      expect.objectContaining({ path: "/api/calendar/push" }),
    ]);
  });

  it("says why nothing goes to Garmin while the login is expired (token expiry)", async () => {
    fakeSessionApi({
      detail: sessionDetailFixture({ garmin: garminPushStatusFixture({ connection: "expired" }) }),
    });
    renderSession();
    const garmin = await screen.findByRole("region", { name: "Garmin" });

    expect(within(garmin).getByText("Not on Garmin")).toBeInTheDocument();
    expect(within(garmin).getByText(errorMessages.garmin_auth_expired)).toBeInTheDocument();
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("moves the session to a day chip of its week from today on and says when hard days end up close", async () => {
    const calls = fakeSessionApi({
      move: { code: "hard_days_close", otherType: "long", otherDate: "2026-10-11" },
    });
    renderSession();
    await userEvent.click(await screen.findByRole("button", { name: "Move" }));

    const days = screen.getByRole("group", { name: "Move to" });
    expect(
      within(days)
        .getAllByRole("button")
        .map((day) => day.textContent),
    ).toEqual(["Fri 9", "Sat 10", "Sun 11"]);
    await userEvent.click(within(days).getByRole("button", { name: "Sat 10" }));

    expect(await screen.findByRole("heading", { name: "Sat 10 Oct" })).toBeInTheDocument();
    expect(screen.getByText(/^Intervals is now a day from/)).toHaveTextContent(
      "Intervals is now a day from Long run on Sun 11. The plan keeps 48 hours between hard sessions.",
    );
    expect(screen.queryByRole("group", { name: "Move to" })).not.toBeInTheDocument();
    expect(screen.getByText("Moved")).toBeInTheDocument();
    expect(calls.find((call) => call.method === "POST")).toMatchObject({
      path: `/api/sessions/${intervals.id}/move`,
      body: { date: "2026-10-10" },
    });
  });

  it("moves without a sentence when the hard days stay apart", async () => {
    fakeSessionApi();
    renderSession();
    await userEvent.click(await screen.findByRole("button", { name: "Move" }));
    await userEvent.click(screen.getByRole("button", { name: "Fri 9" }));

    expect(await screen.findByRole("heading", { name: "Fri 9 Oct" })).toBeInTheDocument();
    expect(screen.queryByText(/is now a day from/)).not.toBeInTheDocument();
  });

  it("explains a move the API refuses and keeps the session where it was (missed or moved session)", async () => {
    fakeSessionApi({ move: problem(409, ErrorCode.sessionLocked) });
    renderSession();
    await userEvent.click(await screen.findByRole("button", { name: "Move" }));
    await userEvent.click(screen.getByRole("button", { name: "Sun 11" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.session_locked);
    expect(screen.getByRole("heading", { name: "Thu 8 Oct" })).toBeInTheDocument();
  });

  it("asks in place before skipping, keeps the session on Keep session, and skips it on confirm", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const calls = fakeSessionApi();
    renderSession();
    await userEvent.click(await screen.findByRole("button", { name: "Skip session" }));

    expect(screen.getByText(/^Skip this session\?/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep session" }));
    expect(screen.queryByText(/^Skip this session\?/)).not.toBeInTheDocument();
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Skip session" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip session" }));

    expect(await screen.findByText("Skipped")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip session" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Garmin" })).not.toBeInTheDocument();
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe(
      `/api/sessions/${intervals.id}`,
    );
    expect(confirm).not.toHaveBeenCalled();
  });

  it("explains a failed skip inside the confirm step", async () => {
    fakeSessionApi({ skip: problem(502, ErrorCode.internal) });
    renderSession();
    await userEvent.click(await screen.findByRole("button", { name: "Skip session" }));
    await userEvent.click(screen.getByRole("button", { name: "Skip session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("button", { name: "Keep session" })).toBeInTheDocument();
  });

  it("names a custom workout by its title with its type, and offers Edit workout and Delete workout", async () => {
    const custom = customSessionFixture();
    fakeSessionApi({ detail: sessionDetailFixture({ session: custom }) });
    renderSession(custom);

    expect(await screen.findByRole("heading", { name: "Fri 9 Oct" })).toBeInTheDocument();
    expect(screen.getByText("Hill reps").querySelector("span")).toHaveClass("bg-type-tempo");
    expect(screen.getByText("Tempo")).toHaveClass("text-caption");
    expect(screen.getByRole("link", { name: "Edit workout" })).toHaveAttribute(
      "href",
      `/plan/sessions/${custom.id}/edit`,
    );
    expect(screen.queryByRole("button", { name: "Skip session" })).not.toBeInTheDocument();
  });

  it("deletes a custom workout after the confirm step and goes back where the runner came from", async () => {
    const custom = customSessionFixture();
    const calls = fakeSessionApi({ detail: sessionDetailFixture({ session: custom }) });
    const { router } = renderSession(custom, ["/"]);
    await userEvent.click(await screen.findByRole("button", { name: "Delete workout" }));

    expect(screen.getByText(/^Delete this workout\?/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Keep workout" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Delete workout" }));

    await vi.waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(calls.find((call) => call.method === "DELETE")?.path).toBe(`/api/sessions/${custom.id}`);
  });

  it("shows no actions and no Garmin state for a past session (missed or moved session)", async () => {
    const past = planSessionFixture("2026-10-06");
    fakeSessionApi({ detail: sessionDetailFixture({ session: past }) });
    renderSession(past);

    expect(await screen.findByRole("heading", { name: "Tue 6 Oct" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Garmin" })).not.toBeInTheDocument();
  });

  it.each(["done", "missed", "skipped"] as const)(
    "shows no actions for a %s session",
    async (status) => {
      const session = { ...planSessionFixture("2026-10-09"), status };
      fakeSessionApi({ detail: sessionDetailFixture({ session }) });
      renderSession(session);

      expect(await screen.findByRole("heading", { name: "Fri 9 Oct" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Skip session" })).not.toBeInTheDocument();
    },
  );

  it("offers Skip session but no Move on the week's last day", async () => {
    const sunday = planSessionFixture("2026-10-11");
    vi.setSystemTime(new Date("2026-10-11T06:00:00Z"));
    fakeSessionApi({ detail: sessionDetailFixture({ session: sunday }) });
    renderSession(sunday);

    expect(await screen.findByRole("button", { name: "Skip session" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
  });

  it("shows a strength session without steps or Garmin state", async () => {
    const strength = planSessionFixture("2026-10-14");
    fakeSessionApi({ detail: sessionDetailFixture({ session: strength }) });
    renderSession(strength);

    expect(await screen.findByRole("heading", { name: "Wed 14 Oct" })).toBeInTheDocument();
    expect(screen.queryByText("Distance")).not.toBeInTheDocument();
    expect(screen.getByText("Time").parentElement).toHaveTextContent(/^Time30:00$/);
    expect(screen.queryByRole("region", { name: "Steps" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Garmin" })).not.toBeInTheDocument();
  });
});
