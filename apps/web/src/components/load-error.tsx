import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

type LoadErrorProps = {
  error: unknown;
  onRetry: () => void;
};

/**
 * A screen whose first load failed, with nothing else to show: what happened from src/lib/errors.ts and
 * Retry. An answer this version cannot read never lands here: it goes to the route's boundary, which
 * offers Reload (throwOnFirstLoadMismatch).
 */
export function LoadError({ error, onRetry }: LoadErrorProps) {
  return (
    <div className="flex flex-col items-start gap-4">
      <p role="alert" className="text-body text-ink">
        {errorMessage(error)}
      </p>
      <Button variant="secondary" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
