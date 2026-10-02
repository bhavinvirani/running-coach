import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("keeps a type-size token and a color token together", () => {
    expect(cn("text-figure", "text-ink")).toBe("text-figure text-ink");
    expect(cn("text-caption text-ink-2")).toBe("text-caption text-ink-2");
    expect(cn("text-figure-lg", "text-accent")).toBe("text-figure-lg text-accent");
  });

  it("lets a later type size replace an earlier one", () => {
    expect(cn("text-body", "text-caption")).toBe("text-caption");
    expect(cn("text-figure", "text-figure-lg")).toBe("text-figure-lg");
  });

  it("lets a later color replace an earlier one", () => {
    expect(cn("text-ink", "text-ink-2")).toBe("text-ink-2");
    expect(cn("bg-surface-1", "bg-surface-2")).toBe("bg-surface-2");
  });

  it("drops falsy values", () => {
    expect(cn("p-4", false, null, undefined, "text-body")).toBe("p-4 text-body");
  });
});
