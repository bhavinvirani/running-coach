import type { ActivityLap, Units } from "@running-coach/shared";
import { toLapPoint } from "@/charts/lap-point";
import {
  MISSING,
  formatHeartRate,
  formatLapDistance,
  formatPaceValue,
  paceUnitLabel,
} from "@/lib/format";

type SplitsTableProps = {
  laps: readonly ActivityLap[];
  units: Units;
};

/**
 * Every lap as the watch recorded it (auto-laps at 1 km or 1 mi are the splits), GPS glitches included and
 * named, since the table is where the runner checks what the chart left out.
 */
export function SplitsTable({ laps, units }: SplitsTableProps) {
  if (laps.length === 0) {
    return <p className="text-body text-ink-2">No laps recorded for this run.</p>;
  }

  return (
    <table className="w-full text-body">
      <caption className="sr-only">Splits</caption>
      <thead>
        <tr className="text-caption text-ink-2">
          <th scope="col" className="py-2 text-left font-normal">
            Lap
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Distance
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Pace {paceUnitLabel(units)}
          </th>
          <th scope="col" className="py-2 text-right font-normal">
            Avg HR
          </th>
        </tr>
      </thead>
      <tbody>
        {laps.map((lap) => {
          const point = toLapPoint(lap, units);
          return (
            <tr key={lap.index} className="border-t border-line">
              <td className="py-2 text-ink-2">{lap.index}</td>
              <td className="py-2 text-right">
                {lap.distanceM > 0 ? formatLapDistance(point.distanceInUnit, units) : MISSING}
              </td>
              <td className="py-2 text-right">
                {point.gpsGlitch ? (
                  <span className="text-ink-2">GPS glitch</span>
                ) : (
                  formatPaceValue(point.paceSecondsPerUnit)
                )}
              </td>
              <td className="py-2 text-right">{formatHeartRate(lap.avgHr)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
