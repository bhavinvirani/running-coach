import { describe, expect, it } from "vitest";
import {
  claudeKeyRequestSchema,
  insightFeedbackRequestSchema,
  insightResponseSchema,
  runInsightSchema,
} from "./coach";

const card = {
  headline: "10.0 km in 52:00 at 5:12 /km.",
  whatHappened: "A steady 10.0 km at 5:12 /km with an average heart rate of 148 bpm.",
  whatItMeans: "Heart rate stayed in the easy range for the whole run.",
  nextStep: "Run the planned 6.0 km easy on Thursday.",
  caution: "none",
};

describe("runInsightSchema", () => {
  it("accepts a card inside every limit", () => {
    expect(runInsightSchema.safeParse(card).success).toBe(true);
  });

  it("rejects a headline over 120 characters", () => {
    expect(runInsightSchema.safeParse({ ...card, headline: "x".repeat(121) }).success).toBe(false);
  });

  it("rejects extra fields", () => {
    expect(runInsightSchema.safeParse({ ...card, mood: "good" }).success).toBe(false);
  });
});

describe("claudeKeyRequestSchema", () => {
  it("trims the key", () => {
    expect(claudeKeyRequestSchema.parse({ key: "  sk-ant-x  " })).toEqual({ key: "sk-ant-x" });
  });

  it("rejects a blank key", () => {
    expect(claudeKeyRequestSchema.safeParse({ key: "   " }).success).toBe(false);
  });

  it("rejects a key with a line break, space or NUL inside", () => {
    for (const key of ["sk-ant-a\nb", "sk-ant-a b", "sk-ant-a\u0000b"]) {
      expect(claudeKeyRequestSchema.safeParse({ key }).success).toBe(false);
    }
  });
});

describe("insightResponseSchema", () => {
  it("accepts a ready card and the states without one", () => {
    const ready = {
      state: "ready",
      insight: {
        id: "0b9a4c1e-6f6b-4d55-9a51-3f8f0f2f1a10",
        content: card,
        fallbackReason: null,
        feedback: "up",
        createdAt: "2026-10-03T07:00:00.000Z",
      },
    };
    expect(insightResponseSchema.safeParse(ready).success).toBe(true);
    for (const state of ["pending", "retrying", "none", "no_key"]) {
      expect(insightResponseSchema.safeParse({ state }).success).toBe(true);
    }
  });

  it("accepts a retrying state waiting for the plan's reset", () => {
    const held = { state: "retrying", resumesAt: "2026-10-04T14:00:00.000Z" };
    expect(insightResponseSchema.safeParse(held).success).toBe(true);
  });

  it("rejects a ready state without its card", () => {
    expect(insightResponseSchema.safeParse({ state: "ready" }).success).toBe(false);
  });
});

describe("insightFeedbackRequestSchema", () => {
  it("accepts up, down and null to clear", () => {
    for (const feedback of ["up", "down", null]) {
      expect(insightFeedbackRequestSchema.safeParse({ feedback }).success).toBe(true);
    }
  });

  it("rejects anything else", () => {
    expect(insightFeedbackRequestSchema.safeParse({ feedback: "meh" }).success).toBe(false);
  });
});
