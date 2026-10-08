import { randomUUID } from "node:crypto";
import {
  activityResponseSchema,
  activityShoeSchema,
  MIN_SHOE_RETIRE_DISTANCE_M,
  type Shoe,
  shoesResponseSchema,
} from "@running-coach/shared";
import { eq } from "drizzle-orm";
import type request from "supertest";
import { describe, expect, it } from "vitest";
import { type DbTransaction, db } from "../../src/db/client";
import { activity, shoe } from "../../src/db/schema";
import { browserAgent, createTestApp, expectProblem, ownerId, signedInAgent } from "../helpers";
import { createRunOn, createUser } from "../seed";
import {
  activePairs,
  aQueryWaitsForARowLock,
  createPair,
  pairOfRun,
  SHOE_INPUT,
  wearPair,
} from "../seed-shoes";

// /api/shoes and PUT /api/activities/:id/shoe on the real Postgres (Settings > Shoes, slice 52). The pairs
// live in the app only: no route calls Garmin. The sync's side is in test/services/shoe-sync.test.ts.

const app = createTestApp();
const PATH = "/api/shoes";
const pairPath = (id: string) => `${PATH}/${id}`;
const runShoePath = (id: string) => `/api/activities/${id}/shoe`;

type Agent = Awaited<ReturnType<typeof signedInAgent>>;

async function owner() {
  const agent = await signedInAgent(app);
  return { agent, userId: await ownerId() };
}

/** Another runner and one of their pairs, active. */
async function otherRunnersPair() {
  const otherId = await createUser("other@example.com");
  return { otherId, pair: await createPair(otherId, { active: true }) };
}

/** A client without a session cookie. */
function signedOut() {
  return browserAgent(app);
}

async function pairsOf(agent: Agent): Promise<Shoe[]> {
  const response = await agent.get(PATH);
  expect(response.status).toBe(200);
  return shoesResponseSchema.parse(response.body).shoes;
}

function shoesOf(response: { status: number; body: unknown }, status = 200): Shoe[] {
  expect(response.status).toBe(status);
  return shoesResponseSchema.parse(response.body).shoes;
}

/** The pair as the list answers it before any run wears it. */
function unworn(id: string, values: Partial<Shoe> = {}): Shoe {
  return {
    id,
    ...SHOE_INPUT,
    active: false,
    retiredAt: null,
    distanceM: SHOE_INPUT.startDistanceM,
    runs: 0,
    durationS: 0,
    ...values,
  };
}

const ids = (shoes: Shoe[]) => shoes.map((pair) => pair.id);

/**
 * Sends the request now, inside a transaction that holds a row it needs, and answers it once that commits:
 * supertest sends only when awaited.
 */
async function whileHeld(
  hold: (tx: DbTransaction) => Promise<unknown>,
  send: () => PromiseLike<request.Response>,
): Promise<request.Response> {
  let sent: Promise<request.Response> | undefined;
  await db.transaction(async (tx) => {
    await hold(tx);
    sent = Promise.resolve(send());
    sent.catch(() => undefined);
    await aQueryWaitsForARowLock();
  });
  if (!sent) throw new Error("nothing was sent");
  return sent;
}

