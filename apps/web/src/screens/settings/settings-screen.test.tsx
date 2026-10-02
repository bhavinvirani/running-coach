import type { MeResponse, UpdateSettingsRequest } from "@running-coach/shared";
import { ErrorCode } from "@running-coach/shared";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { json, never, notFound, problem, stubFetch, type FakeRequest } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { SettingsScreen } from "./settings-screen";

/** A tiny in-memory /api/me that applies PATCHes, like the real API. */
function fakeMeApi(initial: MeResponse) {
  let me = initial;
  return stubFetch(({ method, path, body }: FakeRequest) => {
    if (method === "GET" && path === "/api/me") return json(me);
    if (method === "PATCH" && path === "/api/me/settings") {
      me = { ...me, settings: { ...me.settings, ...(body as UpdateSettingsRequest) } };
      return json(me);
    }
    if (method === "POST" && path === "/api/auth/sign-out") return json({ success: true });
    return notFound();
  });
}

function renderSettings() {
  return renderScreen(<SettingsScreen />, { path: "/settings" });
}

describe("SettingsScreen", () => {
  it("shows a skeleton in the final layout while loading", () => {
    stubFetch(never);
    renderSettings();
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading settings" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderSettings();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("radio", { name: "km" })).toBeChecked();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the loaded settings and offers Retry when a background reload fails", async () => {
    let failing = false;
    stubFetch(() => (failing ? problem(503, ErrorCode.internal) : json(meFixture())));
    const { queryClient } = renderSettings();
    expect(await screen.findByRole("radio", { name: "km" })).toBeChecked();

    failing = true;
    await act(() => queryClient.refetchQueries({ queryKey: detailKey("me") }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    expect(screen.getByRole("radio", { name: "km" })).toBeChecked();
    expect(screen.getByRole("region", { name: "Account" })).toBeInTheDocument();

    failing = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "km" })).toBeChecked();
  });

  it("shows units, coach detail, Garmin and the account", async () => {
    fakeMeApi(meFixture());
    renderSettings();

    expect(await screen.findByRole("radio", { name: "km" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "mi" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();

    const garmin = screen.getByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Connected")).toBeInTheDocument();
    // 06:12 UTC is 07:12 in London in September (BST).
    expect(within(garmin).getByText("Sun 27 Sep 2026, 07:12")).toBeInTheDocument();

    const account = screen.getByRole("region", { name: "Account" });
    expect(within(account).getByText("runner@example.com")).toBeInTheDocument();
    expect(within(account).getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("shows no laptop connect instructions while Garmin is connected", async () => {
    fakeMeApi(meFixture());
    renderSettings();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Connected")).toBeInTheDocument();
    expect(garmin).not.toHaveTextContent("garmin:connect");
  });

  it("says Garmin is not connected and how to connect it from the laptop, without offering a fake action", async () => {
    fakeMeApi(meFixture({ garmin: { status: "not_connected", lastSyncAt: null } }));
    renderSettings();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Not connected.")).toBeInTheDocument();
    const help = within(garmin).getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^To connect, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(help).toHaveClass("text-caption", "text-ink-2");
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says the Garmin login expired and how to reconnect it from the laptop", async () => {
    fakeMeApi(meFixture({ garmin: { status: "expired", lastSyncAt: "2026-09-20T05:00:00Z" } }));
    renderSettings();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Login expired")).toBeInTheDocument();
    const help = within(garmin).getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^To reconnect, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(help).toHaveClass("text-caption", "text-ink-2");
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("saves a new unit with one PATCH, shows it and does not load /api/me again", async () => {
    const calls = fakeMeApi(meFixture());
    const { queryClient } = renderSettings();

    await userEvent.click(await screen.findByRole("radio", { name: "mi" }));

    expect(await screen.findByRole("radio", { name: "mi" })).toBeChecked();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/me",
      "PATCH /api/me/settings",
    ]);
    expect(calls[1]?.body).toEqual({ units: "mi" });
    expect(screen.getByRole("radio", { name: "km" })).not.toBeChecked();
  });

  it("explains a failed save and keeps the saved value", async () => {
    stubFetch(({ method }) =>
      method === "PATCH" ? problem(400, ErrorCode.validation) : json(meFixture()),
    );
    renderSettings();

    await userEvent.click(await screen.findByRole("radio", { name: "Detailed" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();
  });

  it("logs out and goes to the login screen", async () => {
    const calls = fakeMeApi(meFixture());
    const { router } = renderSettings();

    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));

    expect(await screen.findByText("Route not under test")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(calls.some((call) => call.path === "/api/auth/sign-out")).toBe(true);
  });
});
