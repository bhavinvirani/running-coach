import { ErrorCode, type HrZones, type HrZonesResponse } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { hrZonesKey } from "@/api/hr-zones";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { activityFixture, activityResponseFixture } from "@/test/fixtures";
import { hrZonesFixture, hrZonesResponseFixture } from "@/test/fixtures-hr-zones";
import { renderScreen } from "@/test/render";
import { HrZonesScreen } from "./hr-zones-screen";

type FakeZonesApi = {
  /** What PUT answers; by default it stores the body as the runner's zones, like the API. */
  put?: (zones: HrZones) => Response | Promise<Response>;
  /** What DELETE answers; by default Garmin's zones come back. */
  reset?: () => Response;
};

/** GET, PUT and DELETE /api/hr-zones in memory: Garmin's zones until the runner saves their own. */
function fakeZonesApi(
  initial: HrZonesResponse = hrZonesResponseFixture(),
  options: FakeZonesApi = {},
) {
  let current = initial;
  const store = (response: HrZonesResponse) => {
    current = response;
    return json(current);
  };
  return stubFetch(({ method, path, body }) => {
    if (path !== "/api/hr-zones") return notFound();
    if (method === "GET") return json(current);
    if (method === "PUT") {
      const zones = body as HrZones;
      return options.put ? options.put(zones) : store(hrZonesResponseFixture("custom", zones));
    }
    if (method === "DELETE")
      return options.reset ? options.reset() : store(hrZonesResponseFixture());
    return notFound();
  });
}

/** The runner's own zones: max HR 200, floors at 100, 120, 140, 160 and 180 bpm. */
const customZones = hrZonesFixture({ maxHr: 200, lowBpm: [100, 120, 140, 160, 180] });

function renderZones() {
  return renderScreen(<HrZonesScreen />, { path: "/settings/hr-zones" });
}

const zone = (name: string) => screen.getByRole("group", { name });
const percentField = (number: number) =>
  screen.getByLabelText(`Zone ${number} lower bound, percent of max`);
const bpmField = (number: number) => screen.getByLabelText(`Zone ${number} lower bound, bpm`);
const allValues = (field: (number: number) => HTMLElement) =>
  [1, 2, 3, 4, 5].map((number) => (field(number) as HTMLInputElement).value);
const ZONE_NAMES = [
  "Zone 1, Recovery",
  "Zone 2, Endurance",
  "Zone 3, Tempo",
  "Zone 4, Threshold",
  "Zone 5, Anaerobic",
];
/** Each zone's range caption, zone 1 first. */
const ranges = () =>
  ZONE_NAMES.map(
    (name) => within(zone(name)).getByText(/^(\d+-\d+ bpm|–)$/, { selector: "span" }).textContent,
  );

async function replace(field: HTMLElement, text: string) {
  await userEvent.clear(field);
  await userEvent.type(field, text);
}

const writes = (calls: { method: string }[]) =>
  calls.filter((call) => call.method !== "GET").map((call) => call.method);

