import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, coachMessage, user } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createLongRun, createUser } from "../seed";

// 0004_create_coach_message: what the coach wrote, tied to its user and (for insights) its run.
// 0013_add_coach_fallback_reason: why a card is the fallback, and at most one insight per run.
// 0014_add_request_rejected_fallback_reason: the CHECK takes Claude turning the request down for good.
// 0015_add_coach_credential: and Claude rejecting the plan token on the coach service.

const content = {
  headline: "18.0 km in 1:42:00 at 5:40 /km.",
  whatHappened: "Average heart rate 148 bpm.",
  whatItMeans: "An aerobic long run.",
  nextStep: "Run easy next.",
  caution: "easy_next",
};

describe("coach_message", () => {
  it("stores an insight with its prompt version, model, content and usage", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);

    const [row] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v1",
        model: "claude-opus-5-5",
        content,
        usage: { inputTokens: 1180, outputTokens: 164 },
      })
      .returning();

    expect(row).toMatchObject({
      activityId: run.id,
      content,
      usage: { inputTokens: 1180, outputTokens: 164 },
      feedback: null,
    });
  });

  it("allows a message without a run, model or usage (a fallback card, a weekly review)", async () => {
    const userId = await createUser();

    const [row] = await db
      .insert(coachMessage)
      .values({ userId, kind: "weekly_review", promptVersion: "weekly-review/v1", content })
      .returning();

    expect(row).toMatchObject({ activityId: null, model: null, usage: null });
  });

  it("rejects kinds and feedback outside their lists", async () => {
    const userId = await createUser();
    const base = { userId, promptVersion: "run-insight/v1", content };

    expect(
      await postgresErrorCode(db.insert(coachMessage).values({ ...base, kind: "chat" as never })),
    ).toBe("23514");
    expect(
      await postgresErrorCode(
        db.insert(coachMessage).values({ ...base, kind: "insight", feedback: "meh" as never }),
      ),
    ).toBe("23514");
  });

  it("goes with its run and with its user", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    const values = { userId, kind: "insight" as const, promptVersion: "run-insight/v1", content };
    await db.insert(coachMessage).values({ ...values, activityId: run.id });
    await db.insert(coachMessage).values({ ...values, kind: "weekly_review" });

    await db.delete(activity).where(eq(activity.id, run.id));
    expect(await db.select().from(coachMessage)).toHaveLength(1);

    await db.delete(user).where(eq(user.id, userId));
    expect(await db.select().from(coachMessage)).toHaveLength(0);
  });

  it("stores a fallback card's reason and rejects a reason outside the shared list", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    const base = { userId, kind: "insight" as const, promptVersion: "run-insight/v1", content };

    const [row] = await db
      .insert(coachMessage)
      .values({ ...base, activityId: run.id, fallbackReason: "timeout" })
      .returning();
    expect(row?.fallbackReason).toBe("timeout");

    expect(
      await postgresErrorCode(
        db.insert(coachMessage).values({ ...base, fallbackReason: "busy" as never }),
      ),
    ).toBe("23514");
  });

  it("stores a request_rejected card (Claude turned the request down: no credit, no model access)", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);

    const [row] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v1",
        content,
        fallbackReason: "request_rejected",
      })
      .returning();

    expect(row).toMatchObject({ model: null, fallbackReason: "request_rejected" });
  });

  it("stores a plan_auth_failed card (Claude rejected the plan token on the coach service)", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);

    const [row] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v1",
        content,
        fallbackReason: "plan_auth_failed",
      })
      .returning();

    expect(row).toMatchObject({ model: null, fallbackReason: "plan_auth_failed" });
  });

  it("reads a card written before 0013 as the model's, with no fallback reason", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);

    const [row] = await db
      .insert(coachMessage)
      .values({
        userId,
        kind: "insight",
        activityId: run.id,
        promptVersion: "run-insight/v1",
        content,
      })
      .returning();

    expect(row?.fallbackReason).toBeNull();
  });

  it("refuses a second insight for the same run but allows another kind on it", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    const values = { userId, activityId: run.id, promptVersion: "run-insight/v1", content };
    await db.insert(coachMessage).values({ ...values, kind: "insight" });

    expect(
      await postgresErrorCode(db.insert(coachMessage).values({ ...values, kind: "insight" })),
    ).toBe("23505");
    await db.insert(coachMessage).values({ ...values, kind: "weekly_review" });
    expect(await db.select().from(coachMessage)).toHaveLength(2);
  });

  it("replaces the run's card when an insight is upserted on the run (a double fire makes one card)", async () => {
    const userId = await createUser();
    const run = await createLongRun(userId);
    const upsert = (values: Partial<typeof coachMessage.$inferInsert>) =>
      db
        .insert(coachMessage)
        .values({
          userId,
          kind: "insight",
          activityId: run.id,
          promptVersion: "run-insight/v1",
          content,
          ...values,
        })
        .onConflictDoUpdate({
          target: coachMessage.activityId,
          targetWhere: sql`${coachMessage.kind} = 'insight'`,
          set: {
            content: sql`excluded.content`,
            model: sql`excluded.model`,
            fallbackReason: sql`excluded.fallback_reason`,
          },
        })
        .returning();

    const [first] = await upsert({ fallbackReason: "unavailable" });
    const written = { ...content, headline: "18.0 km long run at 5:40 /km." };
    const [second] = await upsert({ model: "claude-opus-5-5", content: written });

    expect(second?.id).toBe(first?.id);
    expect(second).toMatchObject({
      model: "claude-opus-5-5",
      fallbackReason: null,
      content: written,
    });
    expect(await db.select().from(coachMessage)).toHaveLength(1);
  });
});
