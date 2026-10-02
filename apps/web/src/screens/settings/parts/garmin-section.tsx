import type { MeResponse } from "@running-coach/shared";
import { formatDateTime } from "@/lib/format";
import { Row, Section } from "./section";

type GarminSectionProps = {
  garmin: MeResponse["garmin"];
  timeZone: string;
};

/** Connection status and last sync. Connecting happens from the laptop CLI until the web flow lands. */
export function GarminSection({ garmin, timeZone }: GarminSectionProps) {
  if (garmin.status === "not_connected") {
    return (
      <Section title="Garmin">
        <div className="flex flex-col gap-1 py-3">
          <p className="text-body text-ink-2">Not connected.</p>
          <LaptopConnectHelp verb="connect" />
        </div>
      </Section>
    );
  }

  return (
    <Section title="Garmin">
      <Row label="Status">
        {garmin.status === "ok" ? (
          <span className="text-good">Connected</span>
        ) : (
          <span className="text-bad">Login expired</span>
        )}
      </Row>
      <Row label="Last sync">
        {garmin.lastSyncAt ? formatDateTime(garmin.lastSyncAt, timeZone) : "Never"}
      </Row>
      {garmin.status === "expired" ? (
        <div className="py-3">
          <LaptopConnectHelp verb="reconnect" />
        </div>
      ) : null}
    </Section>
  );
}

/**
 * Today's Garmin errors send the runner here, so this says how to act. Static copy: printing the page's
 * own address would make the screenshot depend on the host.
 */
function LaptopConnectHelp({ verb }: { verb: "connect" | "reconnect" }) {
  return (
    <p className="text-caption text-ink-2">
      To {verb}, run <code>pnpm garmin:connect</code> with this app&apos;s address on your laptop.
    </p>
  );
}