describe("GET /api/shoes", () => {
  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().get(PATH), 401, "unauthorized");
  });

  it("answers no pairs for a runner without any", async () => {
    const { agent } = await owner();

    const response = await agent.get(PATH);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(shoesResponseSchema.parse(response.body)).toEqual({ shoes: [] });
  });

  it("sums the start distance and the pair's runs, with their count and time; an indoor run counts (totals, indoor run)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { startDistanceM: 120_000 });
    const other = await createPair(userId);
    const outdoor = await createRunOn(userId, "2026-09-20", { distanceM: 10_000, durationS: 3000 });
    const treadmill = await createRunOn(userId, "2026-09-24", {
      type: "treadmill_running",
      isIndoor: true,
      distanceM: 8000.5,
      durationS: 2700,
    });
    const onOther = await createRunOn(userId, "2026-09-25", { distanceM: 7000, durationS: 2100 });
    // Without a pair: counts for none.
    await createRunOn(userId, "2026-09-26", { distanceM: 5000, durationS: 1500 });
    await wearPair(outdoor.id, pair.id);
    await wearPair(treadmill.id, pair.id);
    await wearPair(onOther.id, other.id);

    const shoes = await pairsOf(agent);

    expect(shoes.find((row) => row.id === pair.id)).toEqual(
      unworn(pair.id, {
        startDistanceM: 120_000,
        distanceM: 138_000.5,
        runs: 2,
        durationS: 5700,
      }),
    );
    expect(shoes.find((row) => row.id === other.id)).toMatchObject({
      distanceM: 7000,
      runs: 1,
      durationS: 2100,
    });
  });

  it("lists the active pair first, then the pairs in use newest first, then the retired ones latest retired first (order)", async () => {
    const { agent, userId } = await owner();
    const retiredEarly = await createPair(userId, {
      createdAt: new Date("2026-04-01T00:00:00Z"),
      retiredAt: new Date("2026-05-01T00:00:00Z"),
    });
    const oldInUse = await createPair(userId, { createdAt: new Date("2026-01-01T00:00:00Z") });
    const active = await createPair(userId, {
      active: true,
      createdAt: new Date("2025-12-01T00:00:00Z"),
    });
    const retiredLate = await createPair(userId, {
      createdAt: new Date("2025-06-01T00:00:00Z"),
      retiredAt: new Date("2026-06-01T00:00:00Z"),
    });
    const newInUse = await createPair(userId, { createdAt: new Date("2026-03-01T00:00:00Z") });

    const shoes = await pairsOf(agent);

    expect(ids(shoes)).toEqual([
      active.id,
      newInUse.id,
      oldInUse.id,
      retiredLate.id,
      retiredEarly.id,
    ]);
    expect(shoes[3]?.retiredAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("answers the runner's own pairs only", async () => {
    const { agent, userId } = await owner();
    await otherRunnersPair();
    const mine = await createPair(userId);

    expect(ids(await pairsOf(agent))).toEqual([mine.id]);
  });
});

describe("POST /api/shoes", () => {
  it("returns 401 without a session", async () => {
    expectProblem(
      await signedOut()
        .post(PATH)
        .send({ ...SHOE_INPUT, active: false }),
      401,
      "unauthorized",
    );
  });

  it("adds a pair that is not active, with its start distance (create without active)", async () => {
    const { agent } = await owner();
    const body = {
      ...SHOE_INPUT,
      colour: "Blue",
      nickname: "Daily",
      startDistanceM: 42_000,
      active: false,
    };

    const shoes = shoesOf(await agent.post(PATH).send(body), 201);

    expect(shoes).toHaveLength(1);
    expect(shoes[0]).toEqual(
      unworn(shoes[0]!.id, {
        colour: "Blue",
        nickname: "Daily",
        startDistanceM: 42_000,
        distanceM: 42_000,
      }),
    );
  });

  it("trims the text it is given and keeps a null nickname", async () => {
    const { agent } = await owner();

    const [pair] = shoesOf(
      await agent
        .post(PATH)
        .send({ ...SHOE_INPUT, brand: "  Acme ", nickname: null, active: false }),
      201,
    );

    expect(pair).toMatchObject({ brand: "Acme", nickname: null });
  });

  it("adds the active pair, and a second active pair takes over (create with active)", async () => {
    const { agent } = await owner();
    const [first] = shoesOf(await agent.post(PATH).send({ ...SHOE_INPUT, active: true }), 201);
    expect(first?.active).toBe(true);

    const shoes = shoesOf(
      await agent.post(PATH).send({ ...SHOE_INPUT, model: "Tempo 2", active: true }),
      201,
    );

    expect(shoes.map(({ model, active }) => ({ model, active }))).toEqual([
      { model: "Tempo 2", active: true },
      { model: "Glide 3", active: false },
    ]);
  });

  it("keeps the active pair when the new one is not active", async () => {
    const { agent, userId } = await owner();
    const active = await createPair(userId, { active: true });

    const shoes = shoesOf(await agent.post(PATH).send({ ...SHOE_INPUT, active: false }), 201);

    expect(shoes.filter((row) => row.active).map((row) => row.id)).toEqual([active.id]);
  });

  it("leaves one active pair when creates with active race (parallel creates)", async () => {
    const { agent, userId } = await owner();

    const responses = await Promise.all(
      ["One", "Two", "Three"].map((model) =>
        agent.post(PATH).send({ ...SHOE_INPUT, model, active: true }),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(await activePairs(userId)).toHaveLength(1);
    expect(await pairsOf(agent)).toHaveLength(3);
  });

  it.each([
    ["without a brand", { brand: undefined }],
    ["with a blank model", { model: "   " }],
    ["with a blank colour", { colour: "  " }],
    ["with a name over 40 characters", { nickname: "x".repeat(41) }],
    ["with a retire goal under 50 km", { retireDistanceM: MIN_SHOE_RETIRE_DISTANCE_M - 1 }],
    ["with a negative start distance", { startDistanceM: -1 }],
    ["with a distance that is not whole meters", { retireDistanceM: 650_000.5 }],
    ["without active", { active: undefined }],
    ["with a field the contract lacks", { garminGearId: "1" }],
  ])(
    "rejects a body %s with 400 validation and stores nothing (invalid body)",
    async (_, change) => {
      const { agent } = await owner();

      expectProblem(
        await agent.post(PATH).send({ ...SHOE_INPUT, active: false, ...change }),
        400,
        "validation",
      );
      expect(await db.select().from(shoe)).toEqual([]);
    },
  );
});

describe("PUT /api/shoes/:id", () => {
  it("returns 401 without a session", async () => {
    expectProblem(
      await signedOut().put(pairPath(randomUUID())).send(SHOE_INPUT),
      401,
      "unauthorized",
    );
  });

  it("changes the pair's details and keeps it active and its runs (edit)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { active: true });
    const run = await createRunOn(userId, "2026-09-27", { distanceM: 10_000, durationS: 3000 });
    await wearPair(run.id, pair.id);
    const input = {
      brand: "Acme",
      model: "Glide 4",
      colour: "Lime",
      nickname: "Race day",
      retireDistanceM: 800_000,
      startDistanceM: 50_000,
    };

    const shoes = shoesOf(await agent.put(pairPath(pair.id)).send(input));

    expect(shoes).toEqual([
      {
        id: pair.id,
        ...input,
        active: true,
        retiredAt: null,
        distanceM: 60_000,
        runs: 1,
        durationS: 3000,
      },
    ]);
  });

  it("keeps a retired pair retired", async () => {
    const { agent, userId } = await owner();
    const retiredAt = new Date("2026-06-01T00:00:00Z");
    const pair = await createPair(userId, { retiredAt });

    const [edited] = shoesOf(
      await agent.put(pairPath(pair.id)).send({ ...SHOE_INPUT, nickname: "Old" }),
    );

    expect(edited).toMatchObject({
      nickname: "Old",
      active: false,
      retiredAt: retiredAt.toISOString(),
    });
  });

  it("answers 404 for another runner's pair and leaves it unchanged (another user's pair)", async () => {
    const { agent } = await owner();
    const { pair } = await otherRunnersPair();

    const problem = expectProblem(
      await agent.put(pairPath(pair.id)).send({ ...SHOE_INPUT, model: "Mine now" }),
      404,
      "not_found",
    );

    expect(problem.detail).toBe("That pair does not exist.");
    const [stored] = await db.select().from(shoe).where(eq(shoe.id, pair.id));
    expect(stored?.model).toBe(SHOE_INPUT.model);
  });

  it("answers 404 for a pair that does not exist", async () => {
    const { agent } = await owner();

    expectProblem(await agent.put(pairPath(randomUUID())).send(SHOE_INPUT), 404, "not_found");
  });

  it("rejects a malformed id with 400 validation (malformed uuid)", async () => {
    const { agent } = await owner();

    expectProblem(await agent.put(pairPath("not-a-uuid")).send(SHOE_INPUT), 400, "validation");
  });

  it("rejects active or retired in the body with 400 validation: details only (invalid body)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId);

    expectProblem(
      await agent.put(pairPath(pair.id)).send({ ...SHOE_INPUT, active: true }),
      400,
      "validation",
    );
    expect(await activePairs(userId)).toEqual([]);
  });
});

describe("DELETE /api/shoes/:id", () => {
  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().delete(pairPath(randomUUID())), 401, "unauthorized");
  });

  it("deletes the pair; its runs stay and lose their pair (delete keeps runs)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { active: true });
    const kept = await createPair(userId);
    const run = await createRunOn(userId, "2026-09-27");
    await wearPair(run.id, pair.id);

    const shoes = shoesOf(await agent.delete(pairPath(pair.id)));

    expect(ids(shoes)).toEqual([kept.id]);
    expect(await pairOfRun(run.id)).toBeNull();
    const response = await agent.get(`/api/activities/${run.id}`);
    expect(activityResponseSchema.parse(response.body).shoeId).toBeNull();
  });

  it("answers 404 for another runner's pair and keeps it (another user's pair)", async () => {
    const { agent } = await owner();
    const { pair } = await otherRunnersPair();

    expectProblem(await agent.delete(pairPath(pair.id)), 404, "not_found");
    expect(await db.select().from(shoe).where(eq(shoe.id, pair.id))).toHaveLength(1);
  });

  it("rejects a malformed id with 400 validation (malformed uuid)", async () => {
    const { agent } = await owner();

    expectProblem(await agent.delete(pairPath("12345")), 400, "validation");
  });
});

