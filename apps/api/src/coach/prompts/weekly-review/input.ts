import {
  type CoachDetail,
  type DeltaRejection,
  type GoalKind,
  isGpsGlitch,
  type PauseReason,
  type PlanPhase,
  type RaceDistanceKey,
  type ReviewWeekSummary,
  type SessionStatus,
  type SessionType,
  type Units,
} from "@running-coach/shared";
import { formatDistance, formatDuration, formatLocalDate, formatPace } from "../../format";
import { describeSession } from "../run-insight/input";

// The user message for weekly-review: the Monday-to-Sunday week that just ended (its sessions as stored,
// with the run that matched each, the runs no session matched, its totals against the week before, any
// pause, and a pause opened since and still open), then the goal and the coming week's sessions under
// labels s1..sN with whether each may change.
// Built from plain JSON the service passes in (an eval case's input is exactly { week, plan, settings }),
// in the runner's units through format.ts, with labels instead of ids, so it cannot carry the API key,
// Garmin tokens, the email, an id or another user's data.

export interface ReviewSettings {
  units: Units;
  coachDetail: CoachDetail;
}

/** A run as the review sees it, SI units. */
export interface ReviewRun {
  distanceM: number;
  durationS: number;
  avgHr: number | null;
  /** A treadmill or other indoor run: its distance is the watch's estimate. */
  isIndoor: boolean;
}

/** A session of the reviewed week as stored, skipped ones included. */
export interface ReviewWeekSession {
  /** Local date, "2026-09-30". */
  date: string;
  type: SessionType;
  /** Null names it by its type. */
  title: string | null;
  /** As stored: a missed session stays missed, a moved one sits on the day it was moved to. */
  status: SessionStatus;
  /** Target distance and time. */
  distanceM: number;
  durationS: number;
  /** The run that matched it (status done), or null when none did. */
  run: ReviewRun | null;
}

/** A run on one of the week's local dates that no session matched. */
export interface ReviewExtraRun extends ReviewRun {
  date: string;
}

/** A training pause that covered at least one of the reviewed week's days, or the one open now. */
export interface ReviewPause {
  reason: PauseReason;
  /** The local date the runner paused, maybe before the week. */
  startDate: string;
  /** The local date the runner tapped I'm back; null while the pause is open. */
  endDate: string | null;
}

/** The week that just ended, Monday to Sunday in the runner's zone. */
export interface ReviewWeek {
  /** The Monday, a local date. */
  weekStart: string;
  /** By date. */
  sessions: ReviewWeekSession[];
  /** By date. */
  extraRuns: ReviewExtraRun[];
  summary: ReviewWeekSummary;
  /** The Monday-to-Sunday week before it; null when it had no run. */
  weekBefore: { runs: number; distanceM: number } | null;
  pause: ReviewPause | null;
  /**
   * The runner's pause open now, maybe opened after the week (on the Monday before the job ran): the plan
   * is on hold while it lasts. The same pause as `pause` when that one is still open.
   */
  openPause: ReviewPause | null;
}

export interface ReviewGoal {
  kind: GoalKind;
  /** The race distance; for a fitness goal the distance the sessions are shaped around, or null. */
  distanceKey: RaceDistanceKey | null;
  /** Local date; null for a fitness goal. */
  raceDate: string | null;
  targetTimeS: number | null;
}

/** A session of the coming week, as the plan has it now. */
export interface ReviewPlanSession {
  /** "s1".."sN" by date: what a proposed change names, never the session's id. */
  label: string;
  date: string;
  type: SessionType;
  title: string | null;
  status: SessionStatus;
  distanceM: number;
  durationS: number;
  /** The engine would take a change to it (not a race, custom, locked or already changed by the coach). */
  changeable: boolean;
}

