import type { ComponentType } from "react";

/** A screen's code did not load: a deploy since this page loaded removed its file, or the device is offline. */
export class ScreenLoadError extends Error {
  override readonly name = "ScreenLoadError";
  /**
   * Read when the import failed, not when the error shows: React Router keeps this failure for the rest of
   * the page, so a screen that failed offline still says so once the device is back online.
   */
  readonly offline = !navigator.onLine;
}

/**
 * A route's lazy Component. React Router 8 renders an empty page, with no error and no way to retry, for a
 * lazy Component whose import rejects; a failed import here resolves instead to a component that throws, so
 * the route's ScreenErrorBoundary shows it inside the tabs, at the address the runner asked for.
 */
export function lazyScreen(load: () => Promise<ComponentType>): () => Promise<ComponentType> {
  return () =>
    load().catch((cause: unknown) => {
      const error = new ScreenLoadError("A screen's code did not load", { cause });
      return function ScreenNotLoaded(): never {
        throw error;
      };
    });
}
