import { z } from "zod";

/**
 * Why the runner paused training ("Not feeling 100%"). sick and injured get rest advice and a pointer to a
 * doctor or physio, and a walk-run first week back; break is time off without either.
 */
export const pauseReasonSchema = z.enum(["sick", "injured", "break"]);
export type PauseReason = z.infer<typeof pauseReasonSchema>;

/** The runner's open pause: sessions from its start date leave the watch until it ends. */
export const trainingPauseSchema = z
  .object({
    id: z.uuid(),
    reason: pauseReasonSchema,
    /** The local date it started: the day the runner paused. */
    startDate: z.iso.date(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type TrainingPause = z.infer<typeof trainingPauseSchema>;

/** POST /api/pause: start one today. With a pause already open it answers that one unchanged. */
export const startPauseRequestSchema = z.object({ reason: pauseReasonSchema }).strict();
export type StartPauseRequest = z.infer<typeof startPauseRequestSchema>;

/** GET /api/pause and POST /api/pause: the open pause, null when training runs. */
export const pauseResponseSchema = z.object({ pause: trainingPauseSchema.nullable() }).strict();
export type PauseResponse = z.infer<typeof pauseResponseSchema>;

/** How the plan eases the return, from the engine's re-entry rules. */
export const reEntrySchema = z
  .object({
    /** Days from the last run to the first day back. */
    daysOff: z.number().int().nonnegative(),
    /**
     * The share of the plan the first week back runs at: 1, 0.7 after 7 days off, 0.5 after 14, divided
     * by what a plan built during the break already carries (0.5 over a plan built at 0.7 is about 0.71).
     */
    factor: z.number().positive().max(1),
    /** The first week back is walk-run, after illness or injury. */
    walkRun: z.boolean(),
    /** The first day back, a local date. */
    fromDate: z.iso.date(),
    /** Sessions the re-entry changed; 0 after a short break taken while well. */
    sessionsChanged: z.number().int().nonnegative(),
  })
  .strict();
export type ReEntry = z.infer<typeof reEntrySchema>;

/**
 * POST /api/pause/end ("I'm back"): sessions left in the pause are skipped and the rest are eased. reEntry
 * is null when no pause was open, so a second tap changes nothing.
 */
export const endPauseResponseSchema = z
  .object({ pause: z.null(), reEntry: reEntrySchema.nullable() })
  .strict();
export type EndPauseResponse = z.infer<typeof endPauseResponseSchema>;
