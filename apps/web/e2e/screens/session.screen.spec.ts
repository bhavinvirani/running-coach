import { planResponseSchema } from "@running-coach/shared";
import { sessionCopy } from "../../src/screens/session/session-copy";
import { expect, test } from "../fixtures/login";
import { fitViewportToPage } from "../fixtures/screens";
import { planWeekTwoAt, seedPlan, seedPushedGarmin, seedSessionsOnGarmin } from "../fixtures/seed";
import { skipSyncOnOpen } from "../fixtures/sync";

/** Week 2's intervals session, Wed 14 Oct 2026: today on the pinned clock, so it can still move. */
const INTERVALS_DAY = "2026-10-14";

test("session shows week 2's intervals session on Garmin, its steps and what can change", async ({
  page,
}) => {
  await seedPlan();
  await seedSessionsOnGarmin([INTERVALS_DAY]);
  // Straight into the database, so no push runs: the API pushes the server's real week, which would move
  // the seeded ids.
  await seedPushedGarmin({ pushedAt: "2026-10-14T05:00:00Z", others: [] });
  await page.clock.setFixedTime(planWeekTwoAt);
  await skipSyncOnOpen(page);
  const { plan } = planResponseSchema.parse(await (await page.request.get("/api/plan")).json());
  const session = plan?.weeks
    .flatMap((week) => week.sessions)
    .find((candidate) => candidate.date === INTERVALS_DAY && candidate.type === "intervals");
  if (!session) throw new Error(`The seeded plan has no intervals session on ${INTERVALS_DAY}`);

  await page.goto(`/plan/sessions/${session.id}`);
  await expect(page.getByRole("heading", { name: "Wed 14 Oct", level: 1 })).toBeVisible();
  await expect(
    page.getByRole("region", { name: sessionCopy.steps, exact: true }).getByText("2 x"),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: sessionCopy.garmin, exact: true }).getByText("On Garmin"),
  ).toBeVisible();
  // The last row on the screen: once it shows, the session and every section above it have rendered.
  await expect(page.getByRole("button", { name: sessionCopy.skip, exact: true })).toBeVisible();

  await fitViewportToPage(page);
  // No mask: the day, the steps and their paces are the seed's, and the clock is pinned.
  await expect(page).toHaveScreenshot("session.png", { fullPage: true });
});
