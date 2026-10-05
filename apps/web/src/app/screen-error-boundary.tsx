import { useContext, useEffect } from "react";
import { useRevalidator, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { errorMessage, isVersionMismatch } from "@/lib/errors";
import { AppUpdatesContext } from "./app-update";

/**
 * Route error boundary: what happened, what to do, and Retry, which reruns loaders and re-renders. Unknown
 * paths redirect to / in router.tsx, so no route ever fails with a 404 of its own. A version mismatch gets
 * Reload instead: this version can only fail the same way again, and an installed app has no reload button.
 * It also tells app-update.ts, which reloads into the server's version once there is one: this screen has
 * nothing left to lose.
 */
export function ScreenErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();
  const appUpdates = useContext(AppUpdatesContext);

  useEffect(() => {
    console.error(error);
    if (isVersionMismatch(error)) appUpdates?.versionMismatch(true);
  }, [error, appUpdates]);

  return (
    <section className="flex flex-col items-start gap-4 px-4 py-6">
      <p role="alert" className="text-body text-ink">
        {errorMessage(error)}
      </p>
      {isVersionMismatch(error) ? (
        <Button variant="secondary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      ) : (
        <Button
          variant="secondary"
          disabled={revalidator.state === "loading"}
          onClick={() => void revalidator.revalidate()}
        >
          Retry
        </Button>
      )}
    </section>
  );
}
