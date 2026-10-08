import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { shoesKey } from "@/api/shoes";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import {
  activityDetailFixture,
  activityFixture,
  activityResponseFixture,
  meFixture,
} from "@/test/fixtures";
import {
  DAILY_SHOE_ID,
  OLD_SHOE_ID,
  RACER_SHOE_ID,
  oldShoeFixture,
  racerShoeFixture,
  shoeFixture,
  shoesResponseFixture,
} from "@/test/fixtures-shoes";
import { renderScreen } from "@/test/render";
import { RunScreen } from "../run-screen";

const run = activityFixture();
const shoePath = `/api/activities/${run.id}/shoe`;

type FakeShoesApi = {
  /** The pair the stored run wore. */
  shoeId?: string | null;
  /** GET /api/shoes answers, in order; the last one repeats. */
  lists?: (() => Response | Promise<Response>)[];
  /** What PUT .../shoe answers; by default it stores the pair like the API. */
  put?: (shoeId: string | null) => Response | Promise<Response>;
};

const pairs = () => json(shoesResponseFixture());

/** /api/me, the run with its detail stored and its pair, no coach key, and the shoe endpoints in memory. */
function fakeShoesApi({ shoeId = DAILY_SHOE_ID, lists = [pairs], put }: FakeShoesApi = {}) {
  let worn = shoeId;
  let listed = 0;
  return stubFetch(({ method, path, body }: FakeRequest) => {
    if (path === "/api/me") return json(meFixture());
    if (path.endsWith("/insight")) return json({ state: "no_key" });
    if (method === "GET" && path === `/api/activities/${run.id}`) {
      return json(activityResponseFixture({ detail: activityDetailFixture(), shoeId: worn }));
    }
    if (method === "GET" && path === "/api/shoes") {
      const answer = lists[Math.min(listed, lists.length - 1)] ?? pairs;
      listed += 1;
      return answer();
    }
    if (method === "PUT" && path === shoePath) {
      const next = (body as { shoeId: string | null }).shoeId;
      if (put) return put(next);
      worn = next;
      return json({ shoeId: worn });
    }
    return notFound();
  });
}

function renderRun() {
  return renderScreen(<RunScreen />, { route: "/runs/:id", path: `/runs/${run.id}` });
}

const shoesSection = () => screen.getByRole("region", { name: "Shoes" });
const findShoes = () => screen.findByRole("region", { name: "Shoes" });
const change = () => within(shoesSection()).getByRole("button", { name: "Change" });
const choices = () =>
  within(shoesSection()).getByRole("radiogroup", { name: "Shoes for this run" });
const puts = (calls: FakeRequest[]) => calls.filter((call) => call.method === "PUT");

/** The pair the row names, which describes Change. */
async function wornName() {
  const section = await findShoes();
  const button = await within(section).findByRole("button", { name: "Change" });
  const name = button.ownerDocument.getElementById(button.getAttribute("aria-describedby") ?? "");
  expect(button).toHaveAccessibleDescription(name?.textContent ?? "");
  return name;
}

