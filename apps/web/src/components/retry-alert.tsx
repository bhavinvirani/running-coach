import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";

type RetryAlertProps = {
  error: unknown;
  onRetry: () => void;
};

/**
 * Something failed beside content that is still worth showing (a background reload, Sync now): the
 * sentence from src/lib/errors.ts and a quiet Retry, without replacing what is on screen.
 */
export function RetryAlert({ error, onRetry }: RetryAlertProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <p role="alert" className="text-body text-ink">
        {errorMessage(error)}
      </p>
      <Button variant="ghost" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