describe("POST /api/shoes/:id/active", () => {
  const activePath = (id: string) => `${pairPath(id)}/active`;

  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().post(activePath(randomUUID())), 401, "unauthorized");
  });

  it("makes the pair active, and the last active pair stops being active", async () => {
    const { agent, userId } = await owner();
    const previous = await createPair(userId, { active: true });
    const next = await createPair(userId);

    const shoes = shoesOf(await agent.post(activePath(next.id)));

    expect(shoes.map(({ id, active }) => ({ id, active }))).toEqual([
      { id: next.id, active: true },
      { id: previous.id, active: false },
    ]);
  });

  it("brings a retired pair back in use (activate a retired pair)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { retiredAt: new Date("2026-06-01T00:00:00Z") });

    const [back] = shoesOf(await agent.post(activePath(pair.id)));

    expect(back).toMatchObject({ id: pair.id, active: true, retiredAt: null });
  });

  it("changes nothing when the pair is already active (idempotent)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { active: true });
    await createPair(userId);
    const before = await pairsOf(agent);

    const first = shoesOf(await agent.post(activePath(pair.id)));
    const second = shoesOf(await agent.post(activePath(pair.id)));

    expect(first).toEqual(before);
    expect(second).toEqual(before);
  });

  it("answers 404 for another runner's pair and changes neither runner's active pair (another user's pair)", async () => {
    const { agent, userId } = await owner();
    const mine = await createPair(userId, { active: true });
    const { otherId, pair } = await otherRunnersPair();
    await db.update(shoe).set({ active: false }).where(eq(shoe.id, pair.id));

    expectProblem(await agent.post(activePath(pair.id)), 404, "not_found");

    expect(await activePairs(userId)).toEqual([mine.id]);
    expect(await activePairs(otherId)).toEqual([]);
  });

  it("rejects a malformed id with 400 validation (malformed uuid)", async () => {
    const { agent } = await owner();

    expectProblem(await agent.post(activePath("not-a-uuid")), 400, "validation");
  });

  it("answers 404 and keeps the active pair when the pair's delete commits during the activation (delete during activate)", async () => {
    const { agent, userId } = await owner();
    const active = await createPair(userId, { active: true });
    const deleted = await createPair(userId);

    const response = await whileHeld(
      (tx) => tx.delete(shoe).where(eq(shoe.id, deleted.id)),
      () => agent.post(activePath(deleted.id)),
    );

    expectProblem(response, 404, "not_found");
    expect(await activePairs(userId)).toEqual([active.id]);
  });

  it("leaves exactly one active pair when activations of different pairs race (parallel activations)", async () => {
    const { agent, userId } = await owner();
    const pairs = await Promise.all([
      createPair(userId, { active: true }),
      createPair(userId),
      createPair(userId, { retiredAt: new Date("2026-06-01T00:00:00Z") }),
    ]);

    for (let round = 0; round < 5; round += 1) {
      const responses = await Promise.all(pairs.map((pair) => agent.post(activePath(pair.id))));

      expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
      expect(await activePairs(userId)).toHaveLength(1);
    }
  });
});

