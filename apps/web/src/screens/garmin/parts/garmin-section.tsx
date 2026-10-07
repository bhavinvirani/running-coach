import type { MeResponse } from "@running-coach/shared";
import { useEffect, useRef, useState } from "react";
import { SettingsCard, SettingsRow } from "@/components/settings-card";
import { formatDateTime } from "@/lib/format";
import { garminCopy, garminStatusLabels } from "../garmin-copy";
import type { DisconnectActions, LoginActions } from "../use-garmin";
import { ConnectForm } from "./connect-form";
import { DisconnectGarmin } from "./disconnect-garmin";

type GarminSectionProps = {
  garmin: MeResponse["garmin"];
  timeZone: string;
  login: LoginActions;
  disconnect: DisconnectActions;
};

const STATUS_COLORS = { ok: "text-good", expired: "text-bad", not_connected: "text-ink" } as const;

/**
 * The connection by its status. Not connected: the form to connect. Expired: Status and Last sync, the same
 * form to reconnect, and Disconnect that only forgets the login. Connected: Status, Last sync and Disconnect.
 * Each block holds its place in the card whatever the status, so a confirm step open when the login turns
 * out expired stays open. A connect or a disconnect takes away the control that was focused, so the line
 * saying what it did takes focus.
 */
export function GarminSection({ garmin, timeZone, login, disconnect }: GarminSectionProps) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const outcomeLine = useRef<HTMLParagraphElement>(null);
  // Set with the outcome, so only a connect or disconnect moves focus, never a refetch.
  const focusOutcome = useRef(false);

  useEffect(() => {
    if (!focusOutcome.current || outcomeLine.current === null) return;
    focusOutcome.current = false;
    outcomeLine.current.focus();
  });

  const show = (line: string) => {
    focusOutcome.current = true;
    setOutcome(line);
  };
  const clear = () => setOutcome(null);

  return (
    <SettingsCard title={garminCopy.title}>
      <SettingsRow label={garminCopy.status}>
        <span className={STATUS_COLORS[garmin.status]}>{garminStatusLabels[garmin.status]}</span>
      </SettingsRow>
      {garmin.status === "not_connected" ? null : (
        <SettingsRow label={garminCopy.lastSync}>
          {garmin.lastSyncAt ? formatDateTime(garmin.lastSyncAt, timeZone) : garminCopy.never}
        </SettingsRow>
      )}
      {outcome === null ? null : (
        <p ref={outcomeLine} role="status" tabIndex={-1} className="py-3 text-body text-ink">
          {outcome}
        </p>
      )}
      {garmin.status === "ok" ? null : (
        <ConnectForm
          mode={garmin.status === "expired" ? "reconnect" : "connect"}
          login={login}
          onStart={clear}
          onConnected={() => show(garminCopy.connected)}
        />
      )}
      {garmin.status === "not_connected" ? null : (
        <DisconnectGarmin
          canRemove={garmin.status === "ok"}
          disconnect={disconnect}
          onStart={clear}
          onDisconnected={show}
        />
      )}
    </SettingsCard>
  );
}
