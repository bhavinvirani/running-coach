import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderScreen } from "@/test/render";
import { DetailHeader, DetailLayout } from "./detail-header";

describe("DetailHeader", () => {
  it("puts Back top left and the title centered as the screen's heading", async () => {
    const { router } = renderScreen(<DetailHeader title="Units" backTo="/settings" />, {
      path: "/settings/units",
    });

    const heading = screen.getByRole("heading", { level: 1, name: "Units" });
    expect(heading).toHaveClass("text-title", "text-ink");
    expect(heading.parentElement).toHaveClass("relative", "justify-center");
    const back = screen.getByRole("link", { name: "Back" });
    expect(back).toHaveClass("absolute", "left-0");
    await userEvent.click(back);

    expect(router.state.location.pathname).toBe("/settings");
  });
});

describe("DetailLayout", () => {
  it("draws the header above the content and says when it is busy", () => {
    renderScreen(
      <DetailLayout title="Units" backTo="/settings" busy>
        <p>Content</p>
      </DetailLayout>,
    );

    const layout = screen.getByText("Content").parentElement;
    expect(layout).toHaveAttribute("aria-busy", "true");
    expect(layout?.firstElementChild).toContainElement(
      screen.getByRole("heading", { name: "Units" }),
    );
  });
});
