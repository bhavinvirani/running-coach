import type { HrZoneTime } from "@running-coach/shared";

// Seconds in each heart-rate zone from a run's stored series, for custom zones (SPEC: activity_stream);
// pure, so run detail (activity-detail.ts) computes it on every read and the rules are unit-tested alone.

/**
 * Seconds in zones 1 to 5 of `lowBpm` (zone 1's floor first). Each sample holds its heart rate until the
 * next one, so the last sample adds nothing; a gap between two samples (a missing reading, or elapsed time
 * that does not rise) counts nowhere. A heart rate on a floor is in that zone, and one below zone 1 is in
 * no zone, as on Garmin. Seconds are rounded once at the end, so a thinned series' fractions add up. Null
 * when the series holds no heart rate at all (no HR sensor).
 */
export function secondsInZones(
  elapsedS: readonly number[],
  hr: readonly (number | null)[] | null,
  lowBpm: readonly number[],
): HrZoneTime[] | null {
  if (hr === null || !hr.some((bpm) => bpm !== null)) return null;
  const seconds = lowBpm.map(() => 0);
  for (let i = 0; i + 1 < elapsedS.length; i += 1) {
    const bpm = hr[i];
    const dt = elapsedS[i + 1]! - elapsedS[i]!;
    if (bpm === null || bpm === undefined || !(dt > 0)) continue;
    const zone = lowBpm.findLastIndex((floor) => floor <= bpm);
    if (zone >= 0) seconds[zone]! += dt;
  }
  return lowBpm.map((floor, i) => ({
    zone: i + 1,
    lowBpm: floor,
    seconds: Math.round(seconds[i]!),
  }));
}