describe("POST /api/shoes/:id/retire", () => {
  const retirePath = (id: string) => `${pairPath(id)}/retire`;

  it("returns 401 without a session", async () => {
    expectProblem(await signedOut().post(retirePath(randomUUID())), 401, "unauthorized");
  });

  it("retires the pair, which stops being active, and retiring it again keeps the first retiredAt (retire)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { active: true });
    const run = await createRunOn(userId, "2026-09-27", { distanceM: 10_000 });
    await wearPair(run.id, pair.id);

    const [retired] = shoesOf(await agent.post(retirePath(pair.id)));
    const [again] = shoesOf(await agent.post(retirePath(pair.id)));

    expect(retired).toMatchObject({ id: pair.id, active: false, distanceM: 10_000, runs: 1 });
    expect(retired?.retiredAt).not.toBeNull();
    expect(again?.retiredAt).toBe(retired?.retiredAt);
    expect(await activePairs(userId)).toEqual([]);
    // The run keeps the pair it wore.
    expect(await pairOfRun(run.id)).toBe(pair.id);
  });

  it("answers 404 for another runner's pair and leaves it active (another user's pair)", async () => {
    const { agent } = await owner();
    const { otherId, pair } = await otherRunnersPair();

    expectProblem(await agent.post(retirePath(pair.id)), 404, "not_found");
    expect(await activePairs(otherId)).toEqual([pair.id]);
  });

  it("rejects a malformed id with 400 validation (malformed uuid)", async () => {
    const { agent } = await owner();

    expectProblem(await agent.post(retirePath("not-a-uuid")), 400, "validation");
  });
});

