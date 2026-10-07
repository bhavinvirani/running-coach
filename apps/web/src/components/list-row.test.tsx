import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HeartPulse, Ruler } from "lucide-react";
import { describe, expect, it } from "vitest";
import { renderScreen } from "@/test/render";
import { CardSection } from "./card-section";
import { ListRow } from "./list-row";

describe("ListRow", () => {
  it("names the row by its label and value and opens its screen", async () => {
    const { router } = renderScreen(
      <CardSection title="My preferences">
        <ListRow to="/settings/units" icon={Ruler} label="Units" value="Kilometers" />
      </CardSection>,
      { path: "/settings" },
    );

    const row = screen.getByRole("link", { name: "Units, Kilometers" });
    expect(row).toHaveAttribute("href", "/settings/units");
    expect(screen.getByText("Units")).toHaveClass("text-body", "text-ink");
    expect(screen.getByText("Kilometers")).toHaveClass("text-body", "text-ink-2", "text-right");
    await userEvent.click(row);

    expect(router.state.location.pathname).toBe("/settings/units");
  });

  it("draws one leading icon and a trailing chevron, both hidden from screen readers", () => {
    renderScreen(<ListRow to="/settings/units" icon={Ruler} label="Units" value="Miles" />);

    const icons = screen.getByRole("link").querySelectorAll("svg");
    expect(icons).toHaveLength(2);
    for (const icon of icons) {
      expect(icon).toHaveAttribute("aria-hidden", "true");
      expect(icon).toHaveClass("size-5");
      expect(icon).toHaveAttribute("stroke-width", "1.75");
    }
    expect(icons[0]).toHaveClass("lucide-ruler");
    expect(icons[1]).toHaveClass("lucide-chevron-right");
  });

  it("is a 48 px row with tap feedback on the card", () => {
    renderScreen(<ListRow to="/settings/units" icon={Ruler} label="Units" />);

    expect(screen.getByRole("link")).toHaveClass("min-h-12", "rounded-sm", "active:bg-surface-2");
  });

  it("is named by its label alone when it shows no value", () => {
    renderScreen(<ListRow to="/settings/hr-zones" icon={HeartPulse} label="Heart rate zones" />);

    expect(screen.getByRole("link", { name: "Heart rate zones" })).toBeInTheDocument();
    expect(screen.getByRole("link").querySelectorAll("span")).toHaveLength(1);
  });
});
