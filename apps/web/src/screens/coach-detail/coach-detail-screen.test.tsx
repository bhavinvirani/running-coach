import { ErrorCode, type MeResponse } from "@running-coach/shared";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { detailKey } from "@/api/query-keys";
import { errorMessages } from "@/lib/errors";
import { json, never, problem, stubFetch } from "@/test/fake-api";
import { meFixture } from "@/test/fixtures";
import { renderScreen } from "@/test/render";
import { CoachDetailScreen } from "./coach-detail-screen";

function renderCoachDetail() {
  return renderScreen(<CoachDetailScreen />, { path: "/settings/coach-detail" });
}

describe("CoachDetailScreen", () => {
  it("shows a skeleton of the three choices under the title and Back while loading", () => {
    stubFetch(never);
    renderCoachDetail();

    expect(screen.getByRole("heading", { level: 1, name: "Coach detail" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/settings");
    const status = screen.getByRole("status", { name: "Loading coach detail" });
    expect(status.firstElementChild?.children).toHaveLength(3);
  });

  it("explains a failed load and loads again on Retry", async () => {
    let attempts = 0;
    stubFetch(() => {
      attempts += 1;
      return attempts === 1 ? problem(500, ErrorCode.internal) : json(meFixture());
    });
    renderCoachDetail();

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.internal);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("radio", { name: "Standard" })).toBeChecked();
  });

  it("offers Short, Standard and Detailed, each saying how much the coach writes", async () => {
    stubFetch(() => json(meFixture()));
    renderCoachDetail();

    const group = await screen.findByRole("radiogroup", { name: "Coach detail" });
    expect(group).toHaveAccessibleDescription("How much the coach writes after each run.");
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(screen.getByRole("radio", { name: "Short" })).toHaveAccessibleDescription(
      "One sentence per part of each coach card.",
    );
    expect(screen.getByRole("radio", { name: "Standard" })).toHaveAccessibleDescription(
      "Up to two sentences per part.",
    );
    expect(screen.getByRole("radio", { name: "Detailed" })).toHaveAccessibleDescription(
      "Up to three sentences per part.",
    );
  });

  it("saves Detailed with one PATCH and shows it", async () => {
    const calls = stubFetch(({ method }) =>
      json(
        method === "PATCH"
          ? meFixture({ settings: { ...meFixture().settings, coachDetail: "detailed" } })
          : meFixture(),
      ),
    );
    const { queryClient } = renderCoachDetail();

    await userEvent.click(await screen.findByRole("radio", { name: "Detailed" }));

    expect(screen.getByRole("radio", { name: "Detailed" })).toBeChecked();
    await vi.waitFor(() => expect(queryClient.isMutating()).toBe(0));
    expect(calls.filter((call) => call.method === "PATCH").map((call) => call.body)).toEqual([
      { coachDetail: "detailed" },
    ]);
    expect(queryClient.getQueryData<MeResponse>(detailKey("me"))?.settings.coachDetail).toBe(
      "detailed",
    );
    expect(screen.getByRole("radio", { name: "Detailed" })).toBeChecked();
  });

  it("explains a failed save and keeps the saved level", async () => {
    stubFetch(({ method }) =>
      method === "PATCH" ? problem(400, ErrorCode.validation) : json(meFixture()),
    );
    renderCoachDetail();

    await userEvent.click(await screen.findByRole("radio", { name: "Short" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(errorMessages.validation);
    expect(screen.getByRole("radio", { name: "Standard" })).toBeChecked();
  });
});
