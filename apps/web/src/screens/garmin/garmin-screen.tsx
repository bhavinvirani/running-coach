import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { cn } from "@/lib/cn";
import { GarminSection } from "./parts/garmin-section";
import { useGarminScreen } from "./use-garmin";

const TITLE = "Garmin";

/**
 * The Garmin connection at /settings/garmin: its state, the last sync and how to connect from the laptop
 * (#51 rebuilds it). Today's Reconnect Garmin and the push line open it. No empty state: every account has
 * a connection state, not connected included.
 */
export function GarminScreen() {
  const { data, status, error, refetch, refetchError } = useGarminScreen();

  if (status === "pending") {
    return (
      <DetailLayout title={TITLE} backTo="/settings" busy>
        <GarminSkeleton />
      </DetailLayout>
    );
  }

  if (status === "error") {
    return (
      <DetailLayout title={TITLE} backTo="/settings">
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  return (
    <DetailLayout title={TITLE} backTo="/settings">
      {refetchError ? <RetryAlert error={refetchError} onRetry={() => void refetch()} /> : null}
      <GarminSection garmin={data.garmin} timeZone={data.settings.timezone} />
    </DetailLayout>
  );
}

/** The connected card: its title inside, then Status and Last sync. */
function GarminSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading Garmin"
      className="rounded-md border border-line bg-surface-1 px-4"
    >
      <div className="mt-4 flex h-5.5 items-center">
        <div className="h-4 w-20 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col divide-y divide-line">
        {["w-24", "w-40"].map((width) => (
          <div key={width} className="flex min-h-12 items-center justify-between py-3">
            <div className="h-4 w-16 rounded-sm bg-surface-2" />
            <div className={cn("h-4 rounded-sm bg-surface-2", width)} />
          </div>
        ))}
      </div>
    </div>
  );
}