/** The active plan as the review sees it; the review gets null without one. */
export interface ReviewPlan {
  goal: ReviewGoal;
  /** The coming week's number in the plan, 1 for its first week. */
  weekNumber: number;
  phase: PlanPhase;
  /** Weeks from the coming week's Monday to the race's week: 0 when the race is in it; null without a race date. */
  weeksToRace: number | null;
  /** The coming week's sessions, plan and custom, skipped ones included, by date. */
  sessions: ReviewPlanSession[];
  /** Whether the review may propose changes at all; reason null when it may. */
  changeAllowed: boolean;
  reason: DeltaRejection | null;
}

const PAUSE_WORDS: Record<PauseReason, string> = {
  sick: "sick",
  injured: "pain or injury",
  break: "a break",
};

const STATUS_WORDS: Record<SessionStatus, string> = {
  planned: "planned",
  done: "done",
  missed: "missed",
  moved: "moved to this day by the runner",
  skipped: "skipped",
};

/** The goal's race as a runner says it. */
const RACE_NAMES: Record<RaceDistanceKey, string> = {
  "5k": "5K",
  "10k": "10K",
  half: "half marathon",
  marathon: "marathon",
};

const PHASE_WORDS: Record<PlanPhase, string> = {
  base: "base phase",
  build: "build phase",
  peak: "peak phase",
  taper: "taper",
  race: "race week",
};

// Why the review may not change the coming week, in the prompt's words.
const REFUSAL_WORDS: Record<DeltaRejection, string> = {
  race: "the coming week holds the race",
  custom: "the coming week holds only the runner's own workouts",
  locked: "the coming week's sessions are done, missed or past",
  adjusted: "the coach already changed the coming week",
  paused: "training is paused",
  stale_run: "this review is not for the latest week",
  no_session: "nothing is planned in the coming week",
  no_change: "the coming week cannot change",
  invalid: "the coming week cannot change",
};

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

