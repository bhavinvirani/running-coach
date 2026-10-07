import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsCard, SettingsRow } from "./settings-card";

describe("SettingsCard", () => {
  it("names the region by its title inside a surface-1 card and divides the rows", () => {
    render(
      <SettingsCard title="Account">
        <SettingsRow label="Email">runner@example.com</SettingsRow>
      </SettingsCard>,
    );

    const card = screen.getByRole("region", { name: "Account" });
    expect(card).toHaveClass("rounded-md", "border-line", "bg-surface-1");
    expect(screen.getByRole("heading", { name: "Account" })).toHaveClass(
      "text-body",
      "font-semibold",
    );
    expect(screen.getByText("Email")).toHaveClass("text-ink-2");
    expect(screen.getByText("runner@example.com")).toHaveClass("text-ink", "text-right");
  });
});
