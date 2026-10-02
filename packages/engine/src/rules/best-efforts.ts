import { DISTANCE_METERS, distanceKeySchema, type DistanceKey } from "@running-coach/shared";
import { GLITCH_WINDOW_S, GPS_GLITCH_SPEED_M_PER_S } from "../constants";

/** Row-aligned samples as Garmin's activity details give them, about one row a second. */
export interface BestEffortsInput {
  /** Timer seconds from the start, non-decreasing. */
  elapsedS: readonly number[];
  /** Cumulative meters. */
  distanceM: readonly number[];
}

export interface BestEffort {
  distanceKey: DistanceKey;
  /** Timer seconds for the distance, unrounded. */
  timeS: number;
  /** Timer seconds at the effort's start. */
  startS: number;
}

/** First and last sample index, inclusive. */
interface Span {
  first: number;
  last: number;
}

interface Window {
  timeS: number;
  startS: number;
}

// Sorted here rather than trusting the enum's order, so the result is shortest first by meters.
const DISTANCE_KEYS = [...distanceKeySchema.options].sort(
  (a, b) => DISTANCE_METERS[a] - DISTANCE_METERS[b],
);

/**
 * The fastest time over each known distance, shortest first, from one run's time and distance series.
 * Efforts never span a GPS glitch, a non-finite sample, or a place where time or distance goes
 * backwards: each comes from one continuous segment. A distance no segment reaches has no effort.
 */
export function bestEfforts({ elapsedS, distanceM }: BestEffortsInput): BestEffort[] {
  if (elapsedS.length !== distanceM.length) {
    throw new RangeError(
      `elapsedS and distanceM must be row-aligned, got ${elapsedS.length} and ${distanceM.length} rows`,
    );
  }
  const segments = soundSpans(elapsedS, distanceM).flatMap((span) =>
    glitchFreeSpans(elapsedS, distanceM, span),
  );
  return DISTANCE_KEYS.flatMap((distanceKey) => {
    let best: Window | null = null;
    for (const segment of segments) {
      const window = fastestWindow(elapsedS, distanceM, segment, DISTANCE_METERS[distanceKey]);
      // Strictly faster, so the earlier segment keeps an exact tie.
      if (window !== null && (best === null || window.timeS < best.timeS)) best = window;
    }
    return best === null ? [] : [{ distanceKey, ...best }];
  });
}

/** Maximal runs of finite samples along which neither time nor distance goes backwards. */
function soundSpans(t: readonly number[], d: readonly number[]): Span[] {
  const spans: Span[] = [];
  let first: number | null = null;
  for (let k = 0; k < t.length; k++) {
    const tk = t[k]!;
    const dk = d[k]!;
    if (!Number.isFinite(tk) || !Number.isFinite(dk)) {
      if (first !== null) spans.push({ first, last: k - 1 });
      first = null;
    } else if (first === null) {
      first = k;
    } else if (tk < t[k - 1]! || dk < d[k - 1]!) {
      spans.push({ first, last: k - 1 });
      first = k;
    }
  }
  if (first !== null) spans.push({ first, last: t.length - 1 });
  return spans;
}

/**
 * Splits a sound span where GPS glitched. The window from each sample runs to the first sample at
 * least GLITCH_WINDOW_S later (or the span's last sample); when its average speed beats the glitch
 * speed, every interval inside it is bad. Interval k joins samples k and k + 1.
 */
function glitchFreeSpans(t: readonly number[], d: readonly number[], span: Span): Span[] {
  const spans: Span[] = [];
  let end = span.first;
  // Intervals below badEnd lie inside a glitch window seen so far; window ends never move back,
  // so the latest glitch window's end is the furthest.
  let badEnd = span.first;
  let goodFirst = span.first;
  for (let i = span.first; i < span.last; i++) {
    end = Math.max(end, i + 1);
    while (end < span.last && t[end]! - t[i]! < GLITCH_WINDOW_S) end++;
    // Compared as a product so a zero-time window with distance in it counts as infinitely fast.
    if (d[end]! - d[i]! > GPS_GLITCH_SPEED_M_PER_S * (t[end]! - t[i]!)) badEnd = end;
    if (i < badEnd) {
      if (goodFirst < i) spans.push({ first: goodFirst, last: i });
      goodFirst = i + 1;
    }
  }
  if (goodFirst < span.last) spans.push({ first: goodFirst, last: span.last });
  return spans;
}

/**
 * The least time over `meters` inside one segment, with time interpolated against distance at both
 * ends. Window time is piecewise linear in where the window starts, so the optimum is a window that
 * starts at a sample or ends at one; a two-pointer sweep over each kind finds it in linear time.
 */
function fastestWindow(
  t: readonly number[],
  d: readonly number[],
  { first, last }: Span,
  meters: number,
): Window | null {
  if (d[last]! - d[first]! < meters) return null;
  let bestTimeS = Number.POSITIVE_INFINITY;
  let bestStartS = 0;

  // Starts at sample i; ends where distance first reaches d[i] + meters, inside interval j - 1.
  let j = first + 1;
  for (let i = first; i < last && d[i]! + meters <= d[last]!; i++) {
    const target = d[i]! + meters;
    j = Math.max(j, i + 1);
    while (d[j]! < target) j++;
    const timeS = timeAtDistance(t, d, j - 1, target) - t[i]!;
    if (timeS < bestTimeS) {
      bestTimeS = timeS;
      bestStartS = t[i]!;
    }
  }

  // Ends at sample k; starts the last moment distance was still d[k] - meters, inside interval i.
  let i = first;
  for (let k = first + 1; k <= last; k++) {
    const target = d[k]! - meters;
    if (target < d[first]!) continue;
    while (d[i + 1]! <= target) i++;
    const startS = timeAtDistance(t, d, i, target);
    if (t[k]! - startS < bestTimeS) {
      bestTimeS = t[k]! - startS;
      bestStartS = startS;
    }
  }

  // The guard above subtracts and the sweeps add, so a span equal to `meters` only up to float rounding
  // can pass it while neither sweep finds a window: no effort then, never an infinite one.
  if (bestTimeS === Number.POSITIVE_INFINITY) return null;
  return { timeS: bestTimeS, startS: bestStartS };
}

/** Time at which distance reaches `meters` within interval k, where d[k] <= meters <= d[k + 1] and d[k] < d[k + 1]. */
function timeAtDistance(
  t: readonly number[],
  d: readonly number[],
  k: number,
  meters: number,
): number {
  const fraction = (meters - d[k]!) / (d[k + 1]! - d[k]!);
  return t[k]! + fraction * (t[k + 1]! - t[k]!);
}
