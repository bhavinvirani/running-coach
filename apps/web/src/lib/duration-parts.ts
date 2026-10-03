/** A time as the pickers hold it: whole hours, minutes and seconds. */
export type DurationParts = { hours: number; minutes: number; seconds: number };

/** Each picker's label, also what an e2e flow picks by. */
export const DURATION_PART_LABELS: Readonly<Record<keyof DurationParts, string>> = {
  hours: "Hours",
  minutes: "Minutes",
  seconds: "Seconds",
};

/** 0:00:00, where a picker starts before the runner picks a time. */
export const ZERO_DURATION: DurationParts = { hours: 0, minutes: 0, seconds: 0 };

/** 6300 → 1 h 45 min 0 s. Whole seconds only: a fraction a stored time should not have is cut. */
export function durationParts(seconds: number): DurationParts {
  const total = Math.max(0, Math.floor(seconds));
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  };
}

/** 1 h 45 min 0 s → 6300. */
export function durationSeconds({ hours, minutes, seconds }: DurationParts): number {
  return hours * 3600 + minutes * 60 + seconds;
}
