import {
  ErrorCode,
  type CreateShoeRequest,
  type MeResponse,
  type Shoe,
  type ShoeInput,
} from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { shoesKey } from "@/api/shoes";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
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
import { ShoeScreen } from "./shoe-screen";

const NEW_ID = "3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a";
const miles = meFixture({ settings: { ...meFixture().settings, units: "mi" } });

type FakeShoeApi = {
  me?: MeResponse;
  /** What a write answers instead of storing it, as a 500 or a never-settling request. */
  writes?: (request: FakeRequest) => Response | Promise<Response> | undefined;
};

/** /api/me and the shoe endpoints over `initial` in memory, answering every change with the whole list. */
function fakeShoeApi(
  initial: Shoe[] = [shoeFixture(), racerShoeFixture(), oldShoeFixture()],
  { me = meFixture(), writes }: FakeShoeApi = {},
) {
  let shoes = initial;
  const list = () => json(shoesResponseFixture(shoes));
  const change = (id: string, edit: (shoe: Shoe) => Shoe) => {
    shoes = shoes.map((shoe) => (shoe.id === id ? edit(shoe) : shoe));
  };
  return stubFetch((request) => {
    const { method, path, body } = request;
    if (path === "/api/me") return json(me);
    if (method === "GET" && path === "/api/shoes") return list();
    const answer = writes?.(request);
    if (answer) return answer;
    if (method === "POST" && path === "/api/shoes") {
      const { active, ...input } = body as CreateShoeRequest;
      if (active) shoes = shoes.map((shoe) => ({ ...shoe, active: false }));
      const created = shoeFixture({
        ...input,
        id: NEW_ID,
        active,
        distanceM: input.startDistanceM,
        runs: 0,
        durationS: 0,
      });
      shoes = [created, ...shoes];
      return list();
    }
    const [, id, action] = /^\/api\/shoes\/([^/]+)(?:\/(\w+))?$/.exec(path) ?? [];
    if (id === undefined || !shoes.some((shoe) => shoe.id === id)) return notFound();
    if (method === "PUT" && action === undefined) {
      change(id, (shoe) => ({ ...shoe, ...(body as ShoeInput) }));
      return list();
    }
    if (method === "POST" && action === "active") {
      shoes = shoes.map((shoe) => ({ ...shoe, active: false }));
      change(id, (shoe) => ({ ...shoe, active: true, retiredAt: null }));
      return list();
    }
    if (method === "POST" && action === "retire") {
      change(id, (shoe) => ({ ...shoe, active: false, retiredAt: "2026-10-07T09:00:00Z" }));
      return list();
    }
    if (method === "DELETE" && action === undefined) {
      shoes = shoes.filter((shoe) => shoe.id !== id);
      return list();
    }
    return notFound();
  });
}

function renderShoe(id = DAILY_SHOE_ID, history: string[] = ["/settings/shoes"]) {
  return renderScreen(<ShoeScreen />, {
    route: id === "new" ? "/settings/shoes/new" : "/settings/shoes/:id",
    path: `/settings/shoes/${id}`,
    history,
  });
}

const field = (label: string) => screen.getByLabelText(label);
const writes = (calls: FakeRequest[]) =>
  calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

async function replace(label: string, text: string) {
  await userEvent.clear(field(label));
  if (text !== "") await userEvent.type(field(label), text);
}

