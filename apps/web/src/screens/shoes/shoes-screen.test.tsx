import { ErrorCode, type MeResponse, type Shoe } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { shoesKey } from "@/api/shoes";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import {
  DAILY_SHOE_ID,
  oldShoeFixture,
  racerShoeFixture,
  shoeFixture,
  shoesResponseFixture,
} from "@/test/fixtures-shoes";
import { renderScreen } from "@/test/render";
import { ShoesScreen } from "./shoes-screen";

const miles = meFixture({ settings: { ...meFixture().settings, units: "mi" } });

/** /api/me and GET /api/shoes answering `shoes`. */
function fakeShoesApi(shoes?: Shoe[], me: MeResponse = meFixture()) {
  return stubFetch(({ method, path }) => {
    if (path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/shoes") return json(shoesResponseFixture(shoes));
    return notFound();
  });
}

function renderShoes() {
  return renderScreen(<ShoesScreen />, { path: "/settings/shoes" });
}

const section = (name: string) => screen.getByRole("region", { name });
/**
 * Each pair's row on a card as its lines read, " | " between them: the name, Active, then every paragraph.
 * A DotLine's dots are hidden from screen readers, so "Glide 4·Blue" is two items.
 */
const rows = (name: string) =>
  within(section(name))
    .getAllByRole("link")
    .map((link) =>
      Array.from(link.querySelectorAll(":scope > div > div > span, p"))
        .map((line) => line.textContent)
        .join(" | "),
    );

describe("ShoesScreen", () => {
  it("shows a skeleton of the In use card under the title and Back while loading", () => {
    stubFetch(never);
    renderShoes();

    expect(screen.getByRole("heading", { level: 1, name: "Shoes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings");
    const status = screen.getByRole("status", { name: "Loading shoes" });
    const card = status.firstElementChild?.lastElementChild;
    expect(card).toHaveClass("rounded-md", "bg-surface-1", "divide-y");
    expect(card?.children).toHaveLength(2);
    expect(screen.queryByRole("link", { name: "Add shoes" })).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(shoesResponseFixture());
    });
    renderShoes();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("region", { name: "In use" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the pairs and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json(shoesResponseFixture());
    });
    const { queryClient } = renderShoes();
    await screen.findByRole("region", { name: "In use" });

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: shoesKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(section("In use")).toBeInTheDocument();
    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("says what to do before the first pair, with one action: Add shoes", async () => {
    fakeShoesApi([]);
    renderShoes();

    expect(
      await screen.findByText("Add your shoes to see how far each pair has run."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add shoes" })).toHaveAttribute(
      "href",
      "/settings/shoes/new",
    );
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("lists the pairs in use, the active one first and marked Active, with distance of the goal, runs and time in km", async () => {
    fakeShoesApi();
    renderShoes();

    await screen.findByRole("region", { name: "In use" });
    expect(rows("In use")).toEqual([
      "Daily trainer | Active | Northpace Glide 4·Blue | 312.4 of 650 km | 41 runs·28:14:05",
      "Northpace Flyer 2 | 84.2 of 400 km | 9 runs·6:52:30",
    ]);
    const [daily] = within(section("In use")).getAllByRole("link");
    expect(daily).toHaveAttribute("href", `/settings/shoes/${DAILY_SHOE_ID}`);
  });

  it("opens a pair from its whole row, with no icon on the row, as only Settings' rows carry one", async () => {
    fakeShoesApi();
    renderShoes();

    await screen.findByRole("region", { name: "In use" });
    for (const row of within(section("In use")).getAllByRole("link")) {
      // The distance bar is the row's one drawing.
      expect(row.querySelectorAll("svg")).toHaveLength(1);
      expect(row.querySelector(".lucide")).toBeNull();
    }
  });

  it("converts each distance and goal to miles, the goal in whole miles (unit conversion)", async () => {
    fakeShoesApi([shoeFixture(), racerShoeFixture()], miles);
    renderShoes();

    await screen.findByRole("region", { name: "In use" });
    // 312.4 km is 194.1 mi and 650 km is 403.9 mi; 84.2 km is 52.3 mi and 400 km is 248.5 mi.
    expect(rows("In use")).toEqual([
      "Daily trainer | Active | Northpace Glide 4·Blue | 194.1 of 404 mi | 41 runs·28:14:05",
      "Northpace Flyer 2 | 52.3 of 249 mi | 9 runs·6:52:30",
    ]);
  });

  it("draws each pair's distance as a bar against its goal, hidden from screen readers", async () => {
    fakeShoesApi([shoeFixture()]);
    renderShoes();

    await screen.findByRole("region", { name: "In use" });
    const bar = within(section("In use")).getByRole("link").querySelector("svg");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar?.querySelectorAll("rect")[1]).toHaveAttribute("width", "48.1%");
  });

  it("puts retired pairs on a Retired card below, and says in words how far one ran past its goal with the bar full", async () => {
    fakeShoesApi();
    renderShoes();

    await screen.findByRole("region", { name: "Retired" });
    const named = screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(named).toEqual(["In use", "Retired"]);
    expect(rows("Retired")).toEqual([
      "Old trainer | Northpace Glide 3·Grey | 702.3 of 650 km | 52.3 km past its retire distance | 88 runs·61:20:00",
    ]);
    const bar = within(section("Retired")).getByRole("link").querySelector("svg");
    expect(bar?.querySelectorAll("rect")[1]).toHaveAttribute("width", "100%");
  });

  it("shows no Retired card while no pair is retired", async () => {
    fakeShoesApi([shoeFixture(), racerShoeFixture()]);
    renderShoes();

    await screen.findByRole("region", { name: "In use" });
    expect(screen.queryByRole("region", { name: "Retired" })).not.toBeInTheDocument();
  });

  it("says new runs get no shoes while every pair is retired", async () => {
    fakeShoesApi([oldShoeFixture()]);
    renderShoes();

    expect(
      await within(await screen.findByRole("region", { name: "In use" })).findByText(
        "No pair in use, so new runs get no shoes. Add shoes or make a retired pair active.",
      ),
    ).toBeInTheDocument();
    expect(rows("Retired")).toHaveLength(1);
  });

  it("offers Add shoes below the cards", async () => {
    fakeShoesApi();
    const { router } = renderShoes();

    await userEvent.click(await screen.findByRole("link", { name: "Add shoes" }));

    expect(router.state.location.pathname).toBe("/settings/shoes/new");
  });
});
