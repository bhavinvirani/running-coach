import {
  weekdaySchema,
  type Plan,
  type PlanPhase,
  type PlanSession,
  type PlanWeek,
  type SessionType,
  type Weekday,
} from "@running-coach/shared";
import { addDays } from "./dates";
import { formatCountValue } from "./format";

/** One day of a plan week; a day with no session is a rest day. */
export type PlanDay = { weekday: Weekday; date: string; sessions: readonly PlanSession[] };

/** Monday to Sunday from the week's Monday, each with its sessions in the order the plan lists them. */
export function planDays(week: PlanWeek): PlanDay[] {
  return weekdaySchema.options.map((weekday, offset) => {
    const date = addDays(week.startDate, offset);
    return { weekday, date, sessions: week.sessions.filter((session) => session.date === date) };
  });
}

const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** "Mon": the long-run picker's options and a week card's days for screen readers. */
export function weekdayName(weekday: Weekday): string {
  return WEEKDAY_NAMES[weekday];
}

/** "M": a week card's day cells, where three letters would not fit seven to a row at 390 px. */
export function weekdayInitial(weekday: Weekday): string {
  return WEEKDAY_NAMES[weekday].charAt(0);
}

/**
 * The type a day is shown as: its run when it has one (a strength session can share the day, slice 11),
 * else its first session, else rest.
 */
export function dayType(day: PlanDay): SessionType {
  const main = day.sessions.find((session) => session.type !== "strength") ?? day.sessions[0];
  return main?.type ?? "rest";
}

/** True when the Monday-to-Sunday week holds the date, "2026-10-14". */
export function weekHolds(week: PlanWeek, date: string): boolean {
  return date >= week.startDate && date <= addDays(week.startDate, 6);
}

/**
 * The plan's weeks still to run on `today`, the week that holds it included: all of them before the plan
 * starts, 1 in race week, 0 once the race or the plan's last Sunday is past. For a race, the weeks until it.
 */
export function weeksLeft(plan: Pick<Plan, "weeks" | "endDate">, today: string): number {
  return plan.weeks.filter((week) => {
    const lastDay = addDays(week.startDate, 6);
    return today <= (lastDay < plan.endDate ? lastDay : plan.endDate);
  }).length;
}

export function weekTitle(number: number): string {
  return `Week ${formatCountValue(number)}`;
}

const PHASE_NAMES: Readonly<Record<PlanPhase, string>> = {
  base: "Base",
  build: "Build",
  peak: "Peak",
  taper: "Taper",
  race: "Race week",
};

export function phaseName(phase: PlanPhase): string {
  return PHASE_NAMES[phase];
}
