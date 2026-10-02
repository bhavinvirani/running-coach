const MINUTES_SECONDS = /^(\d{1,3}):([0-5]\d)$/;
const HOURS_MINUTES_SECONDS = /^(\d{1,2}):([0-5]\d):([0-5]\d)$/;

/**
 * A race time as a runner types it, in whole seconds: "49:30" → 2970, "1:45:00" → 6300, "5:07" → 307.
 * Minutes and seconds take two digits after the first colon, so "1:5" or "25:75" is a typo, not a time.
 * Null for anything else, an empty field included, and for a zero time.
 */
export function parseDuration(text: string): number | null {
  const value = text.trim();
  const long = HOURS_MINUTES_SECONDS.exec(value);
  if (long) {
    const [hours, minutes, seconds] = long.slice(1).map(Number) as [number, number, number];
    return positive(hours * 3600 + minutes * 60 + seconds);
  }
  const short = MINUTES_SECONDS.exec(value);
  if (short) {
    const [minutes, seconds] = short.slice(1).map(Number) as [number, number];
    return positive(minutes * 60 + seconds);
  }
  return null;
}

function positive(seconds: number): number | null {
  return seconds > 0 ? seconds : null;
}
