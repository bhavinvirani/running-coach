import { weekdaySchema, type SessionType, type Weekday } from "@running-coach/shared";
import { HARD_DAY_MIN_GAP_DAYS, HARD_SESSION_TYPES } from "../constants";
import { daysBetween, weekdayIndex } from "../dates";

export interface WeekLayoutInput {
  longRunDay: Weekday;
  daysPerWeek: number;
  qualityCount: number;
  /** Days from the last hard day before this week to its Monday (1 for the Sunday before); null for none. */
  lastHardDaysBefore: number | null;
}

export interface WeekLayout {
  longRun: Weekday;
  /** One day per quality session, in the order asked for. */
  quality: Weekday[];
  /** In fill order: the first easy run goes on the first day. */
  easy: Weekday[];
}

// Days after the long run, wrapping inside the same Monday-to-Sunday week. Week after week the same
// pattern leaves gaps of 2, 2 and 3 days (L, L+2, L+4) or 3 and 4 (L, L+3).
const QUALITY_OFFSETS: readonly (readonly number[])[] = [[], [3], [2, 4]];
const EASY_OFFSETS = [3, 5, 1, 6, 2, 4];
// Nearest days first, later before earlier, for a session that has to move.
const MOVES = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];

/**
 * Which weekday holds the long run, each quality session and each easy run; days not named are rest.
 * A week whose pattern differs from the last one's can put a wrapped session the day after last week's
 * last hard day (a Friday long run going from 2 sessions to 1, a Thursday one from 1 to 2); that session
 * moves to the nearest free day 48 h from every hard day, next week's long run included.
 */
export function weekLayout({
  longRunDay,
  daysPerWeek,
  qualityCount,
  lastHardDaysBefore,
}: WeekLayoutInput): WeekLayout {
  const qualityOffsets = QUALITY_OFFSETS[qualityCount];
  if (
    qualityOffsets === undefined ||
    !Number.isInteger(daysPerWeek) ||
    daysPerWeek < 1 + qualityCount ||
    daysPerWeek > 7
  ) {
    throw new RangeError(
      `No week layout for ${qualityCount} quality sessions in ${daysPerWeek} days`,
    );
  }
  if (
    lastHardDaysBefore !== null &&
    !(Number.isInteger(lastHardDaysBefore) && lastHardDaysBefore >= 1)
  ) {
    throw new RangeError(`The last hard day must be before Monday, got ${lastHardDaysBefore} days`);
  }
  const longRun = weekdayIndex(longRunDay);
  const wanted = qualityOffsets.map((offset) => (longRun + offset) % 7);
  const placed = new Map<number, number>();
  // Earliest first, so each session is checked against the hard day before it as finally placed.
  for (const index of [...wanted.keys()].sort((a, b) => wanted[a]! - wanted[b]!)) {
    const hard = [
      longRun,
      longRun + 7,
      ...(lastHardDaysBefore === null ? [] : [-lastHardDaysBefore]),
      ...placed.values(),
      ...wanted.filter((_, other) => other !== index && !placed.has(other)),
    ];
    const spaced = (day: number) =>
      day >= 0 && day <= 6 && hard.every((h) => Math.abs(day - h) >= HARD_DAY_MIN_GAP_DAYS);
    // At most 2 sessions and a last hard day before Monday always leave a spaced day: every long-run
    // day has two free days 2 apart and at least 2 from the long runs and the Sunday before.
    placed.set(index, MOVES.map((move) => wanted[index]! + move).find(spaced)!);
  }
  const quality = wanted.map((_, index) => placed.get(index)!);
  const easy = EASY_OFFSETS.map((offset) => (longRun + offset) % 7)
    .filter((day) => !quality.includes(day))
    .slice(0, daysPerWeek - 1 - qualityCount);
  const name = (day: number) => weekdaySchema.options[day]!;
  return { longRun: longRunDay, quality: quality.map(name), easy: easy.map(name) };
}

/** The 48 h rule between hard days; true when there is no hard day before. */
export function isSpacedFromHardDay({
  lastHardDate,
  date,
}: {
  lastHardDate: string | null;
  date: string;
}): boolean {
  return lastHardDate === null || daysBetween(lastHardDate, date) >= HARD_DAY_MIN_GAP_DAYS;
}

/** A session by its type on a local date. */
export interface DatedSession {
  type: SessionType;
  date: string;
}

export interface HardSessionTooCloseInput extends DatedSession {
  /** The sessions around `date`, the one being placed excluded. */
  others: readonly DatedSession[];
}

/**
 * The hard session nearer than 48 h to a hard session of `type` placed on `date`: the nearest one,
 * the earlier on a tie; null when `type` is not hard or none is that near. A move is the runner's call,
 * so this is a warning to show, never a reason to refuse.
 */
export function hardSessionTooClose({
  type,
  date,
  others,
}: HardSessionTooCloseInput): DatedSession | null {
  if (!HARD_SESSION_TYPES.has(type)) return null;
  let nearest: { session: DatedSession; offset: number } | null = null;
  for (const other of others) {
    if (!HARD_SESSION_TYPES.has(other.type)) continue;
    const offset = daysBetween(date, other.date);
    if (Math.abs(offset) >= HARD_DAY_MIN_GAP_DAYS) continue;
    const closer =
      nearest === null ||
      Math.abs(offset) < Math.abs(nearest.offset) ||
      (Math.abs(offset) === Math.abs(nearest.offset) && offset < nearest.offset);
    if (closer) nearest = { session: other, offset };
  }
  return nearest === null ? null : { type: nearest.session.type, date: nearest.session.date };
}
