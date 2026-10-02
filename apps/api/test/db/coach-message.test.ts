import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { activity, coachMessage, user } from "../../src/db/schema";
import { postgresErrorCode } from "../helpers";
import { createLongRun, createUser } from "../seed";

// 0004_create_coach_message: what the coach wrote, tied to its user and (for insights) its run.

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
});
