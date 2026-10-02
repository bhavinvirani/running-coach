import { ErrorCode } from "@running-coach/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "../../src/db/client";
import { importProgress, user } from "../../src/db/schema";
import { failImport, getImportProgress, pauseImport } from "../../src/services/history-import";
import { postgresErrorCode } from "../helpers";
import { createUser, seedImport, storedImport } from "../seed";

// 0005_create_import_progress: one row per user for the history import, and the writes that move it.

const AN_HOUR_AGO = new Date(Date.now() - 3600 * 1000);

describe("import_progress", () => {
  it("allows one row per user", async () => {
    const userId = await createUser();
    await seedImport(userId);

    expect(
      await postgresErrorCode(
        db.insert(importProgress).values({ userId, status: "running", startedAt: new Date() }),
      ),
    ).toBe("23505");
  });

  it("rejects the derived statuses not_started and stalled, and anything outside the shared list", async () => {
    const userId = await createUser();
    await seedImport(userId);
    const setStatus = (status: string) =>
      db
        .update(importProgress)
        .set({ status: status as never })
        .where(eq(importProgress.userId, userId));

    expect(await postgresErrorCode(setStatus("not_started"))).toBe("23514");
    expect(await postgresErrorCode(setStatus("stalled"))).toBe("23514");
    expect(await postgresErrorCode(setStatus("importing"))).toBe("23514");
    expect(await postgresErrorCode(setStatus("done"))).toBeUndefined();
  });

  it("is deleted with its user", async () => {
    const userId = await createUser();
    await seedImport(userId);

    await db.delete(user).where(eq(user.id, userId));

    expect(await db.select().from(importProgress)).toHaveLength(0);
  });

  it("reads back as the contract's progress, the cursor date as YYYY-MM-DD", async () => {
    const userId = await createUser();
    const row = await seedImport(userId, {
      status: "failed",
      nextOffset: 95,
      cursorDate: "2024-03-17",
      lastError: ErrorCode.garminUnavailable,
    });

    expect(await getImportProgress(userId)).toEqual({
      status: "failed",
      runsStored: 0,
      oldestDate: "2024-03-17",
      startedAt: row.startedAt.toISOString(),
      finishedAt: null,
      resumeAt: null,
      errorCode: ErrorCode.garminUnavailable,
    });
  });

  it("moves updated_at on a pause and on a failure, which stalled detection reads", async () => {
    const userId = await createUser();
    await seedImport(userId, { updatedAt: AN_HOUR_AGO });

    const resumeAt = await pauseImport(userId, 600);
    const paused = await storedImport(userId);
    await db
      .update(importProgress)
      .set({ updatedAt: AN_HOUR_AGO })
      .where(eq(importProgress.userId, userId));
    await failImport(userId, ErrorCode.garminUnavailable);
    const failed = await storedImport(userId);

    expect(paused).toMatchObject({
      status: "paused",
      resumeAt,
      lastError: ErrorCode.garminRateLimited,
    });
    expect(paused.updatedAt.getTime()).toBeGreaterThan(AN_HOUR_AGO.getTime() + 3000 * 1000);
    expect(failed).toMatchObject({
      status: "failed",
      resumeAt: null,
      lastError: ErrorCode.garminUnavailable,
    });
    expect(failed.updatedAt.getTime()).toBeGreaterThan(AN_HOUR_AGO.getTime() + 3000 * 1000);
  });

  it("never pauses or fails an import that is done", async () => {
    const userId = await createUser();
    await seedImport(userId, { status: "done", finishedAt: new Date() });

    await pauseImport(userId, 600);
    await failImport(userId, ErrorCode.internal);

    expect(await storedImport(userId)).toMatchObject({ status: "done", lastError: null });
  });
});
