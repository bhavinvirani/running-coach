import type { MeResponse } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { SettingsScreen } from "./settings-screen";

/** /api/me answering `me`, and sign-out. */
function fakeMeApi(me: MeResponse = meFixture()) {
  return stubFetch(({ method, path }) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "POST" && path === "/api/auth/sign-out") return json({ success: true });
    return notFound();
  });
}

const withSettings = (settings: Partial<MeResponse["settings"]>) =>
  meFixture({ settings: { ...meFixture().settings, ...settings } });

function renderSettings() {
  return renderScreen(<SettingsScreen />, { path: "/settings" });
}

const group = (name: string) => screen.getByRole("region", { name });
const findGroup = (name: string) => screen.findByRole("region", { name });
/** Every row of a group, as a screen reader names it. */
const rowNames = (name: string) =>
  within(group(name))
    .getAllByRole("link")
    .map((link) => link.getAttribute("aria-label"));

describe("SettingsScreen", () => {
  it("shows a skeleton of the groups and the account while loading", () => {
    stubFetch(never);
    renderSettings();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    const status = screen.getByRole("status", { name: "Loading settings" });
    const [stuff, preferences, account, ...rest] = Array.from(status.children);
    expect(rest).toEqual([]);
    // A heading line above a surface-1 card of 48 px rows, like CardSection with its ListRows.
    for (const [skeleton, rows] of [
      [stuff, 2],
      [preferences, 3],
    ] as const) {
      const card = skeleton?.lastElementChild;
      expect(card).toHaveClass("rounded-md", "bg-surface-1", "divide-y");
      expect(card?.children).toHaveLength(rows);
      for (const row of Array.from(card?.children ?? [])) expect(row).toHaveClass("min-h-12");
    }
    // The account sits on the same kind of card, its email row then Log out.
    expect(account?.lastElementChild).toHaveClass("rounded-md", "bg-surface-1", "divide-y");
    expect(screen.queryByRole("link", { name: /^Units/ })).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderSettings();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(errorMessages.internal);
    expect(alert).toHaveClass("text-body", "text-ink");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("link", { name: "Units, Kilometers" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the rows and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(() => (failing ? problem(503, ErrorCode.internal) : json(meFixture())));
    const { queryClient } = renderSettings();
    await screen.findByRole("link", { name: "Units, Kilometers" });

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("link", { name: "Units, Kilometers" })).toBeInTheDocument();

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("groups Garmin and Claude under My stuff, and units, coach detail and zones under My preferences, above the account", async () => {
    fakeMeApi();
    renderSettings();

    await findGroup("My stuff");
    const named = screen
      .getAllByRole("region")
      .map((region) => region.getAttribute("aria-label"))
      .filter((name) => name !== null);
    expect(named).toEqual(["My stuff", "My preferences", "Account"]);
    expect(rowNames("My stuff")).toEqual(["Garmin, Connected", "Claude, No key"]);
    expect(rowNames("My preferences")).toEqual([
      "Units, Kilometers",
      "Coach detail, Standard",
      "Heart-rate zones",
    ]);
    const account = group("Account");
    expect(within(account).getByText("runner@example.com")).toBeInTheDocument();
    expect(within(account).getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("opens one screen per row", async () => {
    fakeMeApi();
    renderSettings();

    await findGroup("My stuff");
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/settings/garmin",
      "/settings/claude",
      "/settings/units",
      "/settings/coach-detail",
      "/settings/hr-zones",
    ]);
  });

  it("leads each row with its own icon", async () => {
    fakeMeApi();
    renderSettings();

    await findGroup("My stuff");
    const icons = screen.getAllByRole("link").map(
      (link) =>
        link
          .querySelector("svg")
          ?.getAttribute("class")
          ?.match(/lucide-[a-z-]+/)?.[0],
    );
    expect(icons).toEqual([
      "lucide-watch",
      "lucide-key-round",
      "lucide-ruler",
      "lucide-message-square-text",
      "lucide-heart-pulse",
    ]);
  });

  it("says Login expired on the Garmin row while the login is expired (token expiry)", async () => {
    fakeMeApi(meFixture({ garmin: { status: "expired", lastSyncAt: "2026-09-20T05:00:00Z" } }));
    renderSettings();

    expect(await screen.findByRole("link", { name: "Garmin, Login expired" })).toHaveAttribute(
      "href",
      "/settings/garmin",
    );
  });

  it("says Not connected on the Garmin row before Garmin is connected", async () => {
    fakeMeApi(meFixture({ garmin: { status: "not_connected", lastSyncAt: null } }));
    renderSettings();

    expect(await screen.findByRole("link", { name: "Garmin, Not connected" })).toBeInTheDocument();
  });

  it.each([
    {
      what: "the Claude plan",
      settings: { coachCredential: "plan", claudePlanAvailable: true },
      value: "Claude plan",
    },
    {
      what: "a saved key",
      settings: { coachCredential: "key", hasClaudeKey: true },
      value: "Key saved",
    },
    { what: "no key", settings: { coachCredential: "none", hasClaudeKey: false }, value: "No key" },
  ] as const)("says what the coach runs on with $what", async ({ settings, value }) => {
    fakeMeApi(withSettings(settings));
    renderSettings();

    expect(await screen.findByRole("link", { name: `Claude, ${value}` })).toBeInTheDocument();
  });

  it("says Miles on the Units row and Detailed on the Coach detail row when chosen (unit conversion)", async () => {
    fakeMeApi(withSettings({ units: "mi", coachDetail: "detailed" }));
    renderSettings();

    expect(await screen.findByRole("link", { name: "Units, Miles" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Coach detail, Detailed" })).toBeInTheDocument();
  });

  it("logs out and goes to the login screen", async () => {
    const calls = fakeMeApi();
    const { router } = renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(calls.some((call) => call.path === "/api/auth/sign-out")).toBe(true);
  });
});
