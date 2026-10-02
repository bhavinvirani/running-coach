import { useEffect } from "react";
import { isRouteErrorResponse, useRevalidator, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

/** Route error boundary: what happened, what to do, and Retry, which reruns loaders and re-renders. */
export function ScreenErrorBoundary() {
  const error = useRouteError();
  const revalidator = useRevalidator();

  useEffect(() => {
    console.error(error);
  }, [error]);

  const message =
    isRouteErrorResponse(error) && error.status === 404
      ? "That page does not exist. Go back and try again."
      : errorMessage(error);

  return (
    <section className="flex flex-col items-start gap-4 px-4 py-6">
      <p role="alert" className="text-body text-ink">
        {message}
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