describe("PUT /api/activities/:id/shoe", () => {
  async function shoeIdOf(agent: Agent, activityId: string): Promise<string | null> {
    const response = await agent.get(`/api/activities/${activityId}`);
    expect(response.status).toBe(200);
    return activityResponseSchema.parse(response.body).shoeId;
  }

  it("returns 401 without a session", async () => {
    expectProblem(
      await signedOut().put(runShoePath(randomUUID())).send({ shoeId: null }),
      401,
      "unauthorized",
    );
  });

  it("puts the pair on the run, which GET /api/activities/:id then names and the pair counts (set)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId);
    const run = await createRunOn(userId, "2026-09-27", { distanceM: 10_000, durationS: 3000 });
    expect(await shoeIdOf(agent, run.id)).toBeNull();

    const response = await agent.put(runShoePath(run.id)).send({ shoeId: pair.id });

    expect(response.status).toBe(200);
    expect(activityShoeSchema.parse(response.body)).toEqual({ shoeId: pair.id });
    expect(await shoeIdOf(agent, run.id)).toBe(pair.id);
    expect((await pairsOf(agent))[0]).toMatchObject({
      distanceM: 10_000,
      runs: 1,
      durationS: 3000,
    });
  });

  it("changes the run's pair to another one", async () => {
    const { agent, userId } = await owner();
    const [first, second] = [await createPair(userId), await createPair(userId)];
    const run = await createRunOn(userId, "2026-09-27");
    await wearPair(run.id, first.id);

    await agent.put(runShoePath(run.id)).send({ shoeId: second.id });

    expect(await pairOfRun(run.id)).toBe(second.id);
  });

  it("clears the run's pair with null (clear)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { active: true });
    const run = await createRunOn(userId, "2026-09-27");
    await wearPair(run.id, pair.id);

    const response = await agent.put(runShoePath(run.id)).send({ shoeId: null });

    expect(activityShoeSchema.parse(response.body)).toEqual({ shoeId: null });
    expect(await shoeIdOf(agent, run.id)).toBeNull();
  });

  it("accepts a retired pair, since an old run may have worn it (retired pair)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId, { retiredAt: new Date("2026-06-01T00:00:00Z") });
    const run = await createRunOn(userId, "2026-05-20");

    const response = await agent.put(runShoePath(run.id)).send({ shoeId: pair.id });

    expect(response.status).toBe(200);
    expect(await pairOfRun(run.id)).toBe(pair.id);
  });

  it("answers 404 for another runner's pair and keeps the run's pair (another user's pair)", async () => {
    const { agent, userId } = await owner();
    const mine = await createPair(userId);
    const run = await createRunOn(userId, "2026-09-27");
    await wearPair(run.id, mine.id);
    const { pair } = await otherRunnersPair();

    const problem = expectProblem(
      await agent.put(runShoePath(run.id)).send({ shoeId: pair.id }),
      404,
      "not_found",
    );

    expect(problem.detail).toBe("That pair does not exist.");
    expect(await pairOfRun(run.id)).toBe(mine.id);
  });

  it("answers 404 for another runner's run and leaves it alone (another user's run)", async () => {
    const { agent, userId } = await owner();
    const mine = await createPair(userId);
    const { otherId } = await otherRunnersPair();
    const theirs = await createRunOn(otherId, "2026-09-27");

    const problem = expectProblem(
      await agent.put(runShoePath(theirs.id)).send({ shoeId: mine.id }),
      404,
      "not_found",
    );

    expect(problem.detail).toBe("That run does not exist.");
    expect(await pairOfRun(theirs.id)).toBeNull();
  });

  it("answers 404 when a sync removes the run while its pair is set (run removed meanwhile)", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId);
    const run = await createRunOn(userId, "2026-09-27");

    const response = await whileHeld(
      (tx) => tx.delete(activity).where(eq(activity.id, run.id)),
      () => agent.put(runShoePath(run.id)).send({ shoeId: pair.id }),
    );

    expect(expectProblem(response, 404, "not_found").detail).toBe("That run does not exist.");
  });

  it("keeps the run's last-sync time, which records Garmin's changes", async () => {
    const { agent, userId } = await owner();
    const pair = await createPair(userId);
    const run = await createRunOn(userId, "2026-09-27");

    await agent.put(runShoePath(run.id)).send({ shoeId: pair.id });

    const [stored] = await db
      .select({ updatedAt: activity.updatedAt })
      .from(activity)
      .where(eq(activity.id, run.id));
    expect(stored?.updatedAt).toEqual(run.updatedAt);
  });

  it.each([
    ["without shoeId", {}],
    ["with a malformed shoeId", { shoeId: "not-a-uuid" }],
    ["with a field the contract lacks", { shoeId: null, active: true }],
  ])("rejects a body %s with 400 validation (invalid body)", async (_, body) => {
    const { agent, userId } = await owner();
    const run = await createRunOn(userId, "2026-09-27");

    expectProblem(await agent.put(runShoePath(run.id)).send(body), 400, "validation");
  });

  it("rejects a malformed run id with 400 validation (malformed uuid)", async () => {
    const { agent } = await owner();

    expectProblem(await agent.put(runShoePath("latest")).send({ shoeId: null }), 400, "validation");
  });
});
