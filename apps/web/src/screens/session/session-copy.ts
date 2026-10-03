import type { MoveWarning, SessionStatus } from "@running-coach/shared";
import { daysBetween } from "@/lib/dates";
import { formatCountValue, formatShortDay } from "@/lib/format";
import { sessionTypeName } from "@/lib/session-type";

/** Every sentence and label on the session screen, so the wording is read and changed in one place. */
export const sessionCopy = {
  /** The title while the session loads or when it failed to. */
  title: "Session",
  loading: "Loading the session",
  distance: "Distance",
  time: "Time",
  steps: "Steps",
  garmin: "Garmin",
  move: "Move",
  moveTo: "Move to",
  skip: "Skip session",
  keepSession: "Keep session",
  skipQuestion: "Skip this session? The plan does not make it up, and it comes off your watch.",
  remove: "Delete workout",
  keepWorkout: "Keep workout",
  removeQuestion: "Delete this workout? It comes off your watch too.",
  edit: "Edit workout",
} as const;

const STATUS_WORDS: Readonly<Record<SessionStatus, string | null>> = {
  planned: null,
  moved: "Moved",
  done: "Done",
  missed: "Missed",
  skipped: "Skipped",
};

/** What happened to the session, for the line under its name; null while it is simply planned. */
export function statusWord(status: SessionStatus): string | null {
  return STATUS_WORDS[status];
}

/** A repeat's count as its group heading: "5 x". */
export function repeatLabel(repeat: number): string {
  return `${formatCountValue(repeat)} x`;
}

/**
 * Why a move left two hard sessions close, as the coach says it: "Tempo is now a day from Intervals on
 * Thu 8. The plan keeps 48 hours between hard sessions." The move stands; this only says what it costs.
 */
export function moveWarningSentence(name: string, date: string, warning: MoveWarning): string {
  const other = sessionTypeName(warning.otherType);
  const where =
    daysBetween(date, warning.otherDate) === 0
      ? `on the same day as ${other}`
      : `a day from ${other} on ${formatShortDay(warning.otherDate)}`;
  return `${name} is now ${where}. The plan keeps 48 hours between hard sessions.`;
}
