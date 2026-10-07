import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { cn } from "@/lib/cn";
import { garminCopy } from "./garmin-copy";
import { GarminSection } from "./parts/garmin-section";
import { useGarminScreen } from "./use-garmin";

/**
 * The Garmin connection at /settings/garmin: connect with email, password and Garmin's code, reconnect once
 * the login expired, or disconnect. `pnpm garmin:connect` from the laptop stays as the way round a sign-in
 * Garmin turns down here. Its sections are surface-1 cards under their headings (Connection, Sign in) with
 * Disconnect Garmin below them (GarminSection). Today's Reconnect Garmin, the push line and the Settings
 * row open it. No empty state: every account has a connection state, and not connected is the form that
 * connects.
 */
export function GarminScreen() {
  const { data, status, error, refetch, refetchError, login, disconnect } = useGarminScreen();

  if (status === "pending") {
    return (
      <DetailLayout title={garminCopy.title} backTo="/settings" busy>
        <GarminSkeleton />
      </DetailLayout>
    );
  }

  if (status === "error") {
    return (
      <DetailLayout title={garminCopy.title} backTo="/settings">
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  return (
    <DetailLayout title={garminCopy.title} backTo="/settings">
      {refetchError ? <RetryAlert error={refetchError} onRetry={() => void refetch()} /> : null}
      <GarminSection
        garmin={data.garmin}
        timeZone={data.settings.timezone}
        login={login}
        disconnect={disconnect}
      />
    </DetailLayout>
  );
}

/**
 * The connected screen, the usual state: the Connection heading over its card of Status and Last sync,
 * then Disconnect Garmin, at their loaded heights.
 */
function GarminSkeleton() {
  return (
    <div role="status" aria-label={garminCopy.loading} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex h-5.5 items-center">
          <div className="h-4 w-24 rounded-sm bg-surface-2" />
        </div>
        <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
          {["w-24", "w-40"].map((width) => (
            <div key={width} className="flex min-h-12 items-center justify-between py-3">
              <div className="h-4 w-16 rounded-sm bg-surface-2" />
              <div className={cn("h-4 rounded-sm bg-surface-2", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="h-11 w-40 rounded-sm bg-surface-2" />
    </div>
  );
}
