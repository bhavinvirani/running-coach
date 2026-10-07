import { HeartPulse, KeyRound, MessageSquareText, Ruler, Watch } from "lucide-react";
import type { ReactNode } from "react";
import { CardSection } from "@/components/card-section";
import { ListRow } from "@/components/list-row";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { coachDetailNames, unitsNames } from "@/lib/settings-names";
import { AccountSection } from "./parts/account-section";
import { claudeValue, garminStatusNames } from "./settings-copy";
import { useSettingsScreen } from "./use-settings";

/**
 * Settings tab: grouped cards of rows, each opening one screen, with what it holds now on the right.
 * No empty state: every account gets its settings row when it is created (auth.ts).
 */
export function SettingsScreen() {
  const screen = useSettingsScreen();
  const { data, status, error, refetch } = screen;

  if (status === "pending") {
    return <SettingsSkeleton />;
  }

  if (status === "error") {
    return (
      <SettingsLayout>
        <LoadError error={error} onRetry={() => void refetch()} />
      </SettingsLayout>
    );
  }

  const { settings, garmin } = data;

  return (
    <SettingsLayout>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <CardSection title="My stuff">
        <ListRow
          to="/settings/garmin"
          icon={Watch}
          label="Garmin"
          value={garminStatusNames[garmin.status]}
        />
        <ListRow
          to="/settings/claude"
          icon={KeyRound}
          label="Claude"
          value={claudeValue(settings)}
        />
      </CardSection>
      <CardSection title="My preferences">
        <ListRow
          to="/settings/units"
          icon={Ruler}
          label="Units"
          value={unitsNames[settings.units]}
        />
        <ListRow
          to="/settings/coach-detail"
          icon={MessageSquareText}
          label="Coach detail"
          value={coachDetailNames[settings.coachDetail]}
        />
        <ListRow to="/settings/hr-zones" icon={HeartPulse} label="Heart-rate zones" />
      </CardSection>
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
        <SkeletonGroup rows={2} />
        <SkeletonGroup rows={3} />
        <AccountSkeleton />
      </div>
    </SettingsLayout>
  );
}

/** A CardSection of ListRows: the heading's line above the card, then icon, label and value per row. */
function SkeletonGroup({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-24 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex min-h-12 items-center gap-3 py-3">
            <div className="size-5 rounded-sm bg-surface-2" />
            <div className="h-4 w-24 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** The Account card like the list cards: heading above, then the email row and Log out. */
function AccountSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-20 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        <div className="flex min-h-12 items-center justify-between py-3">
          <div className="h-4 w-12 rounded-sm bg-surface-2" />
          <div className="h-4 w-40 rounded-sm bg-surface-2" />
        </div>
        <div className="py-4">
          <div className="h-11 w-24 rounded-sm bg-surface-2" />
        </div>
      </div>
    </div>
  );
}
