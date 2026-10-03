import { describe, expect, inject, it } from "vitest";
import { checkClaudeKey } from "../../src/coach/client";
import { claudeKey } from "../seed";

// The free key check (GET /v1/models) against the fake Claude: the key names the fixture it answers as.

async function modelRequests(key: string): Promise<{ query: string }[]> {
  const url = `${inject("claudeBaseUrl")}/__requests/${encodeURIComponent(key)}/models`;
  return (await (await fetch(url)).json()) as { query: string }[];
}

describe("checkClaudeKey", () => {
  it("accepts a key Claude lists models for, with one free request", async () => {
    const key = claudeKey("valid");

    expect(await checkClaudeKey(key)).toBe("ok");
    expect(await modelRequests(key)).toEqual([expect.objectContaining({ query: "?limit=1" })]);
  });

  it("says key_invalid for an invalid or expired key (401), without retrying", async () => {
    const key = claudeKey("key-invalid");

    expect(await checkClaudeKey(key)).toBe("key_invalid");
    expect(await modelRequests(key)).toHaveLength(1);
  });

  it("says key_invalid for a key without access (403)", async () => {
    expect(await checkClaudeKey(claudeKey("permission-denied"))).toBe("key_invalid");
  });

  it("says key_invalid for a key Claude does not know", async () => {
    expect(await checkClaudeKey("sk-ant-api03-not-a-real-key")).toBe("key_invalid");
  });

  it.each([
    ["Claude is overloaded (529)", "unavailable"],
    ["Claude rate-limits the key (429)", "rate-limited"],
  ])("says unavailable when %s, without retrying", async (_, fixture) => {
    const key = claudeKey(fixture);

    expect(await checkClaudeKey(key)).toBe("unavailable");
    expect(await modelRequests(key)).toHaveLength(1);
  });

  it("says timeout when Claude answers slower than the check waits", async () => {
    expect(await checkClaudeKey(claudeKey("timeout"))).toBe("timeout");
  });
});
