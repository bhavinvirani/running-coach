import { useEffect } from "react";
import { useRevalidator, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

/**
 * Route error boundary: what happened, what to do, and Retry, which reruns loaders and re-renders. Unknown
 * paths redirect to / in router.tsx, so no route ever fails with a 404 of its own.
 */
export function ScreenErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <section className="flex flex-col items-start gap-4 px-4 py-6">
      <p role="alert" className="text-body text-ink">
        {errorMessage(error)}
      </p>
      <Button
        variant="secondary"
        disabled={revalidator.state === "loading"}
        onClick={() => void revalidator.revalidate()}
      >
        Retry
      </Button>
    </section>
  );
}
