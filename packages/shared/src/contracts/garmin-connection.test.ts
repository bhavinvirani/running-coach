import { describe, expect, it } from "vitest";
import {
  connectGarminRequestSchema,
  disconnectGarminQuerySchema,
  finishGarminLoginRequestSchema,
  startGarminLoginRequestSchema,
  startGarminLoginResponseSchema,
} from "./garmin-connection";

describe("connectGarminRequestSchema", () => {
  it("rejects a user id so a client cannot connect another account", () => {
    const parsed = connectGarminRequestSchema.safeParse({ tokenBundle: "{}", userId: "x" });
    expect(parsed.success).toBe(false);
  });
});

describe("startGarminLoginRequestSchema", () => {
  it("takes an email and a password", () => {
    const login = { email: "runner@example.com", password: "secret" };
    expect(startGarminLoginRequestSchema.parse(login)).toEqual(login);
  });

  it("rejects an empty password and an address that is not an email", () => {
    expect(
      startGarminLoginRequestSchema.safeParse({ email: "runner@example.com", password: "" })
        .success,
    ).toBe(false);
    expect(
      startGarminLoginRequestSchema.safeParse({ email: "runner", password: "secret" }).success,
    ).toBe(false);
  });
});

describe("startGarminLoginResponseSchema", () => {
  it("answers that a code is needed, or the connected account", () => {
    expect(startGarminLoginResponseSchema.parse({ status: "code_needed" })).toEqual({
      status: "code_needed",
    });
    expect(
      startGarminLoginResponseSchema.parse({ status: "connected", displayName: null }),
    ).toEqual({ status: "connected", displayName: null });
  });

  it("never carries a token bundle to the browser", () => {
    const parsed = startGarminLoginResponseSchema.safeParse({
      status: "connected",
      displayName: null,
      tokenBundle: "{}",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("finishGarminLoginRequestSchema", () => {
  it("takes the code as digits only", () => {
    expect(finishGarminLoginRequestSchema.safeParse({ mfaCode: "123456" }).success).toBe(true);
    for (const mfaCode of ["123 456", "12345a", "", "123"]) {
      expect(finishGarminLoginRequestSchema.safeParse({ mfaCode }).success).toBe(false);
    }
  });
});

describe("disconnectGarminQuerySchema", () => {
  it("asks whether to remove the app's workouts or keep them", () => {
    expect(disconnectGarminQuerySchema.parse({ workouts: "remove" })).toEqual({
      workouts: "remove",
    });
    expect(disconnectGarminQuerySchema.safeParse({}).success).toBe(false);
    expect(disconnectGarminQuerySchema.safeParse({ workouts: "all" }).success).toBe(false);
  });
});
