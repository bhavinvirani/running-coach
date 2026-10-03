import type { ReactNode } from "react";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { AccountSection } from "./parts/account-section";
import { ClaudeKeySection } from "./parts/claude-key-section";
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
      <ClaudeKeySection
        hasKey={data.settings.hasClaudeKey}
        credential={
          data.settings.claudePlanAvailable
            ? {
                // Without a key the coach uses nothing (none), and the key form is what to fill in.
                choice:
                  screen.coachCredential.pending ??
                  (data.settings.coachCredential === "plan" ? "plan" : "key"),
                error: screen.coachCredential.error,
                choose: screen.coachCredential.choose,
              }
            : undefined
        }
        {...screen.claudeKey}
      />
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
        <ClaudeKeySkeleton />
        <SkeletonCard rows={2} title />
        <SkeletonCard rows={2} title />
      </div>
    </SettingsLayout>
  );
}

/**
 * The Claude key card as it loads without a key: the title, the field's label, the field, the helper text's
 * two lines at 390 px, then Save key. Each block sits in a box at its text's line height, as in the card.
 */
function ClaudeKeySkeleton() {
  return (
    <div className="rounded-md border border-line bg-surface-1 px-4 pb-4">
      <div className="mt-4 flex h-5.5 items-center">
        <div className="h-4 w-24 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col gap-2 py-4">
        <div className="flex h-5.5 items-center">
          <div className="h-4 w-28 rounded-sm bg-surface-2" />
        </div>
        <div className="h-11 rounded-sm border border-line bg-surface-0" />
        <div>
          {["w-full", "w-1/2"].map((width) => (
            <div key={width} className="flex h-4 items-center">
              <div className={cn("h-3 rounded-sm bg-surface-2", width)} />
            </div>
          ))}
        </div>
      </div>
      <div className="h-11 w-24 rounded-sm bg-surface-2" />
    </div>
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
