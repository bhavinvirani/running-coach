import {
  activityResponseSchema,
  activityWeeksResponseSchema,
  calendarResponseSchema,
  garminPushResponseSchema,
  importProgressSchema,
  insightResponseSchema,
  latestActivityResponseSchema,
  meResponseSchema,
  moveSessionResponseSchema,
  personalBestsResponseSchema,
  planResponseSchema,
  problemSchema,
  saveGoalResponseSchema,
  sessionDetailResponseSchema,
  signInResponseSchema,
  signOutResponseSchema,
  syncResponseSchema,
} from "@running-coach/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  activityDetailFixture,
  activityFixture,
  activityResponseFixture,
  calendarFixture,
  customSessionFixture,
  fallbackCardFixture,
  garminPushStatusFixture,
  goalFixture,
  importProgressFixture,
  insightReadyFixture,
  meFixture,
  personalBestFixture,
  personalBestsFixture,
  planFixture,
  planResponseFixture,
  runBestEffortFixture,
  sessionDetailFixture,
  signInFixture,
  weekFixture,
} from "@/test/fixtures";
import { parseResponse } from "./parse-response";

type Json = Record<PropertyKey, unknown>;

/** Every body the web app reads (each schema it passes to apiFetch, and problem+json), with rich data. */
const bodies: [name: string, schema: z.ZodType, body: unknown][] = [
  ["me", meResponseSchema, meFixture()],
  ["latest run", latestActivityResponseSchema, { activity: activityFixture() }],
  ["no latest run", latestActivityResponseSchema, { activity: null }],
  [
    "run",
    activityResponseSchema,
    activityResponseFixture({
      detail: activityDetailFixture(),
      bestEfforts: [runBestEffortFixture()],
    }),
  ],
  [
    "weeks",
    activityWeeksResponseSchema,
    { weeks: [weekFixture("2026-09-21", [activityFixture()])], nextBefore: null },
  ],
  [
    "calendar",
    calendarResponseSchema,
    calendarFixture("2026-10-05", { extra: [customSessionFixture()] }),
  ],
  ["Garmin push", garminPushResponseSchema, { garmin: garminPushStatusFixture() }],
  ["import", importProgressSchema, importProgressFixture()],
  ["insight", insightResponseSchema, insightReadyFixture()],
  ["fallback insight", insightResponseSchema, insightReadyFixture(fallbackCardFixture())],
  [
    "moved session",
    moveSessionResponseSchema,
    {
      ...sessionDetailFixture(),
      warning: { code: "hard_days_close", otherType: "intervals", otherDate: "2026-10-09" },
    },
  ],
  [
    "personal bests",
    personalBestsResponseSchema,
    personalBestsFixture({ bests: [personalBestFixture()] }),
  ],
  ["plan", planResponseSchema, planResponseFixture()],
  ["saved goal", saveGoalResponseSchema, { ok: true, goal: goalFixture(), plan: planFixture() }],
  [
    "goal conflict",
    saveGoalResponseSchema,
    {
      ok: false,
      conflict: { code: "race_too_far", raceDate: "2027-12-01", latestRaceDate: "2027-10-01" },
    },
  ],
  ["session", sessionDetailResponseSchema, sessionDetailFixture()],
  ["sign in", signInResponseSchema, signInFixture()],
  ["sign out", signOutResponseSchema, { success: true }],
  [
    "sync",
    syncResponseSchema,
    { lastSyncAt: "2026-10-05T08:00:00Z", activitiesWritten: 1, activitiesRemoved: 0 },
  ],
  [
    "problem",
    problemSchema,
    {
      type: "about:blank",
      title: "validation",
      status: 400,
      code: "validation",
      requestId: "r1",
      issues: [{ path: "a", message: "b" }],
    },
  ],
];

/** Better Auth owns these bodies, and the shared schemas pin only what the web app reads (contracts/auth.ts). */
const looseOnPurpose = new Set(["sign in", "sign out"]);

/** Every path in a JSON value that holds an object, the root as []. */
function objectPaths(value: unknown, path: PropertyKey[] = []): PropertyKey[][] {
  if (Array.isArray(value)) return value.flatMap((item, i) => objectPaths(item, [...path, i]));
  if (typeof value !== "object" || value === null) return [];
  return [
    path,
    ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key])),
  ];
}

function leafPaths(value: unknown, path: PropertyKey[] = []): PropertyKey[][] {
  if (Array.isArray(value)) return value.flatMap((item, i) => leafPaths(item, [...path, i]));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...path, key]));
  }
  return [path];
}

function at(root: unknown, path: PropertyKey[]): Json {
  return path.reduce<unknown>((node, key) => (node as Json)[key], root) as Json;
}

const copy = <T>(value: T): T => structuredClone(value);

const isSchema = (value: unknown): value is z.core.$ZodType =>
  typeof value === "object" && value !== null && "_zod" in value;

/** The schemas right inside one: fields, items, union members, record keys and values, wrapped types. */
function innerSchemas(schema: z.core.$ZodType): [where: string, inner: z.core.$ZodType][] {
  const def = schema._zod.def as unknown as Record<string, unknown>;
  return Object.entries(def).flatMap(([key, value]): [string, z.core.$ZodType][] => {
    if (key === "checks") return []; // refinements, which hold no part of the body
    if (key === "shape") return Object.entries(value as z.core.$ZodShape);
    if (key === "getter") return [[key, (value as () => z.core.$ZodType)()]];
    const values: unknown[] = Array.isArray(value) ? value : [value];
    return values.filter(isSchema).map((inner) => [key, inner]);
  });
}