describe("RunShoes", () => {
  it("names the pair the run wore under the stats, before the coach", async () => {
    fakeShoesApi();
    renderRun();

    expect(await wornName()).toHaveTextContent("Daily trainer");
    const sections = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"));
    expect(sections.slice(0, 3)).toEqual(["Summary", "Shoes", "Coach"]);
    expect(change()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("says None for a run without a pair", async () => {
    fakeShoesApi({ shoeId: null });
    renderRun();

    expect(await wornName()).toHaveTextContent("None");
  });

  it("opens every pair in place on Change, in use first, retired ones after with Retired, then None", async () => {
    fakeShoesApi();
    renderRun();
    await wornName();

    await userEvent.click(change());

    expect(change()).toHaveAttribute("aria-expanded", "true");
    const radios = within(choices()).getAllByRole("radio");
    expect(
      radios.map((radio) => [
        radio.ownerDocument.getElementById(radio.getAttribute("aria-labelledby") ?? "")
          ?.textContent,
        radio.ownerDocument.getElementById(radio.getAttribute("aria-describedby") ?? "")
          ?.textContent,
      ]),
    ).toEqual([
      ["Daily trainer", "Active · Northpace Glide 4 · Blue"],
      ["Northpace Flyer 2", "In use"],
      ["Old trainer", "Retired · Northpace Glide 3 · Grey"],
      ["None", "This run counts toward no pair."],
    ]);
    expect(within(choices()).getByRole("radio", { name: "Daily trainer" })).toBeChecked();
  });

  it("saves another pair at once, shows it while saving, and reads the pairs' totals again", async () => {
    let release = () => {};
    const calls = fakeShoesApi({
      put: (shoeId) =>
        new Promise<Response>((resolve) => (release = () => resolve(json({ shoeId })))),
    });
    const { queryClient } = renderRun();
    await wornName();
    await userEvent.click(change());

    await userEvent.click(within(choices()).getByRole("radio", { name: "Northpace Flyer 2" }));

    expect(within(choices()).getByRole("radio", { name: "Northpace Flyer 2" })).toBeChecked();
    expect(within(shoesSection()).getByRole("status")).toHaveTextContent("Saving…");
    expect(await wornName()).toHaveTextContent("Northpace Flyer 2");
    const listsBefore = calls.filter((call) => call.path === "/api/shoes").length;
    act(() => release());

    await vi.waitFor(() =>
      expect(within(shoesSection()).queryByRole("status")).not.toBeInTheDocument(),
    );
    expect(puts(calls).map((call) => call.body)).toEqual([{ shoeId: RACER_SHOE_ID }]);
    expect(queryClient.getQueryData(detailKey("activities", run.id))).toMatchObject({
      shoeId: RACER_SHOE_ID,
    });
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path === "/api/shoes").length).toBeGreaterThan(
        listsBefore,
      ),
    );
    expect(await wornName()).toHaveTextContent("Northpace Flyer 2");
  });

  it("puts a retired pair on an old run", async () => {
    const calls = fakeShoesApi({ shoeId: null });
    renderRun();
    await wornName();
    await userEvent.click(change());

    await userEvent.click(within(choices()).getByRole("radio", { name: "Old trainer" }));

    await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toEqual({ shoeId: OLD_SHOE_ID });
    expect(await wornName()).toHaveTextContent("Old trainer");
  });

  it("takes the pair off the run with None", async () => {
    const calls = fakeShoesApi();
    renderRun();
    await wornName();
    await userEvent.click(change());

    await userEvent.click(within(choices()).getByRole("radio", { name: "None" }));

    await vi.waitFor(() => expect(puts(calls)).toHaveLength(1));
    expect(puts(calls)[0]?.body).toEqual({ shoeId: null });
    expect(await wornName()).toHaveTextContent("None");
  });

  it("says why a change failed and shows the pair the run still has", async () => {
    fakeShoesApi({ put: () => problem(500, ErrorCode.internal) });
    renderRun();
    await wornName();
    await userEvent.click(change());

    await userEvent.click(within(choices()).getByRole("radio", { name: "None" }));

    const alert = await within(shoesSection()).findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(await wornName()).toHaveTextContent("Daily trainer");
    expect(within(choices()).getByRole("radio", { name: "Daily trainer" })).toBeChecked();
  });

  it("links to Add shoes, in one sentence, while the runner has no pair", async () => {
    fakeShoesApi({ shoeId: null, lists: [() => json(shoesResponseFixture([]))] });
    renderRun();

    const section = await findShoes();
    expect(
      await within(section).findByText("No shoes yet. Add a pair to count how far each one runs."),
    ).toBeInTheDocument();
    expect(within(section).getByRole("link", { name: "Add shoes" })).toHaveAttribute(
      "href",
      "/settings/shoes/new",
    );
    expect(within(section).queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });

  it("shows a skeleton row while the pairs load, with the run already on screen", async () => {
    fakeShoesApi({ lists: [never] });
    renderRun();

    const section = await findShoes();
    expect(within(section).getByRole("status", { name: "Loading shoes" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Summary" })).toBeInTheDocument();
  });

  it("says why the pairs did not load, inside the section, and loads them again on Retry", async () => {
    fakeShoesApi({ lists: [() => problem(500, ErrorCode.internal), pairs] });
    renderRun();

    const section = await findShoes();
    const alert = await within(section).findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    // The rest of the run does not wait on the pairs.
    expect(await screen.findByRole("region", { name: "Route" })).toBeInTheDocument();
    await userEvent.click(within(section).getByRole("button", { name: "Retry" }));

    expect(await wornName()).toHaveTextContent("Daily trainer");
    expect(within(shoesSection()).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the pair and offers Retry when a background reload of the pairs fails", async () => {
    fakeShoesApi({ lists: [pairs, () => problem(503, ErrorCode.internal), pairs] });
    const { queryClient } = renderRun();
    await wornName();

    await act(() => queryClient.refetchQueries({ queryKey: shoesKey }));

    expect(await within(shoesSection()).findByRole("alert")).toHaveTextContent(
      errorMessages.internal,
    );
    expect(await wornName()).toHaveTextContent("Daily trainer");
  });

  it("names the pair as the list holds it, so a renamed pair shows its new name", async () => {
    fakeShoesApi({
      lists: [() => json(shoesResponseFixture([shoeFixture({ nickname: "Easy days" })]))],
    });
    renderRun();

    expect(await within(await findShoes()).findByText("Easy days")).toBeInTheDocument();
  });

  it("says None when the run's pair is no longer in the list", async () => {
    fakeShoesApi({
      lists: [() => json(shoesResponseFixture([racerShoeFixture(), oldShoeFixture()]))],
    });
    renderRun();

    expect(await wornName()).toHaveTextContent("None");
  });
});
