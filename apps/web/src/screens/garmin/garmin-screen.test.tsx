import { ErrorCode, type MeResponse } from "@running-coach/shared";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { errorMessages } from "@/lib/errors";
import { json, never, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { GarminScreen } from "./garmin-screen";

function renderGarmin(me: MeResponse = meFixture()) {
  stubFetch(() => json(me));
  return renderScreen(<GarminScreen />, { path: "/settings/garmin" });
}

describe("GarminScreen", () => {
  it("shows a skeleton of the Garmin card under the title and Back while loading", () => {
    stubFetch(never);
    renderScreen(<GarminScreen />, { path: "/settings/garmin" });

    expect(screen.getByRole("heading", { level: 1, name: "Garmin" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings");
    expect(screen.getByRole("status", { name: "Loading Garmin" })).toBeInTheDocument();
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderScreen(<GarminScreen />, { path: "/settings/garmin" });

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the connection and the last sync in the runner's time zone, without laptop instructions", async () => {
    renderGarmin();

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Connected")).toBeInTheDocument();
    // 06:12 UTC is 07:12 in London in September (BST).
    expect(within(garmin).getByText("Sun 27 Sep 2026, 07:12")).toBeInTheDocument();
    expect(garmin).not.toHaveTextContent("garmin:connect");
  });

  it("says Garmin is not connected and how to connect it from the laptop, without offering a fake action", async () => {
    renderGarmin(meFixture({ garmin: { status: "not_connected", lastSyncAt: null } }));

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Not connected.")).toBeInTheDocument();
    const help = within(garmin).getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^To connect, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(help).toHaveClass("text-caption", "text-ink-2");
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says the Garmin login expired and how to reconnect it from the laptop (token expiry)", async () => {
    renderGarmin(meFixture({ garmin: { status: "expired", lastSyncAt: "2026-09-20T05:00:00Z" } }));

    const garmin = await screen.findByRole("region", { name: "Garmin" });
    expect(within(garmin).getByText("Login expired")).toBeInTheDocument();
    const help = within(garmin).getByText("pnpm garmin:connect").closest("p");
    expect(help).toHaveTextContent(
      /^To reconnect, run pnpm garmin:connect with this app's address on your laptop\.$/,
    );
    expect(within(garmin).queryByRole("button")).not.toBeInTheDocument();
  });

  it("goes back to Settings", async () => {
    const { router } = renderGarmin();

    await userEvent.click(await screen.findByRole("link", { name: "Back" }));

    expect(router.state.location.pathname).toBe("/settings");
  });
});
