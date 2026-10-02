import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { progressCopy } from "../progress-copy";
import { WeekSkeleton } from "./week-skeleton";

type EarlierWeeksProps = {
  loading: boolean;
  error: Error | null;
  onShow: () => void;
};

/**
 * The end of the list: Show earlier weeks, then a skeleton week while the page loads, or its own error
 * with Retry. The weeks already shown stay as they are either way.
 */
export function EarlierWeeks({ loading, error, onShow }: EarlierWeeksProps) {
  if (loading) {
    return (
      <div role="status" aria-label={progressCopy.loadingEarlierWeeks}>
        <WeekSkeleton />
      </div>
    );
  }
  if (error) {
    return <RetryAlert error={error} onRetry={onShow} />;
  }
  return (
    <Button variant="secondary" onClick={onShow}>
      {progressCopy.showEarlierWeeks}
    </Button>
  );
}
