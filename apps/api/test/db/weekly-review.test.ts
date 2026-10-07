import { and, asc, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { coachMessage, planAdjustment } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createLongRun, createPlan, createSession, createUser } from "../seed";
import { createAdjustment } from "../seed-adaptation";
import { createReview } from "../seed-weekly-review";

// 0017_add_weekly_review: coach_message.week_start names the Monday a weekly review covers, set exactly
// for weekly reviews, with at most one per runner and week; plan_adjustment takes the source review, with
// one row per session per review. Expand only: a nullable column, two partial indexes, a wider CHECK.

const content = { card: { headline: "Week of 28 September: 3 of 4 sessions done." } };

async function indexesOf(table: string): Promise<string[]> {
  const result = await db.execute<{ indexname: string }>(
    sql`select indexname from pg_indexes where tablename = ${table} order by indexname`,
  );
  return result.rows.map((row) => row.indexname);
}

describe("0017 coach_message.week_start", () => {
  it("adds the one-review-per-week index beside the existing ones", async () => {
    expect(await indexesOf("coach_message")).toContain(
      "coach_message_weekly_review_week_start_idx",
    );
    expect(await indexesOf("plan_adjustment")).toContain(
      "plan_adjustment_review_message_session_idx",
    );
  });

  it("stores a weekly review with the Monday of its week and reads it by runner and week", async () => {
    const userId = await createUser();
    await createReview(userId, { weekStart: "2026-09-28" });

    const [row] = await db
      .select()
      .from(coachMessage)
      .where(and(eq(coachMessage.userId, userId), eq(coachMessage.weekStart, "2026-09-28")));

    expect(row).toMatchObject({ kind: "weekly_review", weekStart: "2026-09-28", activityId: null });
  });

  it("requires week_start exactly for weekly reviews: none on an insight, always on a review", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    const base = { userId, promptVersion: "run-insight/v2", content };

    expect(
      await postgresErrorCode(
        db
          .insert(coachMessage)
          .values({ ...base, kind: "insight", activityId: run.id, weekStart: "2026-09-28" }),
      ),
    ).toBe("23514");
    expect(
      await postgresErrorCode(db.insert(coachMessage).values({ ...base, kind: "weekly_review" })),
    ).toBe("23514");
  });

  it("keeps one review per runner and week (a job firing twice), while other weeks and runners get theirs", async () => {
    const userId = await createUser();
    const other = await createUser("other@example.com");
    await createReview(userId, { weekStart: "2026-09-28" });

    expect(await postgresErrorCode(createReview(userId, { weekStart: "2026-09-28" }))).toBe(
      "23505",
    );
    await createReview(userId, { weekStart: "2026-10-05" });
    await createReview(other, { weekStart: "2026-09-28" });
    expect(await db.select().from(coachMessage)).toHaveLength(3);
  });

  it("upserts a review on runner and week, replacing only a fallback card (the job's write path)", async () => {
    const userId = await createUser();
    const upsert = (model: string | null, headline: string) =>
      db
        .insert(coachMessage)
        .values({
          userId,
          kind: "weekly_review",
          weekStart: "2026-09-28",
          promptVersion: "weekly-review/v1",
          model,
          content: { card: { headline } },
        })
        .onConflictDoUpdate({
          target: [coachMessage.userId, coachMessage.weekStart],
          targetWhere: sql`${coachMessage.kind} = 'weekly_review'`,
          set: { model: sql`excluded.model`, content: sql`excluded.content` },
          setWhere: sql`${sql.identifier("coach_message")}.${sql.identifier("model")} is null`,
        })
        .returning({ id: coachMessage.id });

    const [fallback] = await upsert(null, "Fallback");
    const [written] = await upsert("claude-opus-5-5", "Written");
    const kept = await upsert("claude-opus-5-5", "Second");

    expect(written?.id).toBe(fallback?.id);
    expect(kept).toEqual([]);
    const rows = await db.select().from(coachMessage);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.content).toEqual({ card: { headline: "Written" } });
  });

  it("reads a message written before 0017 (an insight) with no week", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    await db.execute(
      sql`insert into coach_message (user_id, kind, activity_id, prompt_version, content)
          values (${userId}, 'insight', ${run.id}, 'run-insight/v1', '{}'::jsonb)`,
    );

    const [row] = await db.select().from(coachMessage);
    expect(row).toMatchObject({ kind: "insight", weekStart: null });
  });
});

describe("0017 plan_adjustment source review", () => {
  it("stores a review change against its review and session", async () => {
    const userId = await createUser();
    const active = await createPlan(userId);
    const session = await createSession(userId, active.id, { date: "2026-10-13" });
    const review = await createReview(userId, { weekStart: "2026-10-05" });

    const row = await createAdjustment(userId, session, {
      source: "review",
      coachMessageId: review.id,
    });

    expect(row).toMatchObject({ source: "review", coachMessageId: review.id, activityId: null });
  });

  it("keeps one review row per session per review (the review job retrying), while rejected ones without a session repeat", async () => {
    const userId = await createUser();
    const active = await createPlan(userId);
    const session = await createSession(userId, active.id, { date: "2026-10-13" });
    const review = await createReview(userId, { weekStart: "2026-10-05" });
    const next = await createReview(userId, { weekStart: "2026-10-12" });
    const values = { source: "review" as const, coachMessageId: review.id };
    await createAdjustment(userId, session, values);

    expect(await postgresErrorCode(createAdjustment(userId, session, values))).toBe("23505");
    // The next week's review, and the run coach, may each log for the session too.
    await createAdjustment(userId, session, { ...values, coachMessageId: next.id });
    await createAdjustment(userId, session, { coachMessageId: review.id });
    const noSession = {
      ...values,
      outcome: "rejected" as const,
      reason: "no_session" as const,
      applied: null,
    };
    await createAdjustment(userId, null, noSession);
    await createAdjustment(userId, null, noSession);
    const rows = await db
      .select()
      .from(planAdjustment)
      .where(eq(planAdjustment.userId, userId))
      .orderBy(asc(planAdjustment.createdAt));
    expect(rows.map((row) => row.source)).toEqual([
      "review",
      "review",
      "coach",
      "review",
      "review",
    ]);
  });

  it("rejects a source outside the shared list", async () => {
    const userId = await createUser();
    expect(
      await postgresErrorCode(createAdjustment(userId, null, { source: "chat" as never })),
    ).toBe("23514");
  });
});
