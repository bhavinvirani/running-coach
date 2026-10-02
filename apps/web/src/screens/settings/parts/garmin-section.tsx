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
        <p className="py-3 text-body text-ink-2">Not connected.</p>
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
    </Section>
  );
}
