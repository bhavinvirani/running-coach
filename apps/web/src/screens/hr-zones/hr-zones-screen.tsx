import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { cn } from "@/lib/cn";
import { hrZonesCopy } from "./hr-zones-copy";
import { ZonesForm } from "./parts/zones-form";
import { useHrZonesScreen } from "./use-hr-zones";

/**
 * The heart rate zones in use at /settings/hr-zones, editable, from Settings and the run's zones card.
 * No empty state: before any run with heart rate the form starts from a max HR the runner types.
 */
export function HrZonesScreen() {
  const screen = useHrZonesScreen();
  const { data, status, error, refetch } = screen;

  if (status === "pending") {
    return (
      <DetailLayout title={hrZonesCopy.title} backTo="/settings" busy>
        <ZonesSkeleton />
      </DetailLayout>
    );
  }

  if (status === "error") {
    return (
      <DetailLayout title={hrZonesCopy.title} backTo="/settings">
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  const refetchFailed = screen.refetchError ? (
    <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
  ) : null;

  return (
    <DetailLayout title={hrZonesCopy.title} backTo="/settings">
      {refetchFailed}
      <ZonesForm
        source={data.source}
        zones={data.zones}
        saving={screen.saving}
        saveError={screen.saveError}
        save={screen.save}
        resetting={screen.resetting}
        resetError={screen.resetError}
        resetToGarmin={screen.resetToGarmin}
      />
    </DetailLayout>
  );
}

/** The caption, the zones card with max HR and five zone rows, and Save zones at their loaded heights. */
function ZonesSkeleton() {
  return (
    <div role="status" aria-label={hrZonesCopy.loading} className="flex flex-col gap-4">
      <div className="flex h-4 items-center">
        <div className="h-3 w-64 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex h-5.5 items-center">
          <div className="h-4 w-14 rounded-sm bg-surface-2" />
        </div>
        <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
          <div className="flex flex-col gap-2 py-4">
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-16 rounded-sm bg-surface-2" />
            </div>
            <div className="h-11 w-24 rounded-sm border border-line bg-surface-0" />
            {/* The helper's two caption lines at 390 px. */}
            <div>
              {["w-full", "w-1/3"].map((width) => (
                <div key={width} className="flex h-4 items-center">
                  <div className={cn("h-3 rounded-sm bg-surface-2", width)} />
                </div>
              ))}
            </div>
          </div>
          {Array.from({ length: 5 }, (_, zone) => (
            <div key={zone} className="flex min-h-12 items-center justify-between gap-3 py-3">
              <div className="flex flex-col gap-1">
                <div className="h-4 w-24 rounded-sm bg-surface-2" />
                <div className="h-3 w-20 rounded-sm bg-surface-2" />
              </div>
              <div className="flex gap-3">
                <div className="h-11 w-18 rounded-sm border border-line bg-surface-0" />
                <div className="h-11 w-24 rounded-sm border border-line bg-surface-0" />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="h-11 w-32 rounded-sm bg-surface-2" />
    </div>
  );
}
