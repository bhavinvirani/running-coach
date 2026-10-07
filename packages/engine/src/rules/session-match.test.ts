import { sessionStatusSchema } from "@running-coach/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { addDays, daysBetween } from "../dates";
import {
  matchSessions,
  type MatchRun,
  type MatchSession,
  type MatchSessionsInput,
  type SessionMatch,
} from "./session-match";

const TODAY = "2026-10-07"; // a Wednesday

function session(id: string, date: string, overrides: Partial<MatchSession> = {}): MatchSession {
  return { id, date, status: "planned", distanceM: 8000, activityId: null, ...overrides };
}

function run(id: string, date: string, distanceM = 8000): MatchRun {
  return { id, date, distanceM };
}

function match(
  sessions: MatchSession[],
  runs: MatchRun[],
  { pausedFrom = null, today = TODAY }: { pausedFrom?: string | null; today?: string } = {},
): SessionMatch[] {
  return matchSessions({ today, sessions, runs, pausedFrom });
}

/** The sessions with the matches written back, as the API stores them. */
function applied(sessions: readonly MatchSession[], matches: readonly SessionMatch[]) {
  const byId = new Map(matches.map((m) => [m.id, m]));
  return sessions.map((s) => {
    const m = byId.get(s.id);
    return m === undefined ? s : { ...s, status: m.status, activityId: m.activityId };
  });
}

