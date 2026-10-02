import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderScreen } from "@/test/render";
import { BackLink } from "./back-link";

describe("BackLink", () => {
  it("goes to its fallback when the screen was opened from a link", async () => {
    const { router } = renderScreen(<BackLink to="/plan" />, { path: "/plan/weeks/2" });

    const back = screen.getByRole("link", { name: "Back" });
    expect(back).toHaveAttribute("href", "/plan");
    await userEvent.click(back);

    expect(router.state.location.pathname).toBe("/plan");
  });

  it("goes back to where the screen was opened from inside the app", async () => {
    const { router } = renderScreen(<BackLink to="/plan" />, {
      path: "/settings",
      route: "/plan/weeks/:number",
    });
    await act(() => router.navigate("/plan/weeks/2"));

    await userEvent.click(screen.getByRole("link", { name: "Back" }));

    expect(router.state.location.pathname).toBe("/settings");
  });
});
