import { ErrorCode, type MeResponse, type UpdateSettingsRequest } from "@running-coach/shared";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { UnitsScreen } from "./units-screen";

/** /api/me in memory, applying PATCHes like the real API. */
function fakeMeApi(initial: MeResponse = meFixture()) {
  let me = initial;
  return stubFetch(({ method, path, body }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "PATCH" && path === "/api/me/settings") {
      me = { ...me, settings: { ...me.settings, ...(body as UpdateSettingsRequest) } };
      return json(me);
    }
    return notFound();
  });
}

function renderUnits() {
  return renderScreen(<UnitsScreen />, { path: "/settings/units" });
}

describe("UnitsScreen", () => {
  it("shows a skeleton of the two choices under the title and Back while loading", () => {
    stubFetch(never);
    renderUnits();

    expect(screen.getByRole("heading", { level: 1, name: "Units" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings");
    const status = screen.getByRole("status", { name: "Loading units" });
    expect(status.firstElementChild?.children).toHaveLength(2);
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderUnits();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("radio", { name: "Kilometers" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the choice and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(() => (failing ? problem(503, ErrorCode.internal) : json(meFixture())));
    const { queryClient } = renderUnits();
    await screen.findByRole("radio", { name: "Kilometers" });

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("radio", { name: "Kilometers" })).toBeChecked();
  });

  it("offers Kilometers and Miles, each with the same example run in that unit (unit conversion)", async () => {
    fakeMeApi();
    renderUnits();

    const group = await screen.findByRole("radiogroup", { name: "Units" });
    expect(group).toHaveAccessibleDescription(
      "Distance, pace and elevation everywhere in the app.",
    );
    const km = screen.getByRole("radio", { name: "Kilometers" });
    const mi = screen.getByRole("radio", { name: "Miles" });
    expect(km).toBeChecked();
    expect(mi).not.toBeChecked();
    expect(km).toHaveAccessibleDescription("10.0 km at 5:30 /km, 120 m climb");
    expect(mi).toHaveAccessibleDescription("6.2 mi at 8:51 /mi, 394 ft climb");
  });

  it("checks Miles for a runner on miles", async () => {
    fakeMeApi(meFixture({ settings: { ...meFixture().settings, units: "mi" } }));
    renderUnits();

    expect(await screen.findByRole("radio", { name: "Miles" })).toBeChecked();
  });

  it("saves Miles with one PATCH, shows it at once and does not load /api/me again", async () => {
    let answer!: () => void;
    const answered = new Promise<void>((resolve) => (answer = resolve));
    const calls = stubFetch(async ({ method, path, body }) => {
      if (method === "PATCH" && path === "/api/me/settings") {
        await answered;
        return json(meFixture({ settings: { ...meFixture().settings, ...(body as object) } }));
      }
      return json(meFixture());
    });
    const { queryClient } = renderUnits();

    await userEvent.click(await screen.findByRole("radio", { name: "Miles" }));

    // Shown before the answer, so the tap never looks ignored.
    expect(screen.getByRole("radio", { name: "Miles" })).toBeChecked();
    act(() => answer());
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(screen.getByRole("radio", { name: "Miles" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Kilometers" })).not.toBeChecked();
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/me",
      "PATCH /api/me/settings",
    ]);
    expect(calls[1]?.body).toEqual({ units: "mi" });
    expect(queryClient.getQueryData<MeResponse>(detailKey("me"))?.settings.units).toBe("mi");
  });

  it("explains a failed save and keeps the saved unit", async () => {
    stubFetch(({ method }) =>
      method === "PATCH" ? problem(400, ErrorCode.validation) : json(meFixture()),
    );
    renderUnits();

    await userEvent.click(await screen.findByRole("radio", { name: "Miles" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.validation);
    expect(alert).toHaveClass("text-body", "text-ink");
    expect(screen.getByRole("radio", { name: "Kilometers" })).toBeChecked();
  });
});