describe("HrZonesScreen", () => {
  it("shows a skeleton under the title and Back while loading", () => {
    stubFetch(never);
    renderZones();

    expect(screen.getByRole("heading", { level: 1, name: "Heart-rate zones" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("status", { name: "Loading heart-rate zones" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(hrZonesResponseFixture());
    });
    renderZones();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByLabelText("Max HR")).toHaveValue("196");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the zones and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(() => (failing ? problem(503, ErrorCode.internal) : json(hrZonesResponseFixture())));
    const { queryClient } = renderZones();
    await screen.findByLabelText("Max HR");

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: hrZonesKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByLabelText("Max HR")).toHaveValue("196");
  });

  it("says there are no zones without a run with heart rate and offers Today, with no form (missing HR)", async () => {
    fakeZonesApi(hrZonesResponseFixture("none"));
    const { router } = renderZones();

    expect(
      await screen.findByText(
        "No run with heart rate yet, so no zones. Sync a run recorded with heart rate.",
      ),
    ).toHaveClass("text-body", "text-ink-2");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save zones" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Open Today" }));

    expect(router.state.location.pathname).toBe("/");
  });

  it("shows Garmin's zones: max HR, then five named zones, each floor in percent and bpm and its range", async () => {
    fakeZonesApi();
    renderZones();

    const maxHr = await screen.findByLabelText("Max HR");
    expect(maxHr).toHaveValue("196");
    expect(maxHr).toHaveAccessibleDescription(
      "Beats per minute. A new max HR keeps each zone's percent.",
    );
    expect(screen.getByText("Garmin's zones, from your latest run with heart rate.")).toHaveClass(
      "text-caption",
      "text-ink-2",
    );
    const zones = within(screen.getByRole("region", { name: "Zones" })).getAllByRole("group");
    expect(zones).toEqual(ZONE_NAMES.map(zone));
    expect(allValues(percentField)).toEqual(["50", "60", "70", "80", "90"]);
    expect(allValues(bpmField)).toEqual(["98", "118", "137", "157", "176"]);
    expect(ranges()).toEqual([
      "98-117 bpm",
      "118-136 bpm",
      "137-156 bpm",
      "157-175 bpm",
      "176-196 bpm",
    ]);
    expect(screen.queryByRole("button", { name: "Reset to Garmin's" })).not.toBeInTheDocument();
  });

  it("marks each zone with its own zone color and asks for numbers on a number pad", async () => {
    fakeZonesApi();
    renderZones();
    await screen.findByLabelText("Max HR");

    const zones = within(screen.getByRole("region", { name: "Zones" })).getAllByRole("group");
    zones.forEach((group, index) => {
      expect(group.querySelector('[aria-hidden="true"]')).toHaveClass(`bg-zone-${index + 1}`);
    });
    for (const field of screen.getAllByRole("textbox")) {
      expect(field).toHaveAttribute("inputmode", "numeric");
    }
    expect(screen.getAllByRole("textbox")).toHaveLength(11);
  });

  it("says when the zones are estimated from the highest heart rate of the last year", async () => {
    fakeZonesApi(hrZonesResponseFixture("estimated"));
    renderZones();

    expect(
      await screen.findByText(
        "Garmin's default shares of your highest heart rate in the last year.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset to Garmin's" })).not.toBeInTheDocument();
  });

  it("offers Reset to Garmin's only for the runner's own zones, and says how runs are counted", async () => {
    fakeZonesApi(hrZonesResponseFixture("custom", customZones));
    renderZones();

    expect(
      await screen.findByText(
        "Your own zones. Each run's time in zone is counted from its heart rate.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to Garmin's" })).toBeEnabled();
  });

  it("moves a zone's bpm and the ranges around it when its percent changes", async () => {
    fakeZonesApi();
    renderZones();
    await screen.findByLabelText("Max HR");

    await replace(percentField(2), "65");

    expect(bpmField(2)).toHaveValue("127");
    expect(ranges().slice(0, 2)).toEqual(["98-126 bpm", "127-136 bpm"]);
  });

  it("moves a zone's percent when its bpm changes", async () => {
    fakeZonesApi();
    renderZones();
    await screen.findByLabelText("Max HR");

    await replace(bpmField(4), "167");

    expect(percentField(4)).toHaveValue("85");
    expect(ranges()[3]).toBe("167-175 bpm");
  });

  it("keeps the percents and moves every bpm when max HR changes", async () => {
    fakeZonesApi();
    renderZones();

    await replace(await screen.findByLabelText("Max HR"), "200");

    expect(allValues(percentField)).toEqual(["50", "60", "70", "80", "90"]);
    expect(allValues(bpmField)).toEqual(["100", "120", "140", "160", "180"]);
    expect(ranges()[4]).toBe("180-200 bpm");
  });

  it("says what is wrong and sends nothing when the zones overlap (invalid zones)", async () => {
    const calls = fakeZonesApi();
    renderZones();
    await screen.findByLabelText("Max HR");

    await replace(bpmField(3), "110");
    await userEvent.click(screen.getByRole("button", { name: "Save zones" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/^Each zone starts above the one before it\.$/);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(writes(calls)).toEqual([]);

    // The next edit takes the sentence away; Save checks again.
    await replace(bpmField(3), "137");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("says max HR is out of range and sends nothing (invalid zones)", async () => {
    const calls = fakeZonesApi();
    renderZones();

    await replace(await screen.findByLabelText("Max HR"), "90");
    await userEvent.click(screen.getByRole("button", { name: "Save zones" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Max HR is a whole number from 100 to 240 bpm.",
    );
    expect(writes(calls)).toEqual([]);
  });

  it("saves the zones with one PUT, then shows them as the runner's own with Reset to Garmin's, and reads every run again", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const calls = fakeZonesApi(hrZonesResponseFixture(), {
      put: async (zones) => {
        await answered;
        return json(hrZonesResponseFixture("custom", zones));
      },
    });
    const { queryClient } = renderZones();
    // A run screen opened before cached its detail.
    const runKey = detailKey("activities", activityFixture().id);
    queryClient.setQueryData(runKey, activityResponseFixture());
    await screen.findByLabelText("Max HR");

    await replace(percentField(2), "65");
    await userEvent.click(screen.getByRole("button", { name: "Save zones" }));

    expect(screen.getByRole("button", { name: "Saving zones…" })).toBeDisabled();
    act(() => answer());

    expect(await screen.findByRole("status")).toHaveTextContent("Zones saved.");
    expect(
      screen.getByText("Your own zones. Each run's time in zone is counted from its heart rate."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset to Garmin's" })).toBeInTheDocument();
    expect(allValues(bpmField)).toEqual(["98", "127", "137", "157", "176"]);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/hr-zones",
      "PUT /api/hr-zones",
    ]);
    expect(calls[1]?.body).toEqual({ maxHr: 196, lowBpm: [98, 127, 137, 157, 176] });
    expect(queryClient.getQueryState(runKey)?.isInvalidated).toBe(true);

    // An edit after saving is unsaved again.
    await replace(percentField(3), "71");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("explains a failed save and keeps what was typed", async () => {
    fakeZonesApi(hrZonesResponseFixture(), { put: () => problem(400, ErrorCode.validation) });
    renderZones();
    await screen.findByLabelText("Max HR");

    await replace(percentField(2), "65");
    await userEvent.click(screen.getByRole("button", { name: "Save zones" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(bpmField(2)).toHaveValue("127");
    expect(screen.getByRole("button", { name: "Save zones" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Reset to Garmin's" })).not.toBeInTheDocument();
  });

  it("resets to Garmin's zones with one DELETE, puts them back on screen and moves focus to where they come from", async () => {
    const calls = fakeZonesApi(hrZonesResponseFixture("custom", customZones));
    renderZones();

    await userEvent.click(await screen.findByRole("button", { name: "Reset to Garmin's" }));

    const caption = await screen.findByText(
      "Garmin's zones, from your latest run with heart rate.",
    );
    await vi.waitFor(() => expect(caption).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Reset to Garmin's" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Max HR")).toHaveValue("196");
    expect(allValues(bpmField)).toEqual(["98", "118", "137", "157", "176"]);
    expect(writes(calls)).toEqual(["DELETE"]);
  });

  it("drops what was typed on Reset to Garmin's, also when Garmin's zones equal the runner's", async () => {
    fakeZonesApi(hrZonesResponseFixture("custom", hrZonesFixture()));
    renderZones();
    await screen.findByLabelText("Max HR");

    await replace(percentField(2), "65");
    await userEvent.click(screen.getByRole("button", { name: "Reset to Garmin's" }));

    await vi.waitFor(() => expect(bpmField(2)).toHaveValue("118"));
    expect(percentField(2)).toHaveValue("60");
  });

  it("explains a failed reset and keeps the runner's zones", async () => {
    fakeZonesApi(hrZonesResponseFixture("custom", customZones), {
      reset: () => problem(500, ErrorCode.internal),
    });
    renderZones();

    await userEvent.click(await screen.findByRole("button", { name: "Reset to Garmin's" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByLabelText("Max HR")).toHaveValue("200");
    expect(screen.getByRole("button", { name: "Reset to Garmin's" })).toBeEnabled();
  });
});
