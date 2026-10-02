import { act } from "@testing-library/react";
import { vi } from "vitest";

/** Lets notifications and effects that wait on promises run a tick before asserting that nothing changed. */
export async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
}

/** The installed app goes to the background and comes back to the foreground. */
export function backgroundAndReturn(): void {
  const visibility = vi.spyOn(document, "visibilityState", "get");
  visibility.mockReturnValue("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  visibility.mockReturnValue("visible");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