describe("ShoeScreen for a new pair", () => {
  it("shows a skeleton of the form under New shoes while loading", () => {
    stubFetch(never);
    renderShoe("new");

    expect(screen.getByRole("heading", { level: 1, name: "New shoes" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings/shoes");
    expect(screen.getByRole("status", { name: "Loading shoes" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(shoesResponseFixture());
    });
    renderShoe("new");

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByLabelText("Brand")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("starts from the default goal in km, nothing before the app, and the unit in each helper", async () => {
    fakeShoeApi();
    renderShoe("new");

    expect(await screen.findByLabelText("Retire at")).toHaveValue("650");
    expect(field("Distance before this app")).toHaveValue("0");
    expect(field("Retire at")).toHaveAccessibleDescription(
      "In kilometers. Running shoes lose their cushioning at about 650 km.",
    );
    expect(field("Distance before this app")).toHaveAccessibleDescription(
      "In kilometers. What the pair ran before this app counted its runs.",
    );
    expect(field("Colour")).toHaveAccessibleDescription("Optional.");
  });

  it("shows the default goal in whole miles for a runner in miles (unit conversion)", async () => {
    fakeShoeApi([], { me: miles });
    renderShoe("new");

    expect(await screen.findByLabelText("Retire at")).toHaveValue("404");
    expect(field("Retire at")).toHaveAccessibleDescription(
      "In miles. Running shoes lose their cushioning at about 404 mi.",
    );
  });

  it("checks Use for new runs when no pair is active, as when every pair is retired", async () => {
    fakeShoeApi([oldShoeFixture()]);
    renderShoe("new");
    expect(await screen.findByRole("checkbox", { name: "Use for new runs" })).toBeChecked();
  });

  it("leaves Use for new runs unchecked while another pair is active", async () => {
    fakeShoeApi();
    renderShoe("new");
    expect(await screen.findByRole("checkbox", { name: "Use for new runs" })).not.toBeChecked();
  });

  it.each([
    { what: "no brand", fill: { brand: "", model: "Glide 4" }, message: "Type the brand." },
    { what: "no model", fill: { brand: "Northpace", model: " " }, message: "Type the model." },
  ])("says what is missing and sends nothing with $what", async ({ fill, message }) => {
    const calls = fakeShoeApi();
    renderShoe("new");
    await screen.findByLabelText("Brand");

    if (fill.brand) await userEvent.type(field("Brand"), fill.brand);
    if (fill.model) await userEvent.type(field("Model"), fill.model);
    await userEvent.click(screen.getByRole("button", { name: "Add shoes" }));

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(writes(calls)).toEqual([]);
  });

  it.each([
    {
      units: "km",
      me: meFixture(),
      label: "Retire at",
      text: "20",
      message: "Retire at is a distance from 50 to 5,000 km.",
    },
    {
      units: "mi",
      me: miles,
      label: "Retire at",
      text: "4000",
      message: "Retire at is a distance from 32 to 3,106 mi.",
    },
    {
      units: "mi",
      me: miles,
      label: "Distance before this app",
      text: "lots",
      message: "Distance before this app is a distance from 0 to 3,106 mi.",
    },
  ] as const)(
    "states the range of $label in $units and sends nothing (unit conversion)",
    async ({ me, label, text, message }) => {
      const calls = fakeShoeApi([], { me });
      renderShoe("new");
      await screen.findByLabelText("Brand");

      await userEvent.type(field("Brand"), "Northpace");
      await userEvent.type(field("Model"), "Glide 4");
      await replace(label, text);
      await userEvent.click(screen.getByRole("button", { name: "Add shoes" }));

      expect(screen.getByRole("alert")).toHaveTextContent(message);
      expect(writes(calls)).toEqual([]);
    },
  );

  it("adds a pair with its distances converted from miles to meters, then goes back to the list (unit conversion)", async () => {
    const calls = fakeShoeApi([], { me: miles });
    const { router } = renderShoe("new");
    await screen.findByLabelText("Brand");

    await userEvent.type(field("Brand"), " Northpace ");
    await userEvent.type(field("Model"), "Glide 4");
    await userEvent.type(field("Nickname"), "Daily trainer");
    await replace("Retire at", "300");
    await replace("Distance before this app", "12.5");
    await userEvent.click(screen.getByRole("button", { name: "Add shoes" }));

    await screen.findByText("Route not under test");
    expect(router.state.location.pathname).toBe("/settings/shoes");
    expect(writes(calls)).toEqual(["POST /api/shoes"]);
    // 300 mi is 482803.2 m and 12.5 mi is 20116.8 m.
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      brand: "Northpace",
      model: "Glide 4",
      colour: null,
      nickname: "Daily trainer",
      retireDistanceM: 482_803,
      startDistanceM: 20_117,
      active: true,
    });
  });

  it("keeps the default goal's meters when the shown 404 mi is left as it is (unit conversion)", async () => {
    const calls = fakeShoeApi([], { me: miles });
    renderShoe("new");
    await screen.findByLabelText("Brand");

    await userEvent.type(field("Brand"), "Northpace");
    await userEvent.type(field("Model"), "Glide 4");
    await userEvent.click(screen.getByRole("button", { name: "Add shoes" }));

    await screen.findByText("Route not under test");
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      retireDistanceM: 650_000,
      startDistanceM: 0,
    });
  });

  it("sends active false when Use for new runs is cleared", async () => {
    const calls = fakeShoeApi([oldShoeFixture()]);
    renderShoe("new");
    await screen.findByLabelText("Brand");

    await userEvent.type(field("Brand"), "Northpace");
    await userEvent.type(field("Model"), "Glide 4");
    await userEvent.click(screen.getByRole("checkbox", { name: "Use for new runs" }));
    await userEvent.click(screen.getByRole("button", { name: "Add shoes" }));

    await screen.findByText("Route not under test");
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ active: false });
  });

  it("keeps the verb while adding and says why an add failed, staying on the form", async () => {
    let release: (response: Response) => void = () => {};
    const calls = fakeShoeApi([], {
      writes: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    renderShoe("new");
    await screen.findByLabelText("Brand");

    await userEvent.type(field("Brand"), "Northpace");
    await userEvent.type(field("Model"), "Glide 4");
    await userEvent.click(screen.getByRole("button", { name: "Add shoes" }));

    const adding = screen.getByRole("button", { name: "Adding shoes…" });
    expect(adding).toBeDisabled();
    act(() => release(problem(500, ErrorCode.internal)));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("button", { name: "Add shoes" })).toBeEnabled();
    expect(field("Brand")).toHaveValue("Northpace");
    expect(writes(calls)).toEqual(["POST /api/shoes"]);
  });
});

describe("ShoeScreen for a stored pair", () => {
  it("shows a skeleton of the form under Edit shoes while loading", () => {
    stubFetch(never);
    renderShoe();

    expect(screen.getByRole("heading", { level: 1, name: "Edit shoes" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading shoes" })).toBeInTheDocument();
  });

  it("keeps the form and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(({ path }) => {
      if (path === "/api/me") return json(meFixture());
      return failing ? problem(503, ErrorCode.internal) : json(shoesResponseFixture());
    });
    const { queryClient } = renderShoe();
    await screen.findByLabelText("Brand");

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: shoesKey }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(field("Brand")).toHaveValue("Northpace");
  });

  it("fills the form from the pair, the distance before the app to a tenth of a mile (unit conversion)", async () => {
    fakeShoeApi(undefined, { me: miles });
    renderShoe(OLD_SHOE_ID);

    expect(await screen.findByLabelText("Brand")).toHaveValue("Northpace");
    expect(field("Model")).toHaveValue("Glide 3");
    expect(field("Colour")).toHaveValue("Grey");
    expect(field("Nickname")).toHaveValue("Old trainer");
    expect(field("Retire at")).toHaveValue("404");
    // 100 km is 62.1 mi.
    expect(field("Distance before this app")).toHaveValue("62.1");
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("keeps the stored meters of each distance left as shown when another field is saved (unit conversion)", async () => {
    const calls = fakeShoeApi([oldShoeFixture({ startDistanceM: 100_123 })], { me: miles });
    renderShoe(OLD_SHOE_ID);
    await screen.findByLabelText("Brand");

    await replace("Nickname", "Long runs");
    await userEvent.click(screen.getByRole("button", { name: "Save shoes" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Shoes saved.");
    expect(writes(calls)).toEqual([`PUT /api/shoes/${OLD_SHOE_ID}`]);
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      brand: "Northpace",
      model: "Glide 3",
      colour: "Grey",
      nickname: "Long runs",
      retireDistanceM: 650_000,
      startDistanceM: 100_123,
    });
  });

  it("sends a changed goal converted to meters and a blank colour as none", async () => {
    const calls = fakeShoeApi();
    renderShoe();
    await screen.findByLabelText("Brand");

    await replace("Retire at", "800");
    await replace("Colour", "");
    await userEvent.click(screen.getByRole("button", { name: "Save shoes" }));

    await screen.findByText("Shoes saved.");
    expect(calls.find((call) => call.method === "PUT")?.body).toMatchObject({
      colour: null,
      retireDistanceM: 800_000,
    });
    expect(field("Retire at")).toHaveValue("800");
  });

  it("drops the saved line once the runner types again", async () => {
    fakeShoeApi();
    renderShoe();
    await screen.findByLabelText("Brand");

    await userEvent.click(screen.getByRole("button", { name: "Save shoes" }));
    await screen.findByText("Shoes saved.");
    await userEvent.type(field("Model"), "x");

    expect(screen.queryByText("Shoes saved.")).not.toBeInTheDocument();
  });

  it("says the pair is active and offers no Make active for it", async () => {
    fakeShoeApi();
    renderShoe();

    expect(
      await screen.findByText("Active: new runs from Garmin get these shoes."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Make active" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire shoes" })).toBeInTheDocument();
  });

  it("makes a pair in use active and moves focus to the line saying so", async () => {
    const calls = fakeShoeApi();
    renderShoe(RACER_SHOE_ID);
    expect(
      await screen.findByText("In use. Make active to put them on new runs."),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Make active" }));

    const line = await screen.findByText("Active: new runs from Garmin get these shoes.");
    expect(line).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Make active" })).not.toBeInTheDocument();
    expect(writes(calls)).toEqual([`POST /api/shoes/${RACER_SHOE_ID}/active`]);
  });

  it("brings a retired pair back with Make active, and offers no Retire shoes while retired", async () => {
    const calls = fakeShoeApi();
    renderShoe(OLD_SHOE_ID);
    expect(await screen.findByText("Retired. Make active to wear them again.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retire shoes" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Make active" }));

    expect(
      await screen.findByText("Active: new runs from Garmin get these shoes."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retire shoes" })).toBeInTheDocument();
    expect(writes(calls)).toEqual([`POST /api/shoes/${OLD_SHOE_ID}/active`]);
  });

  it("retires a pair, keeping what is typed, and moves focus to the line saying so", async () => {
    const calls = fakeShoeApi();
    renderShoe();
    await screen.findByLabelText("Brand");
    await replace("Nickname", "Half typed");

    await userEvent.click(screen.getByRole("button", { name: "Retire shoes" }));

    const line = await screen.findByText("Retired. Make active to wear them again.");
    expect(line).toHaveFocus();
    expect(field("Nickname")).toHaveValue("Half typed");
    expect(writes(calls)).toEqual([`POST /api/shoes/${DAILY_SHOE_ID}/retire`]);
  });

  it("says why Retire shoes failed and keeps the pair as it was", async () => {
    fakeShoeApi(undefined, {
      writes: ({ path }) =>
        path.endsWith("/retire") ? problem(500, ErrorCode.internal) : undefined,
    });
    renderShoe();
    await screen.findByLabelText("Brand");

    await userEvent.click(screen.getByRole("button", { name: "Retire shoes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByText("Active: new runs from Garmin get these shoes.")).toBeInTheDocument();
  });

  it("asks before Delete shoes, saying the runs stay and lose their pair, and Keep shoes sends nothing", async () => {
    const calls = fakeShoeApi();
    renderShoe();
    await screen.findByLabelText("Brand");

    await userEvent.click(screen.getByRole("button", { name: "Delete shoes" }));

    const question = screen.getByText("Delete these shoes? Their runs stay and lose their pair.");
    expect(question).toHaveFocus();
    const group = screen.getByRole("group", { name: question.textContent ?? "" });
    expect(within(group).getByRole("button", { name: "Delete shoes" })).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Keep shoes" }));

    expect(screen.queryByText(/Delete these shoes/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete shoes" })).toHaveFocus();
    expect(writes(calls)).toEqual([]);
  });

  it("deletes the pair once confirmed and goes back to the list", async () => {
    const calls = fakeShoeApi();
    const { router } = renderShoe();
    await screen.findByLabelText("Brand");

    await userEvent.click(screen.getByRole("button", { name: "Delete shoes" }));
    const group = screen.getByRole("group");
    await userEvent.click(within(group).getByRole("button", { name: "Delete shoes" }));

    await screen.findByText("Route not under test");
    expect(router.state.location.pathname).toBe("/settings/shoes");
    expect(writes(calls)).toEqual([`DELETE /api/shoes/${DAILY_SHOE_ID}`]);
  });

  it("goes to the list in the screen's place after a delete when opened from a link", async () => {
    fakeShoeApi();
    const { router } = renderShoe(DAILY_SHOE_ID, []);
    await screen.findByLabelText("Brand");

    await userEvent.click(screen.getByRole("button", { name: "Delete shoes" }));
    await userEvent.click(
      within(screen.getByRole("group")).getByRole("button", { name: "Delete shoes" }),
    );

    await screen.findByText("Route not under test");
    expect(router.state.location.pathname).toBe("/settings/shoes");
    expect(router.state.historyAction).toBe("REPLACE");
  });

  it("says why a delete failed inside the question and keeps the pair", async () => {
    fakeShoeApi(undefined, {
      writes: ({ method }) => (method === "DELETE" ? problem(500, ErrorCode.internal) : undefined),
    });
    renderShoe();
    await screen.findByLabelText("Brand");

    await userEvent.click(screen.getByRole("button", { name: "Delete shoes" }));
    await userEvent.click(
      within(screen.getByRole("group")).getByRole("button", { name: "Delete shoes" }),
    );

    expect(await within(screen.getByRole("group")).findByRole("alert")).toHaveTextContent(
      errorMessages.internal,
    );
    expect(field("Brand")).toHaveValue("Northpace");
  });

  it.each([
    { what: "a pair the list does not hold", id: "0f1e2d3c-4b5a-4968-8776-655443322110" },
    { what: "an address that is no pair id", id: "not-a-pair" },
  ])("says $what is not here, with a way to the list", async ({ id }) => {
    const calls = fakeShoeApi();
    renderShoe(id);

    expect(
      await screen.findByText("These shoes are not in your list. They may have been deleted."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Shoes" })).toHaveAttribute(
      "href",
      "/settings/shoes",
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(writes(calls)).toEqual([]);
  });
});
