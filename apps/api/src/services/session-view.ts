import type { PlanPaces, PlanSession, Units } from "@running-coach/shared";
import type { PlanSessionRow } from "../db/schema";
import { isOnGarmin } from "./workout-push-plan";

// A session row as every response carries it (GET /api/plan, /api/calendar, /api/sessions/:id).

/**
 * `paces` are the ones the session's zones read: its plan's, or the active plan's for a custom workout
 * (null without one). onGarmin compares the stored Garmin state with the workout the session makes now.
 */
export function toPlanSession(
  row: PlanSessionRow,
  paces: PlanPaces | null,
  units: Units,
): PlanSession {
  return {
    id: row.id,
    date: row.date,
    type: row.type,
    target: row.target,
    steps: row.steps,
    status: row.status,
    source: row.planId === null ? "custom" : "plan",
    title: row.title,
    activityId: row.activityId,
    // filled in by slice 9's adaptation service
    adjustment: null,
    // filled in by slice 9's adaptation service
    paused: false,
    onGarmin: isOnGarmin(row, paces, units),
  };
}
