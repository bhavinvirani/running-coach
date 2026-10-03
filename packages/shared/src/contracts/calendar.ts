import { z } from "zod";
import { errorCodeSchema } from "../error-codes";
import { garminCalendarEntrySchema } from "./garmin";
import { garminStatusSchema } from "./me";
import { planPacesSchema, planSessionSchema } from "./plan";

/** How many days ahead the push keeps on Garmin: today and the next six, in the runner's time zone. */
export const PUSH_WINDOW_DAYS = 7;

/** The longest range GET /api/calendar answers: six weeks. */
export const CALENDAR_MAX_DAYS = 42;

/** A workout on the runner's Garmin calendar in the push window that the app did not create. */
export const otherGarminWorkoutSchema = garminCalendarEntrySchema
  .pick({ scheduleId: true, date: true, title: true })
  .strict();
export type OtherGarminWorkout = z.infer<typeof otherGarminWorkoutSchema>;

/**
 * Where sending workouts to Garmin stands for the runner. Nothing is sent while the login is not "ok";
 * the web app shows Reconnect Garmin or Connect Garmin instead.
 */
export const garminPushStatusSchema = z
  .object({
    connection: garminStatusSchema,
    /** A push is queued or running. */
    pushing: z.boolean(),
    /** When the last push finished every change it had, null before the first. */
    pushedAt: z.iso.datetime().nullable(),
    /** Why the last push stopped short (garmin_unavailable, garmin_rate_limited, ...), null when it finished. */
    error: errorCodeSchema.nullable(),
    /** From the last push that read the calendar; empty before the first. */
    others: z.array(otherGarminWorkoutSchema),
  })
  .strict();
export type GarminPushStatus = z.infer<typeof garminPushStatusSchema>;

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** GET /api/calendar?from&to: local dates, both included. */
export const calendarQuerySchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .strict()
  .refine(({ from, to }) => daysBetween(from, to) >= 0, "to cannot be before from")
  .refine(
    ({ from, to }) => daysBetween(from, to) < CALENDAR_MAX_DAYS,
    `At most ${CALENDAR_MAX_DAYS} days`,
  );
export type CalendarQuery = z.infer<typeof calendarQuerySchema>;

export const calendarDaySchema = z
  .object({
    date: z.iso.date(),
    /** The active plan's sessions and the runner's custom workouts that day; skipped custom ones left out. */
    sessions: z.array(planSessionSchema),
  })
  .strict();
export type CalendarDay = z.infer<typeof calendarDaySchema>;

export const calendarResponseSchema = z
  .object({
    /** One entry per date from `from` to `to`, in order, a day without sessions included. */
    days: z.array(calendarDaySchema),
    /** The active plan's paces, null without a plan (custom workouts need one). */
    paces: planPacesSchema.nullable(),
    garmin: garminPushStatusSchema,
  })
  .strict();
export type CalendarResponse = z.infer<typeof calendarResponseSchema>;

/** POST /api/calendar/push and POST /api/calendar/unschedule answer the push status. */
export const garminPushResponseSchema = z.object({ garmin: garminPushStatusSchema }).strict();
export type GarminPushResponse = z.infer<typeof garminPushResponseSchema>;

/** POST /api/calendar/unschedule: workouts from `others` to take off the Garmin calendar. */
export const unscheduleGarminRequestSchema = z
  .object({
    scheduleIds: z.array(otherGarminWorkoutSchema.shape.scheduleId).min(1).max(20),
  })
  .strict();
export type UnscheduleGarminRequest = z.infer<typeof unscheduleGarminRequestSchema>;