describe("session match", () => {
  it("marks a session done with the run on its local date", () => {
    expect(match([session("s1", "2026-10-06")], [run("r1", "2026-10-06")])).toEqual([
      { id: "s1", status: "done", activityId: "r1" },
    ]);
  });

  it("marks today's session done once today's run syncs", () => {
    expect(match([session("s1", TODAY)], [run("r1", TODAY)])).toEqual([
      { id: "s1", status: "done", activityId: "r1" },
    ]);
  });

  it("missed session: a session from yesterday with no run becomes missed and keeps its date", () => {
    const out = match([session("s1", addDays(TODAY, -1))], []);
    expect(out).toEqual([{ id: "s1", status: "missed", activityId: null }]);
    expect(Object.keys(out[0]!)).not.toContain("date");
  });

  it("leaves today's session with no run planned: the day is not over", () => {
    expect(match([session("s1", TODAY)], [])).toEqual([]);
  });

  it("time zones and DST: pairs on the run's local date the API passes, not its UTC day", () => {
    // A 23:30 run in New York the night DST ends is already 2026-11-02 in UTC; its local date is the 1st.
    expect(
      match([session("s1", "2026-11-01"), session("s2", "2026-11-02")], [run("r1", "2026-11-01")], {
        today: "2026-11-03",
      }),
    ).toEqual([
      { id: "s1", status: "done", activityId: "r1" },
      { id: "s2", status: "missed", activityId: null },
    ]);
  });

  it("deleted activity: a done session whose run Garmin no longer lists turns missed", () => {
    expect(match([session("s1", "2026-10-05", { status: "done", activityId: "r1" })], [])).toEqual([
      { id: "s1", status: "missed", activityId: null },
    ]);
  });

  it("deleted activity today: a done session of today goes back to planned", () => {
    expect(match([session("s1", TODAY, { status: "done", activityId: "r1" })], [])).toEqual([
      { id: "s1", status: "planned", activityId: null },
    ]);
  });

  it("edited activity: a run moved to another day on Garmin moves the done mark with it", () => {
    expect(
      match(
        [
          session("s1", "2026-10-05", { status: "done", activityId: "r1" }),
          session("s2", "2026-10-06"),
        ],
        [run("r1", "2026-10-06")],
      ),
    ).toEqual([
      { id: "s1", status: "missed", activityId: null },
      { id: "s2", status: "done", activityId: "r1" },
    ]);
  });

  it("edited activity: a done session takes the run Garmin now lists on its date", () => {
    expect(
      match(
        [session("s1", "2026-10-05", { status: "done", activityId: "r1" })],
        [run("r2", "2026-10-05")],
      ),
    ).toEqual([{ id: "s1", status: "done", activityId: "r2" }]);
  });

  it("duplicate activities: two runs on one day complete one session, the longest run taking it", () => {
    expect(
      match(
        [session("s1", "2026-10-06")],
        [run("r1", "2026-10-06", 5000), run("r2", "2026-10-06", 9000)],
      ),
    ).toEqual([{ id: "s1", status: "done", activityId: "r2" }]);
  });

  it("pairs a day's sessions with its runs longest first", () => {
    expect(
      match(
        [
          session("a", "2026-10-06", { distanceM: 6000 }),
          session("b", "2026-10-06", { distanceM: 10_000 }),
        ],
        [run("x", "2026-10-06", 7000), run("y", "2026-10-06", 12_000)],
      ),
    ).toEqual([
      { id: "a", status: "done", activityId: "x" },
      { id: "b", status: "done", activityId: "y" },
    ]);
  });

  it("breaks equal distances by id, sessions and runs alike, in any input order", () => {
    const expected = [
      { id: "c", status: "done", activityId: "p" },
      { id: "d", status: "done", activityId: "q" },
    ];
    const day = "2026-10-06";
    const forward = match([session("c", day), session("d", day)], [run("p", day), run("q", day)]);
    const reverse = match([session("d", day), session("c", day)], [run("q", day), run("p", day)]);
    expect(forward).toEqual(expected);
    expect(reverse).toEqual([expected[1], expected[0]]);
  });

  it("uses a run at most once: of two sessions on its day the longer is done, the other missed", () => {
    expect(
      match(
        [
          session("easy", "2026-10-06", { distanceM: 6000 }),
          session("long", "2026-10-06", { distanceM: 16_000 }),
        ],
        [run("r1", "2026-10-06", 5000)],
      ),
    ).toEqual([
      { id: "easy", status: "missed", activityId: null },
      { id: "long", status: "done", activityId: "r1" },
    ]);
  });

  it("indoor and manual runs: a manual entry of 0 m completes the session like any run", () => {
    expect(match([session("s1", "2026-10-06")], [run("treadmill", "2026-10-06", 0)])).toEqual([
      { id: "s1", status: "done", activityId: "treadmill" },
    ]);
  });

  it("moved session: done by a run on its new date, missed without one", () => {
    expect(
      match(
        [
          session("s1", "2026-10-05", { status: "moved" }),
          session("s2", "2026-10-06", { status: "moved" }),
        ],
        [run("r1", "2026-10-05")],
      ),
    ).toEqual([
      { id: "s1", status: "done", activityId: "r1" },
      { id: "s2", status: "missed", activityId: null },
    ]);
  });

  it("never touches a skipped session; the run on its day completes the other one", () => {
    expect(
      match(
        [
          session("skipped", "2026-10-06", { status: "skipped", distanceM: 12_000 }),
          session("s2", "2026-10-06", { distanceM: 5000 }),
        ],
        [run("r1", "2026-10-06")],
      ),
    ).toEqual([{ id: "s2", status: "done", activityId: "r1" }]);
  });

  it("never touches a session after today", () => {
    const tomorrow = addDays(TODAY, 1);
    expect(match([session("s1", tomorrow)], [run("r1", tomorrow)])).toEqual([]);
  });

  it("illness or injury pause: sessions from the pause start stay planned, earlier ones turn missed", () => {
    expect(
      match(
        [
          session("before", "2026-10-03"),
          session("first", "2026-10-04"),
          session("was-missed", "2026-10-05", { status: "missed" }),
          session("run-deleted", "2026-10-06", { status: "done", activityId: "gone" }),
        ],
        [],
        { pausedFrom: "2026-10-04" },
      ),
    ).toEqual([
      { id: "before", status: "missed", activityId: null },
      { id: "was-missed", status: "planned", activityId: null },
      { id: "run-deleted", status: "planned", activityId: null },
    ]);
  });

  it("illness or injury pause: a run on a paused day still completes its session", () => {
    expect(
      match([session("s1", "2026-10-05")], [run("r1", "2026-10-05")], { pausedFrom: "2026-10-04" }),
    ).toEqual([{ id: "s1", status: "done", activityId: "r1" }]);
  });

  it("returns only the sessions that change, in input order", () => {
    expect(
      match(
        [
          session("s3", "2026-10-06"),
          session("same", "2026-10-05", { status: "done", activityId: "r1" }),
          session("s1", "2026-10-04"),
        ],
        [run("r1", "2026-10-05")],
      ),
    ).toEqual([
      { id: "s3", status: "missed", activityId: null },
      { id: "s1", status: "missed", activityId: null },
    ]);
  });

  // --- properties over generated sessions and runs -----------------------------------------------

  const dayArb = fc.integer({ min: -14, max: 3 }).map((offset) => addDays(TODAY, offset));
  const inputArb: fc.Arbitrary<MatchSessionsInput> = fc
    .record({
      sessions: fc.array(
        fc.record({
          date: dayArb,
          status: fc.constantFrom(...sessionStatusSchema.options),
          distanceM: fc.nat({ max: 30_000 }),
          runIndex: fc.nat({ max: 20 }),
        }),
        { maxLength: 25 },
      ),
      runs: fc.array(fc.record({ date: dayArb, distanceM: fc.nat({ max: 30_000 }) }), {
        maxLength: 20,
      }),
      pausedFrom: fc.option(dayArb),
    })
    .map((drawn) => ({
      today: TODAY,
      // A done session holds a run id, maybe one Garmin no longer lists; the others hold none.
      sessions: drawn.sessions.map((s, k) => ({
        id: `s${k}`,
        date: s.date,
        status: s.status,
        distanceM: s.distanceM,
        activityId: s.status === "done" ? `r${s.runIndex}` : null,
      })),
      runs: drawn.runs.map((r, k) => ({ id: `r${k}`, ...r })),
      pausedFrom: drawn.pausedFrom,
    }));

  it("is idempotent: matching the matched sessions again changes nothing", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const once = applied(input.sessions, matchSessions(input));
        expect(matchSessions({ ...input, sessions: once })).toEqual([]);
      }),
    );
  });

  it("never returns a skipped or future session", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const byId = new Map(input.sessions.map((s) => [s.id, s]));
        for (const m of matchSessions(input)) {
          const s = byId.get(m.id)!;
          expect(s.status).not.toBe("skipped");
          expect(daysBetween(s.date, input.today)).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("uses each run at most once, on its own date", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const runs = new Map(input.runs.map((r) => [r.id, r]));
        const held = applied(input.sessions, matchSessions(input)).filter(
          (s) => s.status !== "skipped" && daysBetween(s.date, input.today) >= 0,
        );
        const ids = held.flatMap((s) => (s.activityId === null ? [] : [s.activityId]));
        expect(new Set(ids).size).toBe(ids.length);
        for (const s of held.filter((h) => h.status === "done")) {
          expect(runs.get(s.activityId!)?.date).toBe(s.date);
        }
      }),
    );
  });

  it("ends every session before today outside the pause done or missed, never moving a date", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const after = applied(input.sessions, matchSessions(input));
        after.forEach((s, k) => {
          expect(s.date).toBe(input.sessions[k]!.date);
          const inPause = input.pausedFrom !== null && daysBetween(input.pausedFrom, s.date) >= 0;
          if (s.status !== "skipped" && daysBetween(s.date, input.today) > 0 && !inPause) {
            expect(["done", "missed"]).toContain(s.status);
          }
        });
      }),
    );
  });
});
