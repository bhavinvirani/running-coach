import { describe, expect, it } from "vitest";
import {
  latestReviewResponseSchema,
  REVIEW_CHANGES_MAX,
  weeklyReviewCardSchema,
  weeklyReviewOutputSchema,
  weeklyReviewSchema,
} from "./weekly-review";

const card = {
  headline: "3 of 4 sessions and 28.4 km of 32.0 km planned.",
  whatHappened: "You ran Tuesday, Thursday and Sunday. Saturday's 6.0 km easy was missed.",
  whatItMeans: "Volume held at 89% of the plan, so the build stays on track.",
  nextWeek: "Next week holds 4 runs and 34.0 km, with a 14.0 km long run on Sunday.",
};

const change = {
  session: "s2",
  kind: "scale",
  factor: 0.8,
  note: "Shorten Wednesday's tempo while the missed run is behind you.",
} as const;

const session = {
  id: "5b6a2c40-2f0e-4c3a-9b1e-7d2a1f0c9e11",
  date: "2026-10-13",
  type: "tempo",
  title: null,
  status: "planned",
  source: "plan",
  target: { distanceM: 8000, durationS: 2700, zone: "threshold" },
} as const;

const stored = {
  id: "8d3f1b2a-6c4e-4f5a-8b9c-0d1e2f3a4b5c",
  weekStart: "2026-10-05",
  content: card,
  summary: {
    runs: 3,
    distanceM: 28400,
    durationS: 9600,
    sessionsPlanned: 4,
    sessionsDone: 3,
    plannedDistanceM: 32000,
    paused: false,
  },
  fallbackReason: null,
  feedback: null,
  changes: [
    {
      sessionId: session.id,
      date: session.date,
      kind: "scale",
      clamped: false,
      before: { type: "tempo", title: null, status: "planned", target: session.target },
      after: {
        type: "tempo",
        title: null,
        status: "planned",
        target: { distanceM: 6400, durationS: 2160, zone: "threshold" },
      },
      note: change.note,
    },
  ],
  comingWeek: [session],
  createdAt: "2026-10-12T03:31:00.000Z",
};

describe("weeklyReviewSchema", () => {
  it("accepts a card inside every limit", () => {
    expect(weeklyReviewSchema.safeParse(card).success).toBe(true);
  });

  it("rejects a headline over 120 characters", () => {
    expect(weeklyReviewSchema.safeParse({ ...card, headline: "x".repeat(121) }).success).toBe(
      false,
    );
  });

  it("rejects extra fields", () => {
    expect(weeklyReviewSchema.safeParse({ ...card, caution: "none" }).success).toBe(false);
  });
});

describe("weeklyReviewOutputSchema", () => {
  it("accepts a card with no changes", () => {
    expect(weeklyReviewOutputSchema.safeParse({ ...card, changes: [] }).success).toBe(true);
  });

  it(`accepts up to ${REVIEW_CHANGES_MAX} changes and rejects more`, () => {
    const changes = Array.from({ length: REVIEW_CHANGES_MAX }, (_, k) => ({
      ...change,
      session: `s${k + 1}`,
    }));
    expect(weeklyReviewOutputSchema.safeParse({ ...card, changes }).success).toBe(true);
    expect(
      weeklyReviewOutputSchema.safeParse({ ...card, changes: [...changes, change] }).success,
    ).toBe(false);
  });

  it("rejects a change without its note", () => {
    const { note: _note, ...noNote } = change;
    expect(weeklyReviewOutputSchema.safeParse({ ...card, changes: [noNote] }).success).toBe(false);
  });

  it("rejects a change kind outside scale, easy and rest", () => {
    expect(
      weeklyReviewOutputSchema.safeParse({ ...card, changes: [{ ...change, kind: "none" }] })
        .success,
    ).toBe(false);
  });
});

describe("weeklyReviewCardSchema", () => {
  it("accepts a stored review with a change and the coming week", () => {
    expect(weeklyReviewCardSchema.safeParse(stored).success).toBe(true);
  });

  it("rejects a change without its note", () => {
    const [first] = stored.changes;
    const { note: _note, ...noNote } = first!;
    expect(weeklyReviewCardSchema.safeParse({ ...stored, changes: [noNote] }).success).toBe(false);
  });
});

describe("latestReviewResponseSchema", () => {
  it("reads each state", () => {
    expect(latestReviewResponseSchema.parse({ state: "ready", review: stored }).state).toBe(
      "ready",
    );
    expect(latestReviewResponseSchema.parse({ state: "pending" }).state).toBe("pending");
    expect(
      latestReviewResponseSchema.parse({
        state: "retrying",
        resumesAt: "2026-10-12T08:00:00.000Z",
      }).state,
    ).toBe("retrying");
    expect(latestReviewResponseSchema.parse({ state: "none" }).state).toBe("none");
  });
});
