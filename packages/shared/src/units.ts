import { z } from "zod";

/** Storage is always SI (meters, seconds, bpm). These convert for display; formatting lives in the web app. */
export const unitsSchema = z.enum(["km", "mi"]);
export type Units = z.infer<typeof unitsSchema>;

export const METERS_PER_KM = 1000;
export const METERS_PER_MILE = 1609.344;
/** The international foot; elevation is shown in feet when distances are in miles. */
export const METERS_PER_FOOT = 0.3048;

/** A split faster than 2:00/km is a GPS glitch, not running. */
export const GPS_GLITCH_PACE_S_PER_KM = 120;

export function metersPerUnit(units: Units): number {
  return units === "km" ? METERS_PER_KM : METERS_PER_MILE;
}

/** Meters to kilometers or miles. */
export function distanceInUnits(distanceM: number, units: Units): number {
  return distanceM / metersPerUnit(units);
}

/** Elevation in the unit that goes with the distance unit: meters with km, feet with miles. */
export function elevationInUnits(elevationM: number, units: Units): number {
  return units === "km" ? elevationM : elevationM / METERS_PER_FOOT;
}

/** Seconds per kilometer or mile; null when there is no distance (indoor runs without a footpod). */
export function paceSecondsPerUnit(
  distanceM: number,
  durationS: number,
  units: Units,
): number | null {
  if (distanceM <= 0 || durationS <= 0) return null;
  return durationS / distanceInUnits(distanceM, units);
}

/** Seconds per kilometer or mile from meters per second; null when standing still. */
export function speedToPaceSecondsPerUnit(speedMps: number, units: Units): number | null {
  if (speedMps <= 0) return null;
  return metersPerUnit(units) / speedMps;
}

/** True when a split is faster than any human run, which means the GPS jumped. */
export function isGpsGlitch(distanceM: number, durationS: number): boolean {
  const pace = paceSecondsPerUnit(distanceM, durationS, "km");
  return pace !== null && pace < GPS_GLITCH_PACE_S_PER_KM;
}
