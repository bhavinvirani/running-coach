import type { CalendarDay, CalendarQuery, CalendarResponse } from "@running-coach/shared";
import { and, asc, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { plan, planSession, userSettings } from "../db/schema";
import { addDays, daysBetween } from "../lib/local-date";
import { toPlanSession } from "./session-view";
import { readPushStatus } from "./workout-push";

// The runner's days between two local dates: the active plan's sessions and the runner's custom workouts,
// with the push status, for Today's next seven days and the session screens.

/**
 * GET /api/calendar: one entry per date from `from` to `to`, a day without sessions included. The active
 * plan's sessions, skipped ones included, and the custom workouts that are not skipped (a skipped custom
 * workout is deleted as far as the runner is concerned); plan sessions first on a day.
 */
export async function getCalendar(
  userId: string,
  { from, to }: CalendarQuery,
  now = new Date(),
): Promise<CalendarResponse> {
  const [settings] = await db
    .select({ units: userSettings.units })
    .from(userSettings)
    .where(eq(userSettings.userId, userId));
  // requireUser found the user, and its settings row is created with it.
  if (!settings) throw new Error("The signed-in user has no settings row");
  const [active] = await db
    .select({ id: plan.id, paces: plan.paces })
    .from(plan)
    .where(and(eq(plan.userId, userId), eq(plan.status, "active")));

  const custom = and(isNull(planSession.planId), ne(planSession.status, "skipped"));
  const rows = await db
    .select()
    .from(planSession)
    .where(
      and(
        eq(planSession.userId, userId),
        gte(planSession.date, from),
        lte(planSession.date, to),
        active ? or(eq(planSession.planId, active.id), custom) : custom,
      ),
    )
    .orderBy(asc(planSession.date), sql`${planSession.planId} is null`, asc(planSession.id));

  const paces = active?.paces ?? null;
  const days: CalendarDay[] = Array.from({ length: daysBetween(from, to) + 1 }, (_, index) => ({
    date: addDays(from, index),
    sessions: [],
  }));
  for (const row of rows) {
    days[daysBetween(from, row.date)]?.sessions.push(toPlanSession(row, paces, settings.units));
  }
  return { days, paces, garmin: await readPushStatus(userId, now) };
}