/** Every schema in the table's schemas, each once, by the first path that reaches it. */
function everySchema(): Map<z.core.$ZodType, string> {
  const paths = new Map<z.core.$ZodType, string>();
  const visit = (schema: z.core.$ZodType, path: string) => {
    if (paths.has(schema)) return;
    paths.set(schema, path);
    for (const [where, inner] of innerSchemas(schema)) visit(inner, `${path}.${where}`);
  };
  for (const [name, schema] of bodies) visit(schema, name);
  return paths;
}

/** The fields of the object a union member reads, through optional, nullable, readonly or a pipe. */
function shapeOf(schema: z.core.$ZodType): z.core.$ZodShape | undefined {
  const def = schema._zod.def as {
    shape?: z.core.$ZodShape;
    innerType?: z.core.$ZodType;
    in?: z.core.$ZodType;
  };
  if (def.shape) return def.shape;
  const inner = def.innerType ?? def.in;
  return inner && shapeOf(inner);
}

describe.each(bodies)("parseResponse: %s", (name, schema, body) => {
  const onContract = schema.parse(copy(body));

  it("reads a key this version does not know, at every object in the body, as the body without it", () => {
    for (const path of objectPaths(body)) {
      const newer = copy(body);
      at(newer, path).addedLater = { nested: [1, 2] };
      if (!looseOnPurpose.has(name)) {
        expect(schema.safeParse(copy(newer)).success, `strict at ${path.join(".")}`).toBe(false);
      }
      const read = parseResponse(schema, newer);
      expect(read.success, `at ${path.join(".")}`).toBe(true);
      expect(read.data).toEqual(onContract);
    }
  });

  it("reads unknown keys at every object at once", () => {
    const newer = copy(body);
    for (const path of objectPaths(newer)) at(newer, path).addedLater = true;
    expect(parseResponse(schema, newer).data).toEqual(onContract);
  });

  it("still fails on a wrong type at every leaf the contract checks", () => {
    for (const path of leafPaths(body)) {
      const broken = copy(body);
      const parent = at(broken, path.slice(0, -1));
      const key = path[path.length - 1]!;
      const was = parent[key];
      parent[key] = typeof was === "string" ? 12345 : typeof was === "number" ? "12345" : { x: 1 };
      if (schema.safeParse(copy(broken)).success) continue;
      (broken as Json).addedLater = 1;
      expect(parseResponse(schema, broken).success, `at ${path.join(".")}`).toBe(false);
    }
  });

  it("still fails on a value this version does not know at every enum, literal or discriminator", () => {
    for (const path of leafPaths(body)) {
      const broken = copy(body);
      const parent = at(broken, path.slice(0, -1));
      const key = path[path.length - 1]!;
      if (typeof parent[key] !== "string") continue;
      parent[key] = "added_later";
      if (schema.safeParse(copy(broken)).success) continue; // free text
      expect(parseResponse(schema, broken).success, `at ${path.join(".")}`).toBe(false);
    }
  });
});

describe("parseResponse", () => {
  it("still fails on a missing key, even beside a key it drops", () => {
    const me = meFixture();
    const { claudePlanAvailable: _missing, ...olderSettings } = me.settings;
    const result = parseResponse(meResponseSchema, {
      ...me,
      settings: olderSettings,
      addedLater: true,
    });
    expect(result.success).toBe(false);
  });

  it("fails instead of guessing when an unknown key leaves a union two members", () => {
    const short = z.object({ x: z.string() }).strict();
    const long = z.object({ x: z.string(), y: z.number() }).strict();
    const union = z.union([short, long]);
    // On the contract, the strict schema decides: y is kept.
    expect(parseResponse(union, { x: "a", y: 1 }).data).toEqual({ x: "a", y: 1 });
    expect(parseResponse(union, { x: "a", y: 1, z: true }).success).toBe(false);
  });

  it("drops unknown keys inside a step and a repeat of a session's steps", () => {
    const session = sessionDetailFixture();
    const newer = copy(session) as unknown as Json;
    const steps = at(newer, ["session", "steps"]) as unknown as Json[];
    for (const item of steps) item.addedLater = 1;
    expect(parseResponse(sessionDetailResponseSchema, newer).data).toEqual(
      sessionDetailResponseSchema.parse(session),
    );
  });

  it("leaves the shared schema strict", () => {
    parseResponse(meResponseSchema, { ...meFixture(), addedLater: 1 });
    expect(meResponseSchema.safeParse({ ...meFixture(), addedLater: 1 }).success).toBe(false);
  });

  // When no member reads the body, a union without a discriminator reports the one member that failed on
  // unknown keys alone, and parseResponse drops those keys. So when the member a newer body was meant for
  // fails on a changed field, no other member may read that field as unknown: the members share no key and
  // each require one. A record keyed by an enum or literals reports a key it does not know as unknown too.
  it("never takes a field a newer API changed for an unknown key, in any union or record it reads", () => {
    const problems: string[] = [];
    for (const [schema, path] of everySchema()) {
      const def = (schema as z.core.$ZodTypes)._zod.def;
      if (def.type === "record" && def.keyType._zod.values) {
        problems.push(`${path}: a record keyed by an enum or literals`);
      }
      if (def.type !== "union" || "discriminator" in def) continue;
      const shapes = def.options.map(shapeOf).filter((shape) => shape !== undefined);
      if (shapes.length < 2) continue;
      const keys = new Set<string>();
      for (const shape of shapes) {
        if (Object.values(shape).every((field) => field._zod.optin !== undefined)) {
          problems.push(`${path}: a member with no required key`);
        }
        for (const key of Object.keys(shape)) {
          if (keys.has(key)) problems.push(`${path}: members share ${key}`);
          keys.add(key);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