/** Sunday, six days after the week's Monday, as a local date. */
function weekEnd(weekStart: string): string {
  const date = new Date(`${weekStart}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 6);
  return date.toISOString().slice(0, 10);
}

/** "8.2 km in 46:10 at 5:38 /km, average heart rate 142 bpm", flagged when indoor. */
function describeRun(run: ReviewRun, units: Units): string {
  const glitch = isGpsGlitch(run.distanceM, run.durationS);
  const pace = glitch ? null : formatPace(run.distanceM, run.durationS, units);
  const parts = [
    `${formatDistance(run.distanceM, units)} in ${formatDuration(run.durationS)}${pace ? ` at ${pace}` : ""}`,
    run.avgHr === null ? "heart rate missing" : `average heart rate ${Math.round(run.avgHr)} bpm`,
  ];
  if (run.isIndoor)
    parts.push("indoor run (treadmill): distance and pace are the watch's estimate");
  if (glitch) parts.push("GPS glitch: the distance is wrong, ignore pace");
  return parts.join(", ");
}

/** "sick, from Tuesday 29 September 2026, ended Thursday 1 October 2026" */
function describePause(pause: ReviewPause): string {
  const reason = PAUSE_WORDS[pause.reason];
  return pause.endDate === null
    ? `${reason}, since ${formatLocalDate(pause.startDate)}, still open`
    : `${reason}, from ${formatLocalDate(pause.startDate)}, ended ${formatLocalDate(pause.endDate)}`;
}

/** The coming week's sessions that will run: not skipped. */
export function liveSessions<T extends { status: SessionStatus }>(sessions: readonly T[]): T[] {
  return sessions.filter((session) => session.status !== "skipped");
}

function weekLines(week: ReviewWeek, units: Units): string[] {
  const { summary } = week;
  const runs =
    summary.runs === 0
      ? "none"
      : `${summary.runs}, ${formatDistance(summary.distanceM, units)} in ${formatDuration(summary.durationS)}`;
  const planned =
    summary.plannedDistanceM === 0
      ? "none"
      : `${formatDistance(summary.plannedDistanceM, units)}; the week's runs came to ${Math.round((100 * summary.distanceM) / summary.plannedDistanceM)}% of it`;
  const done =
    summary.sessionsPlanned === 0
      ? "none planned"
      : `${summary.sessionsDone} of ${summary.sessionsPlanned} planned`;
  const before = week.weekBefore
    ? `${count(week.weekBefore.runs, "run")}, ${formatDistance(week.weekBefore.distanceM, units)}`
    : "no runs";
  const lines = [
    `Week reviewed: ${formatLocalDate(week.weekStart)} to ${formatLocalDate(weekEnd(week.weekStart))}`,
    `Runs: ${runs}`,
    `Sessions done: ${done}`,
    `Planned distance: ${planned}`,
    `Week before: ${before}`,
    `Training pause: ${week.pause ? describePause(week.pause) : "none"}`,
  ];
  // Only a pause the week did not hold: an open one that did is already on the line above.
  if (week.openPause && week.openPause.startDate !== week.pause?.startDate) {
    lines.push(`Training pause now: ${describePause(week.openPause)}`);
  }
  if (week.sessions.length === 0) lines.push("Sessions of the week: none");
  else {
    lines.push("Sessions of the week:");
    for (const session of week.sessions) {
      const run = session.run ? describeRun(session.run, units) : "none";
      lines.push(
        `- ${formatLocalDate(session.date)}: ${describeSession(session, units)}. Status: ${STATUS_WORDS[session.status]}. Run: ${run}.`,
      );
    }
  }
  if (week.extraRuns.length === 0) lines.push("Runs without a session: none");
  else {
    lines.push("Runs without a session:");
    for (const run of week.extraRuns) {
      lines.push(`- ${formatLocalDate(run.date)}: ${describeRun(run, units)}.`);
    }
  }
  return lines;
}

function goalLine(goal: ReviewGoal): string {
  const race = goal.distanceKey ? RACE_NAMES[goal.distanceKey] : null;
  if (goal.kind === "fitness") {
    return `Goal: general fitness${race ? `, sessions shaped around the ${race}` : ""}`;
  }
  const date = goal.raceDate ? ` on ${formatLocalDate(goal.raceDate)}` : ", no race date";
  const target =
    goal.targetTimeS === null
      ? "no target time"
      : `target time ${formatDuration(goal.targetTimeS)}`;
  return `Goal: ${race ?? "race"} race${date}, ${target}`;
}

function planLines(plan: ReviewPlan | null, units: Units): string[] {
  if (plan === null) {
    return ["Plan: none", "Changes to the coming week: not allowed (the runner has no plan)"];
  }
  const lines = [
    goalLine(plan.goal),
    `Coming week: week ${plan.weekNumber} of the plan, ${PHASE_WORDS[plan.phase]}`,
  ];
  if (plan.weeksToRace !== null) {
    lines.push(
      `Weeks to the race: ${plan.weeksToRace}${plan.weeksToRace === 0 ? " (the race is in the coming week)" : ""}`,
    );
  }
  if (plan.sessions.length === 0) lines.push("Coming week's sessions: none");
  else {
    lines.push("Coming week's sessions:");
    for (const session of plan.sessions) {
      lines.push(
        `- ${session.label}, ${formatLocalDate(session.date)}: ${describeSession(session, units)}. Status: ${STATUS_WORDS[session.status]}. ${session.changeable ? "May change" : "Fixed"}.`,
      );
    }
  }
  const live = liveSessions(plan.sessions);
  const distanceM = live.reduce((sum, session) => sum + session.distanceM, 0);
  lines.push(
    `Coming week's planned distance: ${formatDistance(distanceM, units)} over ${count(live.length, "session")}`,
  );
  const change = plan.changeAllowed
    ? "allowed"
    : `not allowed (${REFUSAL_WORDS[plan.reason ?? "no_change"]})`;
  lines.push(`Changes to the coming week: ${change}`);
  return lines;
}

export function buildWeeklyReviewInput(
  week: ReviewWeek,
  plan: ReviewPlan | null,
  settings: ReviewSettings,
): string {
  const { units } = settings;
  return [
    `Detail level: ${settings.coachDetail}`,
    `Units: ${units === "km" ? "kilometers" : "miles"}`,
    ...weekLines(week, units),
    ...planLines(plan, units),
  ].join("\n");
}
