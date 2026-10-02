import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppPending } from "./app-pending";

const WAKING = "Waking the server. After 15 minutes idle this takes up to a minute.";

describe("AppPending", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays blank for the first 3 s, which covers a normal start", () => {
    render(<AppPending />);
    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByText(WAKING)).not.toBeInTheDocument();
  });

  it("says the server is waking once the start takes longer than 3 s (cold start)", () => {
    render(<AppPending />);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole("status")).toHaveTextContent(WAKING);
  });
});
