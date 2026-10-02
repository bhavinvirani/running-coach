import type { ReactNode } from "react";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { AccountSection } from "./parts/account-section";
import { CoachDetailField } from "./parts/coach-detail-field";
import { GarminSection } from "./parts/garmin-section";
import { Section } from "./parts/section";
import { UnitsField } from "./parts/units-field";
import { useSettingsScreen } from "./use-settings";

/** Settings tab. No empty state: every account gets its settings row when it is created (auth.ts). */
export function SettingsScreen() {
  const screen = useSettingsScreen();
  const { data, status, error, refetch } = screen;

  if (status === "pending") {
    return <SettingsSkeleton />;
  }

  if (status === "error") {
    return (
      <SettingsLayout>
        <div className="flex flex-col items-start gap-4">
          <p role="alert" className="text-body text-ink">
            {errorMessage(error)}
          </p>
          <Button variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      </SettingsLayout>
    );
  }

  const settings = { ...data.settings, ...screen.pendingChanges };

  return (
    <SettingsLayout>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <Section>
        <UnitsField value={settings.units} onChange={(units) => screen.updateSettings({ units })} />
        <CoachDetailField
          value={settings.coachDetail}
          onChange={(coachDetail) => screen.updateSettings({ coachDetail })}
        />
      </Section>
      {screen.updateError ? (
        <p role="alert" className="text-body text-ink">
          {errorMessage(screen.updateError)}
        </p>
      ) : null}
      <GarminSection garmin={data.garmin} timeZone={data.settings.timezone} />
      <AccountSection
        email={data.user.email}
        onLogOut={screen.logOut}
        loggingOut={screen.loggingOut}
        logOutError={screen.logOutError}
      />
    </SettingsLayout>
  );
}

function SettingsLayout({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <div className="flex flex-col gap-4 px-4 pt-4 pb-8" aria-busy={busy}>
      <h1 className="text-title text-ink">Settings</h1>
      {children}
    </div>
  );
}

/** Same cards and row heights as the loaded screen, so nothing jumps when data arrives. */
function SettingsSkeleton() {
  return (
    <SettingsLayout busy>
      <div role="status" aria-label="Loading settings" className="flex flex-col gap-4">
        <SkeletonCard rows={2} tall />
        <SkeletonCard rows={2} title />
        <SkeletonCard rows={2} title />
      </div>
    </SettingsLayout>
  );
}

function SkeletonCard({ rows, title, tall }: { rows: number; title?: boolean; tall?: boolean }) {
  return (
    <div className="rounded-md border border-line bg-surface-1 px-4">
      {title ? <div className="mt-5 h-4 w-20 rounded-sm bg-surface-2" /> : null}
      <div className="flex flex-col divide-y divide-line">
        {Array.from({ length: rows }, (_, row) =>
          tall ? (
            <div key={row} className="flex flex-col gap-3 py-4">
              <div className="h-4 w-24 rounded-sm bg-surface-2" />
              <div className="h-13 rounded-md bg-surface-0" />
              <div className="h-3 w-48 rounded-sm bg-surface-2" />
            </div>
          ) : (
            <div key={row} className="flex min-h-12 items-center justify-between py-3">
              <div className="h-4 w-20 rounded-sm bg-surface-2" />
              <div className="h-4 w-32 rounded-sm bg-surface-2" />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
